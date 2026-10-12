"""The draft-time ticket: the one channel from a speculative enforcer run to the hook that serves
the same prompt.

The concierge-enhancer mod spawns `enforcer.py` with a `speculate` request while the user types.
That run writes a ticket: the Jev verdict it reached for that exact draft, under the context it
read. When the user sends that exact text, the UserPromptSubmit hook redeems the ticket instead of
asking Jev again, so the model reads the ranking the user saw, computed once, before Enter.

This module owns everything about a ticket: where it lives, its format, its validation and its
lifecycle. Nothing else reads or writes the file; the mod never sees it.

Public names: route_text, fingerprint_ctx, fingerprint_env, find_transcript, open_ticket, settle,
find, redeem, plus the types Verdict, Ticket, Redemption and the constants below.

Invariants:
- One ticket file per session id, written only by speculative runs (`open_ticket`, `settle`),
  always by atomic rename, so a reader sees a whole old ticket or a whole new one.
- The hook never writes or deletes a ticket. A stale ticket is harmless because `find` and
  `redeem` check every input that made it: the exact sent text (by hash), the session id, the
  conversation context Jev read, the environment that shapes the ranking, and age.
- The file holds no draft text: the sent text is matched by SHA-256 and only the intent line is
  stored, because the hook rebuilds the ranked text from the prompt it receives (`route_text`).
- `redeem` never waits past the caller's own deadline, so a ticket can shorten a turn and never
  lengthen it beyond today's Jev budget.
- Python 3.9, stdlib only; every public function is fail-silent (returns None / a miss).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import time
from pathlib import Path
from typing import NamedTuple, Optional

TICKET_VERSION = 1
# The first mod build left route hints here as `<sid>.json`; tickets take a new name so no old file parses.
TICKET_DIR = Path.home() / ".claude" / "skill-concierge" / "route-hints"
TICKET_SUFFIX = ".ticket.json"
TICKET_TTL_S = 300        # a draft can sit settled for minutes; the context and env checks and the hook's live row filters carry the rest
POLL_S = 0.05             # how often `redeem` re-reads a ticket whose run is still ranking
LATE_GRACE_S = 0.3        # past a ranking ticket's own deadline, its run is late, not slow
MAX_INTENT_CHARS = 600
MAX_FILE_BYTES = 262144   # a real ticket is a few KB; anything larger is not ours
SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_STATES = ("ranking", "ranked", "unranked")
_KEY_PRESENCE = ("TYPESAFE_API_KEY", "CMD_API_KEY", "FLYWHEEL_LLM_API_KEY")
_ENV_SKIP = ("SKILL_CONCIERGE_HARNESS", "ENFORCER_LEDGER")


class Verdict(NamedTuple):
    """A Jev routing result exactly as `_jev_route` returns it: `result` is
    (verdict, rows, best_fit, pulled) with rows/pulled as [(name, desc, probability)], `event` the
    telemetry dict. Only a ticket holding a non-None result is ever served."""
    result: tuple
    event: dict


class Ticket(NamedTuple):
    """A parsed, validated ticket. `state` is "ranking" (its run is asking Jev), "ranked" (holds a
    Verdict) or "unranked" (no Jev verdict: the hook ranks `route_text(sent, intent)` itself)."""
    sid: str
    intent: str               # '' when the run ranked the draft alone
    state: str
    made: float               # epoch seconds the run opened the ticket
    deadline: float           # epoch seconds the run's own Jev budget ends
    pid: int                  # the run's process, for a liveness check while ranking
    ctx: str                  # fingerprint_ctx of what Jev read
    env: str                  # fingerprint_env of the run
    n: int                    # runs the mod made for this composed prompt (cost telemetry)
    verdict: Optional[Verdict]
    qh: str = ""              # SHA-256 of the stripped sent text; `redeem` re-reads the file by it


class Redemption(NamedTuple):
    """What the hook gets back: the verdict to serve, or None (rank live), and the ledger's `spec`
    telemetry, always: {"st": ready|waited|stale|env|dead|late|unranked, "age_ms", "wait_ms", "n",
    "intent": bool}."""
    verdict: Optional[Verdict]
    spec: dict


def _hash(sent: str) -> str:
    return hashlib.sha256((sent or "").strip().encode("utf-8", "replace")).hexdigest()


def _path(sid: str) -> Path:
    return TICKET_DIR / (sid + TICKET_SUFFIX)


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def route_text(sent: str, intent: str) -> str:
    """The text concierge ranks for a prompt: the author's own words, then the intent line on its
    own paragraph (the A/B's best arm, raw + intent). The sent text alone when there is no intent.
    The single definition used by the speculative run and the hook alike."""
    sent = (sent or "").strip()
    intent = (intent or "").strip()
    return sent + "\n\n" + intent if intent else sent


def fingerprint_ctx(prev: str, skills: list) -> str:
    """SHA-256 (hex, 16 chars) of what Jev reads besides the request: the last assistant text and
    the skills already loaded, exactly as enforcer._jev_context returns them. A ticket made under
    another context (a turn ran in between) never matches."""
    blob = json.dumps([prev or "", [str(s) for s in (skills or [])]], ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8", "replace")).hexdigest()[:16]


def fingerprint_env(harness: str, environ: dict) -> str:
    """SHA-256 (hex, 16 chars) of the settings that shape a ranking: `harness` (the detected
    RUNNING_HARNESS, not SKILL_CONCIERGE_HARNESS, which only the speculative run sets), every
    ENFORCER_* and SKILL_* value except SKILL_CONCIERGE_HARNESS and ENFORCER_LEDGER, JEVD_URL, and
    the PRESENCE (never the value) of TYPESAFE_API_KEY, CMD_API_KEY and FLYWHEEL_LLM_API_KEY.
    A mod whose child environment differs from the hook's (grounding D8) is caught here, per
    turn, and shows in the ledger as spec.st = "env"."""
    env = {k: str(v) for k, v in environ.items()
           if (k.startswith("ENFORCER_") or k.startswith("SKILL_")) and k not in _ENV_SKIP}
    blob = json.dumps({"h": harness, "e": env, "jevd": str(environ.get("JEVD_URL", "")),
                       "k": [bool(environ.get(k)) for k in _KEY_PRESENCE]},
                      sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8", "replace")).hexdigest()[:16]


def find_transcript(sid: str) -> str:
    """The session's transcript path for a speculative run, which the mod API cannot supply:
    `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<sid>.jsonl`, the newest match; '' when the sid is
    not a plain name or no file exists yet (a session's first prompt). A wrong or missing path
    only costs the ticket: its context fingerprint will not match the hook's."""
    try:
        if not isinstance(sid, str) or not SID_RE.match(sid):
            return ""
        base = Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))
        best, best_t = "", -1.0
        for p in (base / "projects").glob("*/" + sid + ".jsonl"):
            try:
                t = p.stat().st_mtime
            except OSError:
                continue
            if t > best_t:
                best, best_t = str(p), t
        return best
    except (OSError, ValueError, TypeError):
        return ""


def _write(path: Path, obj: dict) -> bool:
    """Atomic: a temp file in the same directory, then os.replace. False on any failure."""
    tmp = ""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".part")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, allow_nan=False)
        os.replace(tmp, path)
        return True
    except (OSError, ValueError, TypeError, OverflowError, RecursionError):
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return False


def _prune(keep: Path) -> None:
    """Remove this directory's tickets, old route hints and orphaned temp files past the TTL. The
    writer is the only cleaner; the hook never calls this."""
    try:
        cutoff = time.time() - TICKET_TTL_S
        for p in TICKET_DIR.iterdir():
            if p == keep or not (p.name.endswith(".json") or p.name.endswith(".part")):
                continue
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                continue
    except OSError:
        return


def open_ticket(sid: str, sent: str, intent: str, *, ranking: bool, ctx: str, env: str,
                deadline: float, n: int) -> None:
    """Called by a speculative run once the early lanes passed and the ranked text is fixed.
    Writes state "ranking" when Jev is about to start, else "unranked" (named skill, non-English,
    router off: the hook will rank route_text itself, quickly). Atomic (temp file + os.replace).
    Also prunes this directory's ticket and old route-hint files older than TICKET_TTL_S, so the
    writer is the only cleaner. Fail-silent."""
    try:
        if not isinstance(sid, str) or not SID_RE.match(sid):
            return
        path = _path(sid)
        if _write(path, {"v": TICKET_VERSION, "sid": sid, "qh": _hash(sent),
                         "intent": (intent or "")[:MAX_INTENT_CHARS],
                         "state": "ranking" if ranking else "unranked", "made": time.time(),
                         "deadline": float(deadline), "pid": os.getpid(), "ctx": ctx, "env": env,
                         "n": int(n), "verdict": None}):
            _prune(path)
    except (ValueError, TypeError, OverflowError):
        return


def _verdict_json(verdict: Verdict) -> dict:
    return {"result": [verdict.result[0], [list(r) for r in verdict.result[1]], verdict.result[2],
                       [list(r) for r in verdict.result[3]]],
            "event": verdict.event}


def settle(sid: str, sent: str, verdict: Optional[Verdict]) -> None:
    """Called by the speculative run when its Jev job joined (the same `_jev_join` deadline the
    hook uses). Rewrites the ticket for the same sent-text hash as "ranked" with the verdict, or
    "unranked" when Jev gave none. Never overwrites a ticket for another text (a newer run owns
    the file then), nor one another process opened for the same text. Atomic, fail-silent."""
    try:
        t = _load(sid, _hash(sent), check_age=False)
        if t is None or t.pid != os.getpid() or t.state != "ranking":
            return
        doc = {"v": TICKET_VERSION, "sid": sid, "qh": t.qh, "intent": t.intent, "state": "unranked",
               "made": t.made, "deadline": t.deadline, "pid": t.pid, "ctx": t.ctx, "env": t.env,
               "n": t.n, "verdict": None}
        if verdict is not None and verdict.result is not None:
            try:
                doc["verdict"] = _verdict_json(verdict)
                json.dumps(doc, allow_nan=False)
                doc["state"] = "ranked"
            except (ValueError, TypeError, IndexError, OverflowError):
                doc["verdict"] = None
        _write(_path(sid), doc)
    except (ValueError, TypeError, OverflowError):
        return


def _rows(rows) -> Optional[list]:
    """[[name, desc, probability], ...] -> [(name, desc, probability), ...], or None if malformed."""
    if not isinstance(rows, list):
        return None
    out = []
    for r in rows:
        if not (isinstance(r, list) and len(r) == 3 and isinstance(r[0], str)
                and isinstance(r[1], str) and _num(r[2])):
            return None
        out.append((r[0], r[1], r[2]))
    return out


def _parse_verdict(v) -> Optional[Verdict]:
    if not isinstance(v, dict):
        return None
    res, ev = v.get("result"), v.get("event")
    if not (isinstance(res, list) and len(res) == 4 and isinstance(ev, dict)):
        return None
    verdict, rows, best, pulled = res
    rows, pulled = _rows(rows), _rows(pulled)
    if verdict not in ("offer", "skip") or rows is None or pulled is None \
            or not (best is None or _num(best)):
        return None
    return Verdict((verdict, rows, best, pulled), ev)


def _load(sid: str, qh: str, check_age: bool = True) -> Optional[Ticket]:
    """Read and validate the session's ticket for the text hash `qh`; None for anything else."""
    try:
        if not isinstance(sid, str) or not SID_RE.match(sid):
            return None
        path = _path(sid)
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
        d = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError, RecursionError, TypeError):
        return None
    if not isinstance(d, dict) or d.get("v") != TICKET_VERSION or d.get("sid") != sid \
            or d.get("qh") != qh or d.get("state") not in _STATES:
        return None
    made, deadline, pid, n = d.get("made"), d.get("deadline"), d.get("pid"), d.get("n")
    intent, ctx, env = d.get("intent"), d.get("ctx"), d.get("env")
    if not (_num(made) and _num(deadline) and isinstance(pid, int) and not isinstance(pid, bool)
            and isinstance(n, int) and not isinstance(n, bool) and isinstance(intent, str)
            and len(intent) <= MAX_INTENT_CHARS and isinstance(ctx, str) and isinstance(env, str)):
        return None
    if check_age and not (-5.0 <= time.time() - made <= TICKET_TTL_S):
        return None
    verdict = None
    if d["state"] == "ranked":
        verdict = _parse_verdict(d.get("verdict"))
        if verdict is None:
            return None
    return Ticket(sid, intent, d["state"], float(made), float(deadline), pid, ctx, env, n, verdict, qh)


def find(sid: str, sent: str) -> Optional[Ticket]:
    """The hook's first read, before the early lanes: the ticket for exactly this sent text
    (SHA-256 of the stripped prompt), this sid, version TICKET_VERSION, younger than TICKET_TTL_S,
    with finite numbers and an intent no longer than MAX_INTENT_CHARS. None for anything else,
    including a malformed, deeply nested or oversized file. Read-only."""
    return _load(sid, _hash(sent))


def _alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True   # exists, or cannot be told: not provably gone
    return True


def redeem(ticket: Ticket, *, ctx: str, env: str, until: float) -> Redemption:
    """Runs in the hook's Jev worker thread. Returns at once with a miss when `env` or `ctx` differ
    from the ticket's ("env", "stale") or the ticket is "unranked". Returns the verdict at once
    when "ranked" ("ready"). When "ranking": re-reads the file every POLL_S until it is ranked
    ("waited"), unranked, its run's pid is gone ("dead"), its own deadline + LATE_GRACE_S passed
    ("late"), or `until` (the hook's own Jev deadline) passed. Never sleeps past `until`."""
    t0 = time.time()
    base = {"n": ticket.n, "intent": bool(ticket.intent)}

    def out(st: str, verdict: Optional[Verdict] = None) -> Redemption:
        now = time.time()
        return Redemption(verdict, {"st": st, "age_ms": max(0, int((now - ticket.made) * 1000)),
                                    "wait_ms": int((now - t0) * 1000), **base})
    try:
        if ticket.env != env:
            return out("env")
        if ticket.ctx != ctx:
            return out("stale")
        cur = ticket
        while True:
            if cur.state == "ranked" and cur.verdict is not None:
                return out("ready" if cur is ticket else "waited", cur.verdict)
            if cur.state == "unranked":
                return out("unranked")
            now = time.time()
            if not _alive(cur.pid):
                return out("dead")
            if now > cur.deadline + LATE_GRACE_S or now >= until:
                return out("late")
            time.sleep(max(0.0, min(POLL_S, until - now)))
            nxt = _load(ticket.sid, ticket.qh)
            if nxt is None or nxt.pid != ticket.pid or nxt.ctx != ticket.ctx or nxt.env != ticket.env:
                return out("dead")   # replaced by a newer run, or gone: this run no longer owns the file
            cur = nxt
    except (OSError, ValueError, TypeError, OverflowError):
        return out("dead")
