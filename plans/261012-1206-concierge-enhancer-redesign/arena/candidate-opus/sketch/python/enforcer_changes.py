"""Sketch of the changes to hooks/scripts/enforcer.py. Only new or changed signatures; everything
not shown keeps its current body. Line numbers refer to today's file.

Summary
- One new stdin field, `speculate`, turns a run into a speculative run: the same main(), the same
  lanes, retrieval, Jev route, gates, annexes and renderer, under the real session id and
  transcript, with three differences: it writes no ledger row (forced, not left to the caller's
  env), it reads no ticket, and it writes one (offer_ticket.open_ticket / settle).
- The hook path reads the ticket for exactly the sent text (offer_ticket.find) and, when its Jev
  job starts, redeems it inside the worker thread before (and instead of) asking Jev live.
- `_route_hint` and its v0.67.0 file format are deleted: the ticket carries the intent line, so
  there is one mod-to-hook channel, written by Python alone.
- Deterministic routes match the SENT text only: a skill name the intent writer produced is not
  the author's explicit intent and must not pin a row at 1.0.
- New flag ENFORCER_TICKET (default ON). `=0`: speculative runs open no ticket and the hook reads
  none, so every turn ranks live exactly as before this change (the mod's preview still shows).
  Hook-side, so it stays out of ENGINE_ENV_KEYS; it joins the AGENTS.md runtime-flags table and
  docs/runtime-flags.md (driftcheck checks the three agree).
"""
from __future__ import annotations

import offer_ticket

TICKET = os.environ.get("ENFORCER_TICKET", "1") != "0"

# One process = one turn, as `_JEV_EVENT` already assumes.
_SPECULATING = False      # set once in main() from stdin; never from the environment
_SPEC_PREVIEW: dict = {}  # what a speculative run decided, for skillConciergeSpeculation


# ── deleted ────────────────────────────────────────────────────────────────────────────────────
# ROUTE_HINTS, ROUTE_HINT_TTL, _route_hint(sid, prompt)            (enforcer.py:1232-1263)
# tests/test_enforcer_route_hint.py is replaced by tests/test_offer_ticket.py.


# ── changed ────────────────────────────────────────────────────────────────────────────────────

def _append_offer(sid: str, band: str, offered: list, fallback, q: str, **kw) -> None:
    """Unchanged contract, one added rule: a speculative run behaves as ENFORCER_LEDGER=defer
    whatever the environment says, so no speculative run can ever add an offer row (the turn's one
    row is the hook's). Also records the speculative preview (`_SPEC_PREVIEW`) from `band` and
    `offered`, because every exit path of main() already passes through here."""
    raise NotImplementedError


def _offer_ev(sid, band, offered, fallback, q, dropped=None, embed_ms=None, qdrant_ms=None,
              ext=None, xh=None, n_intents=None, route=None, hint=None, pulled=None) -> dict:
    """Unchanged signature. `_VIA` now carries, on a ticketed turn:
    via="enhancer", q = the prompt as sent (pairing with ledger.py's turn row on (sid, q) is kept),
    rq = the ranked text (only when the ticket held an intent line), and spec = the Redemption's
    telemetry {st, age_ms, wait_ms, n, intent}. A served ticket's `jev` event carries src="ticket";
    its `ms` is the speculative run's routing time, so Jev latency analyses split on `src`."""
    raise NotImplementedError


def _jev_route(prompt: str, transcript_path: str, sink: dict | None = None,
               deadline: float | None = None) -> dict:
    """Unchanged, plus `deadline` (absolute epoch seconds; default t0 + JEV_BUDGET_S, today's
    value). A live route that starts after a ticket miss gets only the time left, so the whole
    Jev leg of a turn never exceeds today's budget."""
    raise NotImplementedError


def _jev_start(prompt: str, transcript_path: str, ticket: offer_ticket.Ticket | None = None):
    """Start the Jev leg in a daemon thread; returns (thread, box, deadline) as today, deadline
    unchanged (start + JEV_BUDGET_S).

    With a ticket, the worker first computes this turn's context fingerprint
    (`_jev_context(transcript_path)`) and env fingerprint, then calls
    offer_ticket.redeem(ticket, ctx=..., env=..., until=deadline):
    - a verdict -> box = {"result": verdict.result,
                          "event": {**verdict.event, "src": "ticket"}, "spec": spec}; no Jev call;
    - a miss    -> box["spec"] = spec, then box.update(_jev_route(prompt, transcript_path, box,
                   deadline=deadline)), the live route with the budget that is left.
    Without a ticket: exactly today's behavior."""
    raise NotImplementedError


def _jev_join(job):
    """Unchanged, plus: copies box["spec"] into `_VIA["spec"]` (main thread), and in a speculative
    run calls offer_ticket.settle(sid, sent, Verdict(result, event) or None) once the job joined,
    so the ticket is final by the run's own deadline whatever path main() takes next
    (`_fallback`, jev_skip, the gates, or the menu). `sid`/`sent` ride in the job tuple."""
    raise NotImplementedError


def main() -> int:
    """Changed lines only (pseudocode against today's 3052-3249):

        data = json.loads(stdin)
        prompt = (data.get("prompt") or "").strip(); sid = data.get("session_id", "")
        spec_req = data.get("speculate")
        global _SPECULATING
        _SPECULATING = isinstance(spec_req, dict) and _SID_RE.match(sid or "") is not None
        transcript = data.get("transcript_path") or (
            offer_ticket.find_transcript(sid) if _SPECULATING else "")
        # replaces `_hinted = _route_hint(sid, prompt)` (3061); read-only, before the lanes
        ticket = offer_ticket.find(sid, prompt) if (TICKET and not _SPECULATING) else None

        ... empty / slash / short / harness / refusal / consult / self-reference lanes:
            unchanged, judging the prompt as sent ...

        sent = prompt
        intent = (str(spec_req.get("intent") or "")[:offer_ticket.MAX_INTENT_CHARS] if _SPECULATING
                  else (ticket.intent if ticket else ""))
        if ticket or (_SPECULATING and intent):
            _VIA.update(via="enhancer", q=sent[:120], **({"rq": ...} if intent else {}))
        prompt = offer_ticket.route_text(sent, intent)          # == sent when no intent

        _hits = _route_hits(sent, KEEPOFF)                     # CHANGED: the author's words only
        will_route = not _hits and JEV_ROUTER and _is_english(prompt)
        if _SPECULATING and TICKET:
            offer_ticket.open_ticket(sid, sent, intent, ranking=will_route,
                                     ctx=offer_ticket.fingerprint_ctx(*_jev_context(transcript)),
                                     env=offer_ticket.fingerprint_env(RUNNING_HARNESS, os.environ),
                                     deadline=time.time() + JEV_BUDGET_S,
                                     n=int(spec_req.get("n") or 0))
        _jev_job = _jev_start(prompt, transcript, ticket) if not _hits else None

        ... embed, retrieve, filters, Jev join, gates, annexes, render: unchanged ...

    At exit (`__main__`), a speculative run adds to `_DEFERRED`:
        "skillConciergeSpeculation": {"v": 1, "ticket": "ranking"|"ranked"|"unranked"|None,
                                      "preview": _SPEC_PREVIEW}
    where preview = {"kind": "menu", "skills": [shown names in the order `_ranked_mandate`
                                                renders them, i.e. `_intent_plan(shown)[0]`],
                     "whole_shelf": bool(_jev_rows)} for band "offer";
                    {"kind": "no-skill"} for jev_skip / getaway / intent_skip;
                    {"kind": "consult"} for consult_route; {"kind": "silent"} otherwise.
    `whole_shelf` is the same boolean `_ranked_mandate` receives, so the status line's
    "(preview)" mark and the model's header can never disagree."""
    raise NotImplementedError
