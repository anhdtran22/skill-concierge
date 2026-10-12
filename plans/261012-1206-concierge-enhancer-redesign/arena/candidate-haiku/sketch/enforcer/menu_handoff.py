"""Sketch: pre-ranked offer handoff (new sibling module of hooks/scripts/enforcer.py).

enforcer.py already imports its sibling `harness.py` this way, so this module follows the
same pattern. It owns every freshness check for a menu the concierge-enhancer mod computed
while the author was typing. Nothing else in the codebase checks freshness.

Invariants:
- A menu is served only for the exact prompt it was ranked for (prompt equality after strip),
  on the same transcript tail (fingerprint equality), within its own ttl_s, and only when
  ENFORCER_MENU_HANDOFF is not "0".
- The hint file is one-shot: take_hint removes it whenever the file parses or is unreadable.
- A failed check never raises. It returns the normal path (None / False).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
from pathlib import Path

# Kill switch, one variable. "0" makes the enforcer ignore `menu` and still honour `route`.
MENU_HANDOFF = os.environ.get("ENFORCER_MENU_HANDOFF", "1") != "0"

ROUTE_HINTS = Path.home() / ".claude" / "skill-concierge" / "route-hints"
HANDOFF_TTL_S = 300  # the one TTL. The enforcer sends it to the mod as `ttl_s`; the mod never repeats it.
_SID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_TAIL_BYTES = 8192


def resolve_transcript(sid: str) -> str:
    """Path of the session transcript (~/.claude/projects/<dir>/<sid>.jsonl), or '' when none exists.

    Invariant: `sid` matches _SID_RE before any glob, so no path segment can escape projects/.
    The mod does not know the transcript path, so the enforcer resolves it by session id.
    """
    raise NotImplementedError


def transcript_fingerprint(path: str) -> str:
    """sha256 hex of the last two non-empty lines within the final _TAIL_BYTES bytes; '' when unreadable.

    Invariant: an unchanged tail gives the same value. Any appended user or assistant record changes it,
    so a menu ranked before a new turn is never served after it.
    """
    raise NotImplementedError


def take_hint(sid: str, prompt: str) -> dict | None:
    """Read and delete ROUTE_HINTS/<sid>.json. Returns the parsed object when it is a fresh hint for `prompt`.

    Returns None when: the file is absent or not a JSON object; hint["prompt"].strip() != prompt.strip();
    hint["t"] is not a finite number; or abs(now - t) > HANDOFF_TTL_S. Invariant: the file is removed
    whenever it parsed or was unreadable (one-shot). Never raises. A `route` without a `menu` is still
    returned, so the route path keeps working when the menu is absent.
    """
    raise NotImplementedError


def menu_is_current(menu: object, sent: str, fingerprint: str) -> bool:
    """True when `menu` is an enforcer precompute output that may be served for `sent` right now.

    Checks: dict; a NON-EMPTY fingerprint equal to menu["fp"] (an empty one, meaning no transcript found,
    is never current, or a missing transcript at both times would match itself); menu["prompt"] == sent
    (after strip); a non-empty string at menu["hookSpecificOutput"]["additionalContext"]; a dict at
    menu["skillConciergeOffer"]; and time.time() - menu["built_at"] <= min(menu["ttl_s"], HANDOFF_TTL_S).
    Never raises.
    Invariant: a shape it does not recognise is False, so the normal path runs.
    """
    raise NotImplementedError
