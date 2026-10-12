"""Changes to hooks/scripts/enforcer.py (sketch: signatures, invariants and pseudocode, not a patch).

Line numbers are enforcer.py as read on 2026-10-12. Nothing here touches hooks/hooks.json.

DELETED in the same change (red flag "two ways to do one task"):
  ROUTE_HINTS, ROUTE_HINT_TTL, _SID_RE, _route_hint (1232-1263), the `_hinted` branch in main()
  (3108-3112), `_VIA` and its `ev.update(_VIA)` in _offer_ev (1359-1401), tests/test_enforcer_route_hint.py.
  A mod 0.67.0 that still writes route-hints/<sid>.json is simply ignored (its hint can no longer be read).
"""
from __future__ import annotations

# ── 0. import, flag ────────────────────────────────────────────────────────────────────────────────
try:                                   # a stripped install loses the speed-up, never the menu
    import prerank as _prerank_store
except ImportError:                    # pragma: no cover
    _prerank_store = None

# Hook-side and mod-side kill switch. Query-time/hook flag: NOT in ENGINE_ENV_KEYS (it shapes no index).
# =0: --prerank prints {"status": "skipped", "reason": "off"}; the hook neither claims nor waits.
PRERANK = os.environ.get("ENFORCER_PRERANK", "1") != "0" and _prerank_store is not None   # noqa: F821

_PRE: dict = {}      # this turn's `pre` block for the offer row; empty = the row is byte-identical to today's


# ── 1. the early lanes become one pure function ───────────────────────────────────────────────────
def _early_lane(prompt: str, data: dict) -> "str | None":
    """The name of the lane that ends a turn before any embed, Qdrant or Jev work, else None.

    Names, in main()'s historical order: "empty", "slash", "short" (<= MAX_SHORT_WORDS words),
    "harness" (HARNESS_SKIP and _HARNESS_MSG_RE), "refusal" (_REFUSAL_RE), "consult" (CONSULT_ROUTE,
    no agent_id, _CONSULT_RE and not _CONSULT_NEG_RE), "selfref" (SELFREF_SKIP and _is_selfref).
    Pure: no I/O, no ledger row, no injection. main() calls it once and performs each lane's side effect;
    `--prerank` calls it to learn that a draft would not reach Jev. One order, one place.
    """
    raise NotImplementedError


# ── 2. hook side: claim, serve, adopt ─────────────────────────────────────────────────────────────
def _pre_claim(sid: str, prompt: str) -> "_prerank_store.Claim":
    """First thing in main() (replaces `_route_hint`, 3061). Consumes any artifact for this exact text so
    it never outlives the turn it was made for, even when an early lane ends the turn. Records nothing in
    `_PRE` here. Returns Claim(None, None, None) when PRERANK is off, the sid is malformed or no mod ever
    ran (a single stat of preranks/). Never raises."""
    raise NotImplementedError


def _pre_serve(art: dict, prompt: str, transcript_path: str, waited_ms: int) -> "dict | None":
    """Turn an artifact into the box `_jev_route` would have returned, or None (and fill `_PRE["why"]`).

    Served only when ALL hold (any failure is a miss, the live route then runs as it always did):
      1. JEV_ROUTER and _is_english(art["route"])          (the same gate _jev_route applies)
      2. art["prompt"] == prompt                           (prerank.validate already checked TTL, schema)
      3. art["skey"] == state_key(art["route"], *_jev_context(transcript_path))
         i.e. a cold run would send Jev the SAME state: the assistant's last message and the loaded
         skills have not moved since the ranking was made.
    Returns {"result": (verdict, rows, best, pulled), "event": art["event"]} and sets
      _PRE = {"hit": True, "age_ms", "waited_ms", "intent": art["intent_used"]}
    so `jev.ms` on that row is the ranking's compute time, NOT the wait the user felt (`pre.waited_ms`).
    """
    raise NotImplementedError


def _jev_start(prompt: str, transcript_path: str, pre: "_prerank_store.Claim | None" = None):
    """CHANGED: same return shape (thread, box, deadline) so `_jev_join` is untouched.

    The worker thread now runs, in order:
      1. pre.artifact  -> _pre_serve(...)                                   (instant)
      2. pre.pending_t -> _prerank_store.wait(sid, prompt, until=min(pending_t + ADOPT_MAX_S, deadline))
                          then _pre_serve(...)                              (adopt a ranking in flight)
      3. otherwise, or on any miss -> _jev_route(prompt, transcript_path, box)   (today's path, unchanged,
         still bounded by the original deadline; step 2 can spend at most ADOPT_MAX_S of it)
    On a miss with an artifact or marker present, `_PRE = {"hit": False, "why": <reason>}`; with neither,
    `_PRE` stays empty and the row is the row of a session with no mod.
    """
    raise NotImplementedError


# main() after the change (pseudocode, only the touched lines):
#
#   sid = data.get("session_id", "")
#   _claim = _pre_claim(sid, prompt)                          # was: _hinted = _route_hint(sid, prompt)
#   lane = _early_lane(prompt, data)
#   if lane in ("empty", "slash", "short"): return 0
#   if lane == "harness": ...unchanged body...; return 0
#   if lane == "refusal": ...unchanged body...; return 0
#   if lane == "consult": ...unchanged body...; return 0
#   if lane == "selfref": ...unchanged body...; return 0
#   # (the `if _hinted:` block is gone)
#   _hits = _route_hits(prompt, KEEPOFF)
#   if _hits and (_claim.artifact or _claim.pending_t): _PRE.update(hit=False, why="named")
#   _jev_job = _jev_start(prompt, tp, pre=_claim) if not _hits else None
#   ... embed, Qdrant, filters, _jev_join, gates, render: unchanged ...
#
# _offer_ev: replace `ev.update(_VIA)` with `if _PRE: ev["pre"] = dict(_PRE)`; when the artifact's intent
# was used also set ev["rq"] = art["route"][:120] (q stays the prompt as sent, so (sid, q) pairing holds).


# ── 3. the new mode ───────────────────────────────────────────────────────────────────────────────
def _prerank_run(data: dict) -> dict:
    """Rank a draft that has not been sent. Returns the readout dict that main-line code prints.

    stdin shape: {"prompt": str, "intent": str|None, "session_id": str, "cwd": str,
                  "transcript_path": str|None}.
    Steps (every early return is a *skipped* readout; nothing here ever blocks a prompt, since the hook
    for the real prompt is a different process):
      1. PRERANK off or sid invalid                       -> skipped "off"
      2. lane = _early_lane(prompt, data); lane set       -> skipped "lane"
      3. prompt matches _JEV_SECRET_RES (1580)            -> skipped "secret"   (an unsent draft must not
         carry a credential to Jev; the live hook sends what the user chose to send, this does not)
      4. _route_hits(prompt, KEEPOFF)                     -> skipped "named"    (a named skill never asks Jev)
      5. route = _prerank_store.route_text(prompt, intent, JEV_MAX_CHARS)
         not (JEV_ROUTER and _is_english(route))          -> skipped "language"
      6. tp = data.transcript_path or _prerank_store.find_transcript(sid, cwd)
         prev, skills = _jev_context(tp); skey = state_key(route, prev, skills)    (read BEFORE the call)
      7. _prerank_store.mark_pending(sid, prompt); try: out = _jev_route(route, tp) finally: clear_pending
      8. out["result"] is None                            -> failed (reason = event.err), no artifact
         out["event"]["stage"] != "full"                  -> skipped "not-full", no artifact
         else publish Artifact(...), return ready.
      9. append one ledger row {"ev": "prerank", sid, d: digest, status, reason?, ms, intent, stage, tier}
         unless ENFORCER_LEDGER == "0". No "offer" row is ever written by this mode, and nothing is
         printed in the hook's hookSpecificOutput shape.
    ready readout (key names are the skillConciergeOffer vocabulary, a subset of it):
      {"status": "ready", "band": "offer" | "jev_skip",
       "offered": [[name, round(p, 4)], ...] (the Jev rows, <= 5), "jev": {"stage": "full", "ms": int}}
    others: {"status": "skipped", "reason": str} | {"status": "failed", "reason": str}
    """
    raise NotImplementedError


def _prerank_main() -> int:
    """`enforcer.py --prerank`: read stdin JSON, print `json.dumps(_prerank_run(data))`, return 0 always.
    Dispatched from the `__main__` block before main():  _rc = _prerank_main() if "--prerank" in sys.argv else main()
    """
    raise NotImplementedError


def _append_ev(ev: dict) -> None:
    """The ledger writer `_append_offer` already contains (1340-1356), factored out so the prerank row and
    the offer row share one writer and one failure policy (fail-silent, ENFORCER_LEDGER=0 writes none)."""
    raise NotImplementedError
