"""The draft-time ticket (ENFORCER_TICKET): a speculative enforcer run ranks a settled draft before Enter and
leaves a ticket; the hook for exactly that sent text serves its Jev verdict instead of asking Jev again.

Offline: `_jev_route` is stubbed (no network, no Jev, no jevd), as are embed and retrieval. The enforcer runs
in-process on a stdin fake through `_run()`, the same entry the script uses, so the last-line output of a
speculative run is the real one. A speculative run and the hook that follows it are separate modules (one
process = one turn), sharing one temp ledger and one temp ticket directory.
"""
import importlib.util
import io
import itertools
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / "hooks" / "scripts"
ENFORCER = HOOKS / "enforcer.py"
sys.path.insert(0, str(HOOKS))
import offer_ticket  # noqa: E402

SID = "sess-1"
SENT = "add dark mode with the ui kit to the settings page"
INTENT = "Add a dark mode toggle to the settings page using the ui kit."
RANKED = SENT + "\n\n" + INTENT
RESULT = ("offer", [("ak-git", "Git operations.", 0.8), ("update-config", "Configure the harness.", 0.1)], 0.9, [])
FULL = {"stage": "full", "ms": 1234, "wide_ms": 800, "conf": 0.8, "fit": 0.9, "via": "jevd", "n": 4,
        "ctx": True, "lead": "ak-git", "model": "jev-1.13.0", "tier": 0, "floor": 0.3, "bench": "jevd"}
WIDE = dict(FULL, stage="wide")
_ids = itertools.count()


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    """Everything a run touches lives under tmp_path; no Jev routing from this machine leaks in."""
    monkeypatch.setattr(offer_ticket, "TICKET_DIR", tmp_path / "tickets")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    monkeypatch.setenv("SKILL_CONCIERGE_LOG", str(tmp_path / "logs"))
    for k in ("ENFORCER_LEDGER", "ENFORCER_TICKET", "ENFORCER_JEV_FITS_FLOOR", "ENFORCER_JEV_BUDGET", "JEVD_URL"):
        monkeypatch.delenv(k, raising=False)
    transcript(tmp_path, "Staged three files. Commit them now?")


def transcript(tmp_path, text, sid=SID):
    """Append an assistant record to the session transcript at the place `find_transcript` looks."""
    path = tmp_path / "claude" / "projects" / "proj" / f"{sid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}) + "\n")
    return path


CATALOG = [("ak-git", "Git operations."), ("update-config", "Configure the harness."),
           ("tk-research", "Research a topic into a briefing.")]


def boot(tmp_path, monkeypatch, calls, result=RESULT, event=FULL, catalog=None, **env):
    """A fresh enforcer module with Jev, embed and retrieval replaced. Every `_jev_route` call lands in `calls`."""
    old = dict(os.environ)
    os.environ.update(env)
    try:
        spec = importlib.util.spec_from_file_location(f"enforcer_ticket_{next(_ids)}", ENFORCER)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        os.environ.clear()
        os.environ.update(old)

    def route(prompt, transcript_path, sink=None, deadline=None):
        calls.append({"prompt": prompt, "deadline": deadline, "at": time.time()})
        return {"result": result, "event": dict(event) if event else event}
    monkeypatch.setattr(mod, "_jev_route", route)
    monkeypatch.setattr(mod, "_jev_catalog", lambda: list(CATALOG if catalog is None else catalog))
    monkeypatch.setattr(mod, "_embed", lambda text: [0.0] * 768)
    monkeypatch.setattr(mod, "_retrieve", lambda v: [("tk-research", "Research a topic into a briefing.", 0.62),
                                                     ("ak-git", "Git operations.", 0.55)])
    monkeypatch.setattr(mod, "_retrieve_external", lambda v, top=0.0: [])
    monkeypatch.setattr(mod, "_retrieve_foreign", lambda v, top, names: [])
    monkeypatch.setattr(mod, "_intent_conversational", lambda v: False)
    return mod


def feed(monkeypatch, payload):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    return out


def speculate(mod, monkeypatch, prompt=SENT, intent=INTENT, n=1, sid=SID):
    """One speculative run -> (stdout lines, the `skillConciergeSpeculation` object, additionalContext)."""
    out = feed(monkeypatch, {"prompt": prompt, "session_id": sid, "speculate": {"intent": intent, "n": n}})
    assert mod._run() == 0
    lines = out.getvalue().splitlines()
    last = json.loads(lines[-1])
    return lines, last["skillConciergeSpeculation"], last.get("hookSpecificOutput", {}).get("additionalContext", "")


def hook(mod, monkeypatch, tmp_path, prompt=SENT, sid=SID):
    """The UserPromptSubmit hook for one prompt -> additionalContext ('' when it injected nothing)."""
    out = feed(monkeypatch, {"prompt": prompt, "session_id": sid,
                             "transcript_path": str(tmp_path / "claude" / "projects" / "proj" / f"{sid}.jsonl")})
    assert mod._run() == 0
    return json.loads(out.getvalue())["hookSpecificOutput"]["additionalContext"] if out.getvalue() else ""


def rows(tmp_path, ev=None):
    path = tmp_path / "logs" / "skill-invocation-ledger.log"
    got = [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []
    return [r for r in got if ev is None or r.get("ev") == ev]


def bullets(context):
    """The main menu's rows, in order: the bullets under the header, before the note, pull-in or any annex."""
    head = re.split(r"\nShares are RELATIVE|\nReads as|\nOn the owner's list|\nExternal catalog|\nOther-harness", context)[0]
    return re.findall(r"^  • ([A-Za-z0-9_:.-]+)", head, re.M)


def ticket_file(sid=SID):
    return offer_ticket.TICKET_DIR / f"{sid}.ticket.json"


def edit_ticket(**fields):
    d = json.loads(ticket_file().read_text(encoding="utf-8"))
    d.update(fields)
    ticket_file().write_text(json.dumps(d), encoding="utf-8")


# ── B1 ─ a speculative run ───────────────────────────────────────────────────────────────────────────────────

def test_a_speculative_run_writes_no_offer_row_and_previews_the_menu_it_built(tmp_path, monkeypatch):
    monkeypatch.setenv("ENFORCER_LEDGER", "1")    # forced in code: the environment cannot turn an offer row on
    calls = []
    lines, report, context = speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    assert len(lines) == 1                         # one JSON object: the menu and the report together
    assert rows(tmp_path, "offer") == []
    assert report["v"] == 1 and report["ticket"] == "ranked"
    assert report["preview"] == {"kind": "menu", "skills": ["ak-git", "update-config"], "whole_shelf": True}
    assert bullets(context) == ["ak-git", "update-config"] == report["preview"]["skills"]
    assert [c["prompt"] for c in calls] == [RANKED]    # Jev ranked the sent text plus the intent line


def test_a_speculative_run_that_ends_in_a_lane_still_answers(tmp_path, monkeypatch):
    calls = []
    for prompt, kind in (("ok thanks", "silent"), ("", "silent"), ("/clear the screen please now", "silent"),
                         ("which skills should I use to build the landing page for the new product", "consult")):
        lines, report, _ = speculate(boot(tmp_path, monkeypatch, calls), monkeypatch, prompt=prompt)
        assert report == {"v": 1, "ticket": "none", "preview": {"kind": kind, "skills": [], "whole_shelf": False}}, prompt
    assert calls == [] and not ticket_file().exists()


def test_a_jev_skip_previews_as_no_skill_and_the_hook_serves_the_same_skip(tmp_path, monkeypatch):
    skip = ("skip", [], 0.1, [])
    calls = []
    _, report, _ = speculate(boot(tmp_path, monkeypatch, calls, result=skip), monkeypatch)
    assert report["ticket"] == "ranked" and report["preview"]["kind"] == "no-skill"
    assert hook(boot(tmp_path, monkeypatch, calls, result=skip), monkeypatch, tmp_path).startswith("SKILL-CHECK:")
    assert len(calls) == 1
    [row] = rows(tmp_path, "offer")
    assert (row["band"], row["jev"]["src"], row["spec"]["st"]) == ("jev_skip", "ticket", "ready")


# ── the speculate ledger row ─────────────────────────────────────────────────────────────────────────────────

def test_each_speculative_run_appends_exactly_one_speculate_row(tmp_path, monkeypatch):
    speculate(boot(tmp_path, monkeypatch, []), monkeypatch, n=2)
    [row] = rows(tmp_path, "speculate")
    assert (row["sid"], row["n"], row["intent"], row["ticket"], row["jev_stage"], row["band"]) == \
        (SID, 2, True, "ranked", "full", "offer")
    assert isinstance(row["ms"], int) and row["ms"] >= 0
    assert len(rows(tmp_path)) == 1                   # and nothing else: no offer row

    speculate(boot(tmp_path, monkeypatch, []), monkeypatch, intent="", n=3)
    assert [r["n"] for r in rows(tmp_path, "speculate")] == [2, 3]
    assert rows(tmp_path, "speculate")[1]["intent"] is False


def test_ledger_off_writes_no_speculate_row_either(tmp_path, monkeypatch):
    monkeypatch.setenv("ENFORCER_LEDGER", "0")
    _, report, _ = speculate(boot(tmp_path, monkeypatch, []), monkeypatch)
    assert report["ticket"] == "ranked" and rows(tmp_path) == []


# ── B2 ─ one menu ────────────────────────────────────────────────────────────────────────────────────────────

def test_the_hook_serves_the_speculative_runs_ranking_without_calling_jev(tmp_path, monkeypatch):
    calls = []
    _, report, spec_context = speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    assert len(calls) == 1
    context = hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    assert len(calls) == 1                            # the hook asked Jev 0 times
    assert context == spec_context                    # byte-equal: the preview is the menu
    assert bullets(context) == report["preview"]["skills"]
    [row] = rows(tmp_path, "offer")
    assert (row["via"], row["q"], row["rq"]) == ("enhancer", SENT, RANKED[:120])
    assert row["spec"]["st"] == "ready" and row["spec"]["n"] == 1 and row["spec"]["intent"] is True
    assert 0 <= row["spec"]["wait_ms"] < 500 and row["spec"]["age_ms"] >= 0
    assert row["jev"]["src"] == "ticket" and row["jev"]["stage"] == "full" and row["jev"]["lead"] == "ak-git"
    assert isinstance(row["jev"]["age_ms"], int) and row["jev"]["age_ms"] >= 0


def test_the_served_offer_row_pairs_with_the_turn_row(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    subprocess.run([sys.executable, str(HOOKS / "ledger.py")], capture_output=True, text=True, timeout=60,
                   input=json.dumps({"hook_event_name": "UserPromptSubmit", "session_id": SID, "prompt": SENT}),
                   env={**os.environ, "SKILL_CONCIERGE_LOG": str(tmp_path / "logs")}, check=True)
    spec = importlib.util.spec_from_file_location("analyze_for_ticket_test", ROOT / "scripts" / "analyze.py")
    analyze = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyze)
    [turn] = [w for w in analyze._segment_windows(sorted(rows(tmp_path), key=lambda e: e["t"])) if w["kind"] == "turn"]
    assert turn["q"] == SENT and turn["offered"] == ["ak-git", "update-config"] and turn["band"] == "offer"


# ── B3 ─ a context or settings change voids the ticket ───────────────────────────────────────────────────────

def test_a_turn_in_between_makes_the_ticket_stale_and_the_hook_ranks_live_once(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    transcript(tmp_path, "Done. The commit is made and pushed.")
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    assert len(calls) == 2                            # the speculative run's, then exactly one live call
    [row] = rows(tmp_path, "offer")
    assert row["spec"]["st"] == "stale" and row["via"] == "enhancer" and "src" not in row["jev"]
    assert calls[1]["prompt"] == RANKED               # the intent line still feeds the live ranking


def test_a_changed_ranking_setting_makes_the_ticket_env_and_the_hook_ranks_live_once(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    monkeypatch.setenv("ENFORCER_JEV_FITS_FLOOR", "0.55")
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    assert len(calls) == 2
    assert rows(tmp_path, "offer")[0]["spec"]["st"] == "env"


# ── a served verdict must still pass today's live filters ────────────────────────────────────────────────────

LIVE = ("offer", [("update-config", "Configure the harness.", 0.7), ("tk-research", "Research a topic.", 0.2)], 0.8, [])


def test_a_skill_blocked_after_the_ticket_settled_is_never_offered(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)          # settled with ak-git on top
    mod = boot(tmp_path, monkeypatch, calls, result=LIVE)
    mod.BLOCKLIST = frozenset({"ak-git"})                               # blocked after the ticket settled
    context = hook(mod, monkeypatch, tmp_path)
    assert len(calls) == 2                                              # the hook ranked live, once
    assert "ak-git" not in context and "update-config" in context
    [row] = rows(tmp_path, "offer")
    assert row["spec"]["st"] == "stale" and "src" not in row["jev"]


def test_a_kept_off_or_uninstalled_skill_in_a_served_verdict_drops_it_to_a_live_route(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    mod = boot(tmp_path, monkeypatch, calls, result=LIVE)
    mod.KEEPOFF = frozenset({"update-config"})
    hook(mod, monkeypatch, tmp_path)
    assert len(calls) == 2 and rows(tmp_path, "offer")[0]["spec"]["st"] == "stale"

    calls.clear()
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    # a reindex dropped the skill, or its plugin was disabled: it is no longer in the live catalogue
    hook(boot(tmp_path, monkeypatch, calls, result=LIVE, catalog=[CATALOG[1], CATALOG[2]]), monkeypatch, tmp_path)
    assert len(calls) == 2 and rows(tmp_path, "offer")[1]["spec"]["st"] == "stale"


def test_a_pulled_in_row_that_is_no_longer_allowed_also_drops_the_verdict(tmp_path, monkeypatch):
    pulled = ("offer", RESULT[1], 0.9, [("tk-research", "Research a topic.", 0.2)])
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls, result=pulled), monkeypatch)
    mod = boot(tmp_path, monkeypatch, calls, result=LIVE)
    mod.BLOCKLIST = frozenset({"tk-research"})
    hook(mod, monkeypatch, tmp_path)
    assert len(calls) == 2 and rows(tmp_path, "offer")[0]["spec"]["st"] == "stale"


def test_a_verdict_is_not_served_when_the_catalogue_cannot_be_read(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    mod = boot(tmp_path, monkeypatch, calls)

    def down():
        raise OSError("qdrant down")
    monkeypatch.setattr(mod, "_jev_catalog", down)
    hook(mod, monkeypatch, tmp_path)
    assert len(calls) == 2 and rows(tmp_path, "offer")[0]["spec"]["st"] == "stale"


def test_the_ticket_lives_five_minutes():
    assert offer_ticket.TICKET_TTL_S == 300


# ── the preview carries no whole-shelf claim unless the hook will serve this very menu ──────────────────────

def test_whole_shelf_is_reported_only_for_a_ranked_ticket(tmp_path, monkeypatch):
    _, report, _ = speculate(boot(tmp_path, monkeypatch, []), monkeypatch)
    assert report["ticket"] == "ranked" and report["preview"]["whole_shelf"] is True
    _, report, _ = speculate(boot(tmp_path, monkeypatch, [], event=WIDE), monkeypatch)       # wide-only: unranked
    assert report["ticket"] == "unranked" and report["preview"]["kind"] == "menu"
    assert report["preview"]["whole_shelf"] is False
    _, report, _ = speculate(boot(tmp_path, monkeypatch, [], ENFORCER_TICKET="0"), monkeypatch)
    assert report["ticket"] == "none" and report["preview"]["whole_shelf"] is False


# ── B4 ─ only the exact sent text matches ────────────────────────────────────────────────────────────────────

def test_an_edited_prompt_finds_no_ticket(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path, prompt=SENT + " and keep the old toggle")
    assert len(calls) == 2
    [row] = rows(tmp_path, "offer")
    assert "via" not in row and "spec" not in row and "rq" not in row and "src" not in row["jev"]
    assert calls[1]["prompt"] == SENT + " and keep the old toggle"


def test_surrounding_whitespace_on_the_sent_text_still_matches(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path, prompt="  " + SENT + "\n")
    assert len(calls) == 1 and rows(tmp_path, "offer")[0]["spec"]["st"] == "ready"


def test_a_ticket_for_another_session_is_not_served(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch, sid="sess-other")
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    assert len(calls) == 2 and "via" not in rows(tmp_path, "offer")[0]


# ── B5 ─ a run still ranking ─────────────────────────────────────────────────────────────────────────────────

def open_ranking(tmp_path, monkeypatch, calls, deadline_in=5.0):
    """A ticket whose run is still ranking, with the fingerprints the hook will compute."""
    probe = boot(tmp_path, monkeypatch, calls)
    prev, skills = probe._jev_context(str(tmp_path / "claude" / "projects" / "proj" / f"{SID}.jsonl"))
    offer_ticket.open_ticket(SID, SENT, INTENT, ranking=True, ctx=offer_ticket.fingerprint_ctx(prev, skills),
                             env=offer_ticket.fingerprint_env(probe.RUNNING_HARNESS, os.environ),
                             deadline=time.time() + deadline_in, n=1)


def test_a_ranking_ticket_is_waited_for_and_then_served(tmp_path, monkeypatch):
    calls = []
    open_ranking(tmp_path, monkeypatch, calls)
    verdict = offer_ticket.Verdict(RESULT, dict(FULL))
    timer = threading.Timer(0.3, offer_ticket.settle, (SID, SENT, verdict))
    timer.start()
    try:
        hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    finally:
        timer.join()
    assert calls == []                                # the hook never asked Jev
    [row] = rows(tmp_path, "offer")
    assert row["spec"]["st"] == "waited" and 250 <= row["spec"]["wait_ms"] <= 600
    assert row["jev"]["src"] == "ticket"


def test_a_ticket_whose_run_died_ranks_live(tmp_path, monkeypatch):
    calls = []
    open_ranking(tmp_path, monkeypatch, calls)
    gone = subprocess.Popen([sys.executable, "-c", "pass"])
    gone.wait()
    edit_ticket(pid=gone.pid)
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    assert len(calls) == 1 and rows(tmp_path, "offer")[0]["spec"]["st"] == "dead"


def test_a_ticket_that_never_settles_cannot_stretch_the_jev_leg_past_its_budget(tmp_path, monkeypatch):
    calls = []
    open_ranking(tmp_path, monkeypatch, calls, deadline_in=60.0)
    mod = boot(tmp_path, monkeypatch, calls, ENFORCER_JEV_BUDGET="4.0")
    ticket = offer_ticket.find(SID, SENT)
    assert ticket is not None and ticket.state == "ranking"
    t0 = time.time()
    job = mod._jev_start(RANKED, str(tmp_path / "claude" / "projects" / "proj" / f"{SID}.jsonl"), ticket)
    mod._jev_join(job)
    elapsed = time.time() - t0
    assert 0.45 <= elapsed <= 0.65                    # waited until deadline - 3.5 s, then ranked live
    job[0].join(2)
    assert [c["deadline"] for c in calls] == [job[2]]  # ...with the same deadline, not a fresh budget
    assert mod._VIA["spec"]["st"] == "late"


def test_a_waiting_hook_keeps_a_live_reserve_for_its_own_ranking(tmp_path, monkeypatch):
    """The run is still ranking and never settles: the hook stops waiting 3.5 s before its Jev deadline, so
    the live route that follows still has room for a tier call."""
    calls = []
    open_ranking(tmp_path, monkeypatch, calls, deadline_in=60.0)
    mod = boot(tmp_path, monkeypatch, calls, ENFORCER_JEV_BUDGET="4.5")
    ticket = offer_ticket.find(SID, SENT)
    job = mod._jev_start(RANKED, str(tmp_path / "claude" / "projects" / "proj" / f"{SID}.jsonl"), ticket)
    mod._jev_join(job)
    job[0].join(2)
    [call] = calls
    assert mod.TICKET_LIVE_RESERVE_S == 3.5
    assert call["deadline"] - call["at"] >= 3.4       # the live route started with the reserve intact
    assert mod._VIA["spec"]["st"] == "late"

    calls.clear()                                     # a budget smaller than the reserve waits not at all
    mod = boot(tmp_path, monkeypatch, calls, ENFORCER_JEV_BUDGET="2.0")
    t0 = time.time()
    job = mod._jev_start(RANKED, str(tmp_path / "claude" / "projects" / "proj" / f"{SID}.jsonl"), ticket)
    mod._jev_join(job)
    assert time.time() - t0 < 0.3 and len(calls) == 1


def test_redeem_never_sleeps_past_its_deadline(tmp_path):
    offer_ticket.open_ticket(SID, SENT, "", ranking=True, ctx="c", env="e", deadline=time.time() + 60, n=0)
    ticket = offer_ticket.find(SID, SENT)
    t0 = time.time()
    red = offer_ticket.redeem(ticket, ctx="c", env="e", until=time.time() + 0.2)
    assert red.verdict is None and red.spec["st"] == "late" and time.time() - t0 < 0.3


# ── B6 ─ deterministic routes read the sent text only ────────────────────────────────────────────────────────

def test_a_route_phrase_only_in_the_intent_pins_nothing(tmp_path, monkeypatch):
    calls = []
    mod = boot(tmp_path, monkeypatch, calls)
    mod._ROUTES = [("zebra-skill", "ak:zebra")]
    assert mod._route_hits("use the zebra-skill here", frozenset()) == [("ak:zebra", "named in the prompt — deterministic route", 1.0)]
    _, report, _ = speculate(mod, monkeypatch, intent="Use the zebra-skill for the settings page.")
    assert len(calls) == 1 and report["preview"]["skills"] == ["ak-git", "update-config"]
    hook_mod = boot(tmp_path, monkeypatch, calls)
    hook_mod._ROUTES = [("zebra-skill", "ak:zebra")]
    hook(hook_mod, monkeypatch, tmp_path)
    assert len(calls) == 1
    [row] = rows(tmp_path, "offer")
    assert ["ak:zebra", 1.0] not in row["offered"] and row["spec"]["st"] == "ready"


def test_a_route_phrase_in_the_sent_text_pins_the_skill_and_skips_jev(tmp_path, monkeypatch):
    calls = []
    mod = boot(tmp_path, monkeypatch, calls)
    mod._ROUTES = [("zebra-skill", "ak:zebra")]
    _, report, _ = speculate(mod, monkeypatch, prompt="use the zebra-skill on the settings page please")
    assert calls == [] and report["ticket"] == "unranked" and report["preview"]["skills"][0] == "ak:zebra"


# ── B7 ─ malformed tickets are ignored ───────────────────────────────────────────────────────────────────────

def fresh_ticket(tmp_path, verdict=None):
    offer_ticket.open_ticket(SID, SENT, INTENT, ranking=True, ctx="c", env="e", deadline=time.time() + 5, n=1)
    if verdict:
        offer_ticket.settle(SID, SENT, verdict)
    return offer_ticket.find(SID, SENT)


def test_a_wellformed_ticket_round_trips(tmp_path):
    t = fresh_ticket(tmp_path, offer_ticket.Verdict(RESULT, dict(FULL)))
    assert (t.sid, t.intent, t.state, t.ctx, t.env, t.n, t.pid) == (SID, INTENT, "ranked", "c", "e", 1, os.getpid())
    assert t.verdict.result == RESULT and t.verdict.event == FULL


@pytest.mark.parametrize("name,mutate", [
    ("bad json", lambda p: p.write_text("{not json")),
    ("empty file", lambda p: p.write_text("")),
    ("not an object", lambda p: p.write_text("[1, 2]")),
    ("NaN made", lambda p: edit_ticket(made=float("nan"))),
    ("string made", lambda p: edit_ticket(made="now")),
    ("expired", lambda p: edit_ticket(made=time.time() - offer_ticket.TICKET_TTL_S - 5)),
    ("wrong version", lambda p: edit_ticket(v=2)),
    ("wrong sid", lambda p: edit_ticket(sid="sess-other")),
    ("other text", lambda p: edit_ticket(qh="0" * 64)),
    ("over-long intent", lambda p: edit_ticket(intent="x" * (offer_ticket.MAX_INTENT_CHARS + 1))),
    ("unknown state", lambda p: edit_ticket(state="done")),
    ("bool pid", lambda p: edit_ticket(pid=True)),
    ("ranked without verdict", lambda p: edit_ticket(state="ranked", verdict=None)),
    ("ranked with a malformed row", lambda p: edit_ticket(state="ranked", verdict={
        "result": ["offer", [["ak-git", "d"]], 0.9, []], "event": {}})),
    ("deep nesting", lambda p: p.write_text("[" * 50000 + "]" * 50000)),
    ("oversized", lambda p: p.write_text(" " * (offer_ticket.MAX_FILE_BYTES + 1))),
])
def test_a_malformed_ticket_is_ignored_without_an_exception(tmp_path, name, mutate):
    assert fresh_ticket(tmp_path) is not None        # the positive control: the same file, unharmed, is found
    mutate(ticket_file())
    assert offer_ticket.find(SID, SENT) is None, name


@pytest.mark.parametrize("sid", ["../evil", "a/b", "", "x" * 129, "sp ace", None, 7])
def test_a_sid_that_is_not_a_plain_name_never_reaches_the_disk(tmp_path, sid):
    offer_ticket.open_ticket(sid, SENT, "", ranking=True, ctx="c", env="e", deadline=time.time() + 5, n=0)
    assert offer_ticket.find(sid, SENT) is None
    assert offer_ticket.find_transcript(sid) == ""
    assert not offer_ticket.TICKET_DIR.exists() or list(offer_ticket.TICKET_DIR.iterdir()) == []
    assert not (tmp_path / "evil.ticket.json").exists()


def test_settle_never_overwrites_a_ticket_for_another_text_or_another_run(tmp_path):
    fresh_ticket(tmp_path)
    offer_ticket.settle(SID, "some other draft", offer_ticket.Verdict(RESULT, dict(FULL)))
    assert offer_ticket.find(SID, SENT).state == "ranking"
    edit_ticket(pid=os.getpid() + 1)                  # a newer run for this very text owns the file
    offer_ticket.settle(SID, SENT, offer_ticket.Verdict(RESULT, dict(FULL)))
    assert offer_ticket.find(SID, SENT).state == "ranking"


def test_settle_without_a_verdict_leaves_the_ticket_unranked(tmp_path):
    fresh_ticket(tmp_path)
    offer_ticket.settle(SID, SENT, None)
    assert offer_ticket.find(SID, SENT).state == "unranked" and offer_ticket.find(SID, SENT).verdict is None


def test_a_verdict_that_cannot_be_serialised_settles_unranked(tmp_path):
    fresh_ticket(tmp_path)
    offer_ticket.settle(SID, SENT, offer_ticket.Verdict(("offer", [("a", "d", float("nan"))], 0.9, []), {}))
    assert offer_ticket.find(SID, SENT).state == "unranked"


def test_the_writer_prunes_old_tickets_route_hints_and_temp_files(tmp_path):
    d = offer_ticket.TICKET_DIR
    d.mkdir(parents=True)
    old = time.time() - offer_ticket.TICKET_TTL_S - 60
    for name in ("old.ticket.json", "legacy-hint.json", ".tmp-x.part"):
        (d / name).write_text("{}")
        os.utime(d / name, (old, old))
    (d / "young.ticket.json").write_text("{}")
    fresh_ticket(tmp_path)
    assert sorted(p.name for p in d.iterdir()) == [f"{SID}.ticket.json", "young.ticket.json"]


# ── B8 ─ the kill switch ─────────────────────────────────────────────────────────────────────────────────────

def test_ticket_off_writes_no_ticket_and_ignores_an_existing_one(tmp_path, monkeypatch):
    calls = []
    _, report, _ = speculate(boot(tmp_path, monkeypatch, calls, ENFORCER_TICKET="0"), monkeypatch)
    assert report["ticket"] == "none" and report["preview"]["kind"] == "menu" and not ticket_file().exists()

    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)       # a ticket made while the flag was on
    assert ticket_file().exists() and len(calls) == 2
    hook(boot(tmp_path, monkeypatch, calls, ENFORCER_TICKET="0"), monkeypatch, tmp_path)
    assert len(calls) == 3                                           # ranked live, exactly as without the mod
    [row] = rows(tmp_path, "offer")
    assert "via" not in row and "spec" not in row and "rq" not in row and "src" not in row["jev"]
    assert calls[2]["prompt"] == SENT                                # and without the intent line


# ── grafts ───────────────────────────────────────────────────────────────────────────────────────────────────

def test_a_wide_stage_result_is_never_stored_and_the_hook_gets_its_own_chance(tmp_path, monkeypatch):
    calls = []
    _, report, _ = speculate(boot(tmp_path, monkeypatch, calls, event=WIDE), monkeypatch)
    assert report["ticket"] == "unranked"
    assert offer_ticket.find(SID, SENT).state == "unranked"
    hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    assert len(calls) == 2
    [row] = rows(tmp_path, "offer")
    assert row["spec"]["st"] == "unranked" and row["jev"]["stage"] == "full" and "src" not in row["jev"]


def test_a_failed_route_settles_unranked(tmp_path, monkeypatch):
    calls = []
    err = {"err": "TimeoutError", "ms": 7800, "leg": "router"}
    _, report, _ = speculate(boot(tmp_path, monkeypatch, calls, result=None, event=err), monkeypatch)
    assert report["ticket"] == "unranked" and report["preview"]["kind"] == "menu"
    assert rows(tmp_path, "speculate")[0]["jev_stage"] == "err"


@pytest.mark.parametrize("draft", [
    "deploy with api_key = sk-abcdefghijklmnopqrstuvwx to the production server",
    "call the api with Bearer abcdefghijklmnopqrstuv in the header please",
    "-----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAKCAQEA add this to the settings page",
])
def test_a_draft_with_a_secret_shape_skips_jev_and_leaves_no_ticket(tmp_path, monkeypatch, draft):
    calls = []
    _, report, _ = speculate(boot(tmp_path, monkeypatch, calls), monkeypatch, prompt=draft)
    assert calls == [] and report["ticket"] == "none" and report["preview"]["kind"] == "menu"
    assert not ticket_file().exists()


def test_the_mods_minimum_word_count_is_the_enforcers_short_prompt_floor_plus_one(tmp_path, monkeypatch):
    src = ROOT / "adapters" / "claude-code" / "mod" / "hooks" / "speculator.ts"
    m = re.search(r"\bMIN_WORDS\s*(?::\s*number\s*)?=\s*(\d+)", src.read_text(encoding="utf-8")) if src.exists() else None
    assert m is not None, "adapters/claude-code/mod/hooks/speculator.ts must declare MIN_WORDS"
    assert int(m.group(1)) == boot(tmp_path, monkeypatch, []).MAX_SHORT_WORDS + 1


# ── golden: a session without the mod is unchanged ───────────────────────────────────────────────────────────

def test_a_turn_without_a_ticket_writes_the_offer_row_it_always_did(tmp_path, monkeypatch):
    calls = []
    context = hook(boot(tmp_path, monkeypatch, calls), monkeypatch, tmp_path)
    assert [c["prompt"] for c in calls] == [SENT] and calls[0]["deadline"] is None   # today's call, unchanged
    [row] = rows(tmp_path, "offer")
    machine_state = {"route", "badges", "hint", "n_intents", "dropped", "ext", "xh", "pulled"}   # this machine's lists
    assert set(row) - machine_state == {"t", "sid", "ev", "band", "offered", "fallback", "q", "harness",
                                        "embed_ms", "qdrant_ms", "jev"}
    assert row["q"] == SENT and row["band"] == "offer" and row["fallback"] is None
    assert row["offered"] == [["ak-git", 0.8], ["update-config", 0.1]]
    assert set(row["jev"]) == set(FULL)               # exactly the route's own event: no src, no age_ms
    assert not any(k in row for k in ("via", "rq", "spec"))
    assert bullets(context) == ["ak-git", "update-config"] and "skillConciergeSpeculation" not in context
    assert rows(tmp_path, "speculate") == []


def test_the_hook_stdout_is_still_one_unterminated_json_object(tmp_path, monkeypatch):
    mod = boot(tmp_path, monkeypatch, [])
    out = feed(monkeypatch, {"prompt": SENT, "session_id": SID})
    assert mod._run() == 0
    text = out.getvalue()
    assert text.startswith('{"hookSpecificOutput"') and not text.endswith("\n") and json.loads(text)


def test_a_stripped_install_without_the_ticket_module_ranks_live(tmp_path, monkeypatch):
    calls = []
    speculate(boot(tmp_path, monkeypatch, calls), monkeypatch)
    mod = boot(tmp_path, monkeypatch, calls)
    monkeypatch.setattr(mod, "offer_ticket", None)
    hook(mod, monkeypatch, tmp_path)
    assert len(calls) == 2 and "via" not in rows(tmp_path, "offer")[0]


# ── the pure helpers, on literal values ──────────────────────────────────────────────────────────────────────

def test_route_text_puts_the_intent_on_its_own_paragraph():
    assert offer_ticket.route_text("  fix the login bug now ", "") == "fix the login bug now"
    assert offer_ticket.route_text("fix the login bug now", "  Repair the login flow. ") == \
        "fix the login bug now\n\nRepair the login flow."


def test_fingerprints_change_with_what_shapes_a_ranking_and_ignore_the_rest():
    base = {"ENFORCER_JEV_FITS_FLOOR": "0.30", "SKILL_BLOCKLIST": "1", "PATH": "/usr/bin", "TYPESAFE_API_KEY": "k1"}
    fp = offer_ticket.fingerprint_env("claude", base)
    assert len(fp) == 16 and fp == offer_ticket.fingerprint_env("claude", dict(base))
    assert fp != offer_ticket.fingerprint_env("codex", base)
    assert fp != offer_ticket.fingerprint_env("claude", {**base, "ENFORCER_JEV_FITS_FLOOR": "0.40"})
    assert fp != offer_ticket.fingerprint_env("claude", {**base, "JEVD_URL": "http://127.0.0.1:1"})
    assert fp != offer_ticket.fingerprint_env("claude", {k: v for k, v in base.items() if k != "TYPESAFE_API_KEY"})
    assert fp == offer_ticket.fingerprint_env("claude", {**base, "TYPESAFE_API_KEY": "another-key"})   # presence only
    assert fp == offer_ticket.fingerprint_env("claude", {**base, "PATH": "/bin", "SKILL_CONCIERGE_HARNESS": "claude",
                                                         "ENFORCER_LEDGER": "defer"})
    c = offer_ticket.fingerprint_ctx("Done.", ["ak-git"])
    assert len(c) == 16 and c == offer_ticket.fingerprint_ctx("Done.", ["ak-git"])
    assert c != offer_ticket.fingerprint_ctx("Done!", ["ak-git"]) and c != offer_ticket.fingerprint_ctx("Done.", [])


def test_find_transcript_returns_the_newest_match_for_a_plain_sid(tmp_path):
    base = tmp_path / "claude" / "projects"
    older = transcript(tmp_path, "one")
    newer = base / "other-proj" / f"{SID}.jsonl"
    newer.parent.mkdir(parents=True)
    newer.write_text("{}\n")
    os.utime(older, (time.time() - 100, time.time() - 100))
    assert offer_ticket.find_transcript(SID) == str(newer)
    assert offer_ticket.find_transcript("no-such-session") == ""
