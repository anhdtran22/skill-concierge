"""The draft-time ticket: the one channel from a speculative enforcer run to the hook that serves
the same prompt (sketch for hooks/scripts/offer_ticket.py).

The concierge-enhancer mod spawns `enforcer.py` with a `speculate` request while the user types.
That run writes a ticket: the Jev verdict it reached for that exact draft, under the context it
read. When the user sends that exact text, the UserPromptSubmit hook redeems the ticket instead of
asking Jev again, so the model reads the ranking the user saw, computed once, before Enter.

This module owns everything about a ticket: where it lives, its format, its validation and its
lifecycle. Nothing else reads or writes the file; the mod never sees it.

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

import os
from pathlib import Path
from typing import NamedTuple, Optional

TICKET_VERSION = 1
# v0.67.0's route hints lived here as `<sid>.json`; tickets take a new name so no old file parses.
TICKET_DIR = Path.home() / ".claude" / "skill-concierge" / "route-hints"
TICKET_SUFFIX = ".ticket.json"
TICKET_TTL_S = 900        # a draft can sit settled for minutes; the context and env checks carry the rest
POLL_S = 0.05             # how often `redeem` re-reads a ticket whose run is still ranking
LATE_GRACE_S = 0.3        # past a ranking ticket's own deadline, its run is late, not slow
MAX_INTENT_CHARS = 600


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


class Redemption(NamedTuple):
    """What the hook gets back: the verdict to serve, or None (rank live), and the ledger's `spec`
    telemetry, always: {"st": ready|waited|stale|env|dead|late|unranked, "age_ms", "wait_ms", "n",
    "intent": bool}."""
    verdict: Optional[Verdict]
    spec: dict


def route_text(sent: str, intent: str) -> str:
    """The text concierge ranks for a prompt: the author's own words, then the intent line on its
    own paragraph (the A/B's best arm, raw + intent). The sent text alone when there is no intent.
    The single definition used by the speculative run and the hook alike."""
    raise NotImplementedError


def fingerprint_ctx(prev: str, skills: list) -> str:
    """SHA-256 (hex, 16 chars) of what Jev reads besides the request: the last assistant text and
    the skills already loaded, exactly as enforcer._jev_context returns them. A ticket made under
    another context (a turn ran in between) never matches."""
    raise NotImplementedError


def fingerprint_env(harness: str, environ: dict) -> str:
    """SHA-256 (hex, 16 chars) of the settings that shape a ranking: `harness` (the detected
    RUNNING_HARNESS, not SKILL_CONCIERGE_HARNESS, which only the speculative run sets), every
    ENFORCER_* and SKILL_* value except SKILL_CONCIERGE_HARNESS and ENFORCER_LEDGER, JEVD_URL, and
    the PRESENCE (never the value) of TYPESAFE_API_KEY, CMD_API_KEY and FLYWHEEL_LLM_API_KEY.
    A mod whose child environment differs from the hook's (grounding D8) is caught here, per
    turn, and shows in the ledger as spec.st = "env"."""
    raise NotImplementedError


def find_transcript(sid: str) -> str:
    """The session's transcript path for a speculative run, which the mod API cannot supply:
    `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<sid>.jsonl`, the newest match; '' when the sid is
    not a plain name or no file exists yet (a session's first prompt). A wrong or missing path
    only costs the ticket: its context fingerprint will not match the hook's."""
    raise NotImplementedError


def open_ticket(sid: str, sent: str, intent: str, *, ranking: bool, ctx: str, env: str,
                deadline: float, n: int) -> None:
    """Called by a speculative run once the early lanes passed and the ranked text is fixed.
    Writes state "ranking" when Jev is about to start, else "unranked" (named skill, non-English,
    router off: the hook will rank route_text itself, quickly). Atomic (temp file + os.replace).
    Also prunes this directory's ticket and old route-hint files older than TICKET_TTL_S, so the
    writer is the only cleaner. Fail-silent."""
    raise NotImplementedError


def settle(sid: str, sent: str, verdict: Optional[Verdict]) -> None:
    """Called by the speculative run when its Jev job joined (the same `_jev_join` deadline the
    hook uses). Rewrites the ticket for the same sent-text hash as "ranked" with the verdict, or
    "unranked" when Jev gave none. Never overwrites a ticket for another text (a newer run owns
    the file then). Atomic, fail-silent."""
    raise NotImplementedError


def find(sid: str, sent: str) -> Optional[Ticket]:
    """The hook's first read, before the early lanes: the ticket for exactly this sent text
    (SHA-256 of the stripped prompt), this sid, version TICKET_VERSION, younger than TICKET_TTL_S,
    with finite numbers and an intent no longer than MAX_INTENT_CHARS. None for anything else,
    including a malformed, deeply nested or oversized file. Read-only."""
    raise NotImplementedError


def redeem(ticket: Ticket, *, ctx: str, env: str, until: float) -> Redemption:
    """Runs in the hook's Jev worker thread. Returns at once with a miss when `env` or `ctx` differ
    from the ticket's ("env", "stale") or the ticket is "unranked". Returns the verdict at once
    when "ranked" ("ready"). When "ranking": re-reads the file every POLL_S until it is ranked
    ("waited"), unranked, its run's pid is gone ("dead"), its own deadline + LATE_GRACE_S passed
    ("late"), or `until` (the hook's own Jev deadline) passed. Never sleeps past `until`."""
    raise NotImplementedError
