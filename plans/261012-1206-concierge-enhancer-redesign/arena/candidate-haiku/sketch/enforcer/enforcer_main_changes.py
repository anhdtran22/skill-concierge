"""Sketch: the changes to hooks/scripts/enforcer.py. Pseudocode for main() and the new helpers.

Not runnable. It shows where each change lands (enforcer.py line numbers from the current tree)
and the signatures and invariants the implementation must keep. Net change: about 60 lines.
The ranking body of main() is untouched, so the normal path is byte-identical (golden test P12).
"""
from __future__ import annotations

import sys
import time

from menu_handoff import (  # sibling import, as `from harness import running_harness` already is
    HANDOFF_TTL_S,
    MENU_HANDOFF,
    menu_is_current,
    resolve_transcript,
    take_hint,
    transcript_fingerprint,
)

# Module state set at the top of main() and read by the __main__ block: the stage-2 stamp.
_PRECOMPUTE: dict = {}


def _inject_text(text: str) -> None:
    """Emit the model's additionalContext. Factored from _inject (enforcer.py:1408-1413), same behaviour.

    Invariant: under ENFORCER_LEDGER=defer it writes into _DEFERRED, never stdout; otherwise one JSON line to stdout.
    """
    raise NotImplementedError


def _write_offer_event(ev: dict) -> None:
    """Write one offer row. Factored from the writer half of _append_offer (enforcer.py:1340-1356), same behaviour.

    Invariant: ENFORCER_LEDGER=0 writes nothing; defer puts the row into _DEFERRED["skillConciergeOffer"];
    otherwise it appends one JSON line to the ledger. Fail-silent, as today.
    """
    raise NotImplementedError


def _serve_menu(sid: str, sent: str, menu: dict) -> int:
    """Replay a current precomputed menu for the sent prompt. The ranking does not run.

    Invariant: additionalContext is the stored text, byte for byte. The row is the stored offer row
    with three keys changed: t (now), via ("precomputed") and q (the sent text, first 120 chars, so
    ledger.py's turn row still pairs on (sid, q)). lead_ms records how long before submit it was ready.
    """
    now = time.time()
    ev = {**menu["skillConciergeOffer"], "t": round(now, 3), "via": "precomputed",
          "q": sent[:120], "lead_ms": int((now - float(menu["built_at"])) * 1000)}
    _inject_text(menu["hookSpecificOutput"]["additionalContext"])
    _write_offer_event(ev)
    return 0


def _stamp_precompute() -> None:
    """Called from the __main__ block in precompute mode. Adds the fields the mod stores and checks.

    Adds: prompt (the stdin prompt), fp (the value taken at the start of main), built_at (seconds),
    ttl_s (HANDOFF_TTL_S). Invariant: runs for stage 1 and stage 2 outputs alike.
    """
    if _PRECOMPUTE:
        _DEFERRED.update(prompt=_PRECOMPUTE["prompt"], fp=_PRECOMPUTE["fp"],
                         built_at=time.time(), ttl_s=HANDOFF_TTL_S)


# --- main() -------------------------------------------------------------------------------------
# (1) Replaces `_hinted = _route_hint(sid, prompt)` at enforcer.py:3061. Same position: first, so a hint
#     never outlives the prompt it was left for, even one an early lane ends.
def _main_head_sketch(data: dict, prompt: str, sid: str):
    precompute = bool(data.get("precompute"))
    # Taken before anything else in precompute mode, so the fingerprint names the transcript that was ranked.
    fp = transcript_fingerprint(resolve_transcript(sid)) if precompute else ""
    if precompute:
        _PRECOMPUTE.update(prompt=prompt, fp=fp)
    # Precompute never consumes the real hint file: the mod is building a menu, not submitting one.
    hint = None if precompute else take_hint(sid, prompt)
    route = data.get("route") if precompute else (hint or {}).get("route")
    return hint, route


# (2) After the early lanes (enforcer.py:3065-3104), before `if _hinted:` (3108). Two new branches.
def _main_after_lanes_sketch(data, prompt, sid, hint, route, precompute):
    # Stage 1 stops here: the lanes ran, and the mod must now supply a route (it runs the intent step).
    if precompute and not route:
        return "stage1"  # the caller emits `_DEFERRED["needs_route"] = True` and returns 0

    # Serve a precomputed menu when it is current for the SENT text. Freshness has one owner: menu_is_current.
    if hint and MENU_HANDOFF and menu_is_current(hint.get("menu"), prompt, transcript_fingerprint(resolve_transcript(sid))):
        return _serve_menu(sid, prompt, hint["menu"])

    # Otherwise the normal path, as today. The route text ranks; the row keeps q as sent.
    if route:
        # _VIA.update(via="enhancer", q=prompt[:120], rq=route[:120]); prompt = route   (enforcer.py:3111-3112)
        pass
    return None  # continue into the unchanged ranking body
