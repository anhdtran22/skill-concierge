"""SKETCH of the changes to hooks/scripts/enforcer.py for the typing-time handoff (candidate-fable).

Not a module to import: every function here is a new or changed definition inside enforcer.py, in
the order it would appear. Bodies are `raise NotImplementedError` or pseudocode. Line numbers cite
today's file (v0.67.0). Everything must still load on Python 3.9 (tests/test_python39_hooks.py).

The shape in one paragraph: `enforcer.py --prepare` runs the same no-I/O lanes and the same
`_jev_route` as the hook, synchronously, on a draft the concierge-enhancer mod sends while the
person types, and prints the verdict as a handoff object plus a view for the band. At Enter the
mod writes that object to the route-hints file. The hook (`main()`, unchanged entry, hooks.json
untouched) consumes the file first, as it consumes the v1 route hint today, and when the file's
Jev verdict was computed on the text the hook is about to rank, `_jev_join` returns it at once
instead of starting a thread. Embedding, Qdrant, keep-off, blocklist, annexes, pull-ins, chain
hint, rendering and the ledger row all run exactly as today. One ranking, one menu; the hook
just did not have to wait for it.
"""

from __future__ import annotations

import time
from pathlib import Path

# ── constants (replace ROUTE_HINTS / ROUTE_HINT_TTL at enforcer.py:1232-1235) ───────────────────

HANDOFF_DIR = Path.home() / ".claude" / "skill-concierge" / "route-hints"   # same folder as v1; v2 contents
HANDOFF_V = 2
HANDOFF_TTL_S = 300      # file freshness, by mtime (the mod writes inside the same submit; this guards clocks)
HANDOFF_JEV_TTL_S = 120  # a Jev verdict older than this is not adopted: the hook routes itself
# `_VIA` keeps its role (offer-row keys for a handed run): via, q (as sent), rq (route text, only when it differs)
_VIA: dict = {}


# ── lanes: ONE list, shared by main() and --prepare (replaces the inline chain at :3065-3104) ───

def _early_lane(prompt: str, data: dict) -> "str | None":
    """The no-I/O lane that ends this turn before any ranking, or None when the turn ranks.

    Returns one of 'slash' | 'short' | 'harness' | 'refusal' | 'consult' | 'selfref', in the exact order
    main() applies them today (:3065, :3067, :3075, :3082, :3092, :3101), with the same flags
    (HARNESS_SKIP, CONSULT_ROUTE, SELFREF_SKIP) and the same `agent_id` rule for consult. Pure: no I/O,
    no injection, no ledger. main() maps each name to the inject + offer-row pair it writes today;
    --prepare maps it to a `view` of kind 'lane'. Invariant: main() and --prepare can never disagree on
    whether a text ranks, because neither holds its own copy of the list."""
    raise NotImplementedError


# ── the handoff file (replaces _route_hint at :1238-1263) ────────────────────────────────────────

def _handoff(sid: str, prompt: str) -> "dict | None":
    """The concierge-enhancer mod's one-shot handoff for this exact prompt, or None.

    The mod writes `route-hints/<session_id>.json` while the prompt is being submitted, before this
    hook runs (grounding P5). Contents are what `--prepare` printed under "handoff":
      {"v": 2, "prompt": <draft as typed>, "route": <text ranked, absent when it is the prompt itself>,
       "jev": {"route": <text the verdict was computed on>, "result": [verdict, rows, best, pulled],
               "event": {...}, "t": <unix s>} | absent}
    One-shot: unlinked once it parses, match or not, so a hint never routes a later prompt.
    Accepted only when: `sid` matches _SID_RE; the file's mtime is within HANDOFF_TTL_S of now;
    `v` == 2; `prompt`.strip() == `prompt` as sent (stripped). Fail-silent: any defect means None.
    Returns {"route": str | None, "jev": dict | None}; `jev` is passed on unjudged here (see _jev_handed)."""
    raise NotImplementedError


def _jev_handed(jev: "dict | None", rank_text: str):
    """A finished Jev job for `_jev_join`, or None when the hook must route by itself.

    Adopted only when all hold: `jev` is a dict; `jev["route"] == rank_text` (the verdict was computed
    on the very text this hook is about to rank, intent line included); `time.time() - jev["t"]` is
    within HANDOFF_JEV_TTL_S; `result` is a 4-list whose verdict is 'offer' | 'skip' and whose rows
    are [name, desc, score] triples of str/str/finite float; every row name is still in the installed
    catalogue (a `_jev_catalog()` membership check: a skill uninstalled between prepare and send must
    not be offered). Returns the job shape `_jev_start` returns, with no thread:
        (None, {"result": tuple(result), "event": {**event, "src": "handoff", "age_ms": int}}, time.time())
    `_jev_join` treats a None thread as already joined. Per boundary-discipline: this is the one place
    the wire shape is validated; everything after trusts the tuple."""
    raise NotImplementedError


# ── changed: _jev_join accepts a handed job (:2366-2383) ───────────────────────────────────────

def _jev_join(job):
    """-> (verdict, rows, best_fit, pulled) or None (the embedding path decides).

    CHANGE: `job[0]` may be None (a handed job from `_jev_handed`): no join, no deadline; `_JEV_EVENT`
    becomes the handed event, whose `src: "handoff"` and `age_ms` make the mode visible in the
    ledger row (`jev.src`). A threaded job behaves exactly as today."""
    raise NotImplementedError


# ── --prepare: the pre-Enter pass ────────────────────────────────────────────────────────────────

def _transcript_for(sid: str) -> str:
    """The session transcript the hook would receive as `transcript_path`, located by id:
    `<config>/projects/*/<sid>.jsonl`, `<config>` = $CLAUDE_CONFIG_DIR or ~/.claude. '' when not found
    (then `_jev_context` yields empty context, as it does for a missing path today). The mod cannot read
    the path from `$`; the engine names the transcript after `$.session.id()` (grounding §4 State)."""
    raise NotImplementedError


def _view_of(kind: str, rows: list = (), **more) -> dict:
    """The band's view of a prepare result, derived from the same rows the hook will render:
    rows -> [{"name", "share", "badge", "blurb"}] with `share` = round(score / total * 100) exactly as
    `_ranked_mandate` computes it (:2881-2885), `badge` = _badge(name), `blurb` = _blurb(desc).
    Kinds: 'whole_shelf' (+ stage, fit, ms, n), 'jev_skip' (+ fit, ms), 'named', 'lane' (+ lane),
    'none' (+ why). One producer for what the band shows and what the hook renders."""
    raise NotImplementedError


def _prepare(data: dict) -> dict:
    """The `--prepare` entry. stdin: {"prompt": <draft>, "route": <draft + intent line> | absent, "session_id"}.
    Prints one JSON object: {"handoff": {...}, "view": {...}} and exits 0. Never writes a ledger row
    (the mod passes ENFORCER_LEDGER=0 as well), never injects, never touches the route-hints file.

    Steps, mirroring main() up to the Jev start:
      1. lane = _early_lane(prompt, data)        -> lane: view 'lane'; handoff carries no jev (nothing to hand)
      2. rank_text = (route or prompt).strip(); _VIA-free (no row here)
      3. hits = _route_hits(rank_text, KEEPOFF)  -> hits: view 'named' (the hook will not ask Jev either, :3123)
      4. not JEV_ROUTER or not _is_english(rank_text) -> view 'none' (why), handoff carries route only
      5. r = _jev_route(rank_text, _transcript_for(sid))   # synchronous; its own JEV_BUDGET_S (7.8 s) applies
         result None -> view 'none' ('jev_failed'); else jev = {"route": rank_text, "result": r["result"],
         "event": r["event"], "t": time.time()}; view 'whole_shelf' or 'jev_skip' from the verdict
    Handoff always carries `v`, `prompt`, and `route` when it differs from `prompt`, so a route-only
    handoff still ranks draft + intent at send (today's v1 behaviour) when Jev was unavailable.
    Invariant: for the same (text, transcript, catalogue), the hook given this handoff renders the same
    rows, in the same order, under the same header, as it would have had its own thread returned
    `r["result"]`."""
    raise NotImplementedError


# ── main(): the three edits (:3052-3249) ────────────────────────────────────────────────────────

def main() -> int:
    """Unchanged contract. Three edits, in place:

    (a) :3061  `_hand = _handoff(sid, prompt)` replaces `_hinted = _route_hint(sid, prompt)`; consumed first,
               as today, so a lane-ended turn still spends the file.
    (b) :3065-3104  the six inline lanes become
               `lane = _early_lane(prompt, data)` followed by the same per-lane inject + _append_offer pairs.
    (c) :3110-3112  `if _hand: route = _hand["route"]; if route: _VIA.update(via="enhancer", q=prompt[:120],
               rq=route[:120]); prompt = route; else: _VIA.update(via="enhancer", q=prompt[:120])`
        :3123  `_jev_job = None if _hits else (_jev_handed(_hand and _hand.get("jev"), prompt) or
               _jev_start(prompt, data.get("transcript_path") or ""))`
    Everything from the embed step on is byte-identical. The offer row gains nothing new at the top
    level: `via` as today, `rq` only when a route differed, and `jev.src == "handoff"` + `jev.age_ms`
    inside the existing `jev` telemetry (:1399-1400). An enforcer.py commit starts a new epoch
    (AGENTS.md, Ledger metrics are EPOCH-SCOPED); `via` and `jev.src` split the handed rows from the rest."""
    raise NotImplementedError


# ── __main__ (:3252-3271) ────────────────────────────────────────────────────────────────────────
#
#   if "--selftest" in sys.argv: ...unchanged...
#   if "--prepare" in sys.argv:
#       raw = sys.stdin.read(); data = json.loads(raw) if raw.strip() else {}
#       try: sys.stdout.write(json.dumps(_prepare(data if isinstance(data, dict) else {}), allow_nan=False))
#       except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, UnicodeError, OverflowError):
#           sys.stdout.write(json.dumps({"handoff": None, "view": {"kind": "none", "why": "jev_failed"}}))
#       sys.exit(0)        # a prepare never fails loudly: the mod shows nothing and the hook routes at send
#   _rc = main(); ...unchanged _DEFERRED tail...
