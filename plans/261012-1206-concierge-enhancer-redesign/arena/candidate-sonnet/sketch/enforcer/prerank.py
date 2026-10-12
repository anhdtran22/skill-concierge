"""prerank.py: the store for a menu ranked ahead of the turn (sketch, bodies not implemented).

Lives beside enforcer.py in hooks/scripts/. Stdlib only, Python 3.9 safe (`from __future__ import
annotations`, no runtime `X | Y`, no `match`). It knows nothing about Jev, Qdrant or rendering: it owns
exactly one thing, the *pre-ranked verdict* file, and the rules for when such a file may be believed.

Why a beside-module and not more lines in enforcer.py: the hook script runs as `__main__`, so Python
recompiles it on every prompt; this module is imported, so its bytecode is cached. enforcer.py imports it
inside a try block: when this file is missing the feature is off and the hook behaves exactly as it did
before the feature existed (tests/test_prerank.py::test_missing_module_keeps_the_menu).

OWNERSHIP (one owner per fact)
  * artifact schema, file names, TTL, atomic write, the sweep ........... this module
  * the route text (draft + intent) and the state key ................... this module (route_text, state_key)
  * which Jev result may be stored, when a stored result may be served .. enforcer.py (it owns Jev)
  * the intent line itself ............................................... the mod (it owns a text model)
The mod never opens these files; it reads the one-line JSON readout that `enforcer.py --prerank` prints.

FILES  (all under DIR, mode 0600, one per sent-text digest so two drafts never overwrite each other)
  <sid>.<digest>.json      the artifact (below), written atomically by publish()
  <sid>.<digest>.pending   {"t": epoch, "pid": int}: a prerank for this text is running (mark_pending)
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import time
from pathlib import Path
from typing import List, NamedTuple, Optional, Tuple

try:                                    # 3.8+: typing.TypedDict
    from typing import TypedDict
except ImportError:                     # pragma: no cover
    TypedDict = dict                    # type: ignore

SCHEMA = 1
DIR = Path.home() / ".claude" / "skill-concierge" / "preranks"
TTL_S = 300             # an artifact older than this is never served (the draft's context has moved on)
ADOPT_MAX_S = 3.0       # most a hook waits for a prerank already running for its exact text
SWEEP_S = 3600          # publish() deletes any file here older than this
_SID_RE_SRC = r"^[A-Za-z0-9_-]{1,128}$"

Row = Tuple[str, str, float]            # (skill name, description, probability): the shape _jev_route returns


class Artifact(TypedDict):
    """One pre-ranked Jev verdict. Written once, claimed once.

    Invariants (validate() enforces every one; a violation is a miss, never an error):
      v == SCHEMA; t finite and within TTL_S of now; prompt == the stripped text the hook receives;
      route == route_text(prompt, intent, cap); skey == state_key(route, prev, skills) for the
      conversation state the ranking saw; stage == "full" (a wide-only ranking is never stored: the live
      hook has a better chance at a full one); verdict "skip" carries no rows.
    """
    v: int
    sid: str
    t: float
    prompt: str
    intent: Optional[str]
    route: str
    skey: str
    verdict: str                        # "offer" | "skip"
    rows: List[list]                    # [[name, desc, p], ...] (offer only)
    pulled: List[list]                  # ADR-0083 owner-badged rows under the ranking
    best: Optional[float]
    event: dict                         # the _jev_route telemetry event, verbatim (stage == "full")
    intent_used: bool


class Claim(NamedTuple):
    """What a hook finds for its exact text. At most one of the three is meaningful."""
    artifact: Optional[Artifact]        # validated, already unlinked
    pending_t: Optional[float]          # a prerank for this text started at this epoch time and has not finished
    miss: Optional[str]                 # "ttl" | "schema" | "prompt" | None (nothing stored: no mod, or draft changed)


def digest(prompt: str) -> str:
    """16 hex chars of sha1(prompt.strip()). The file key. Same text, same key, on both sides."""
    raise NotImplementedError


def route_text(prompt: str, intent: Optional[str], cap: int) -> str:
    """The text Jev ranks. No intent: the stripped prompt. With intent: `prompt[:cap - len(intent) - 2]
    + "\\n\\n" + intent`, so the intent survives a draft longer than the router's request cap (the A/B shape,
    raw draft then intent line, for every draft that fits). Pure. The ONLY place this is composed."""
    raise NotImplementedError


def state_key(route: str, prev: str, skills: List[str]) -> str:
    """sha1 over (route[:cap], last assistant text tail, last loaded skills): everything `_jev_route`
    puts in the Jev `state` (request, recent_context, skills_already_loaded_this_session). Two equal keys
    mean a cold run would send Jev the same state. Pure."""
    raise NotImplementedError


def find_transcript(sid: str, cwd: str, config_dir: Optional[str] = None) -> str:
    """The session transcript path ('' when not found), so a prerank sees the context the hook will see.
    Tries projects/<cwd with non-alnum -> '-'>/<sid>.jsonl, then projects/*/<sid>.jsonl. A miss only
    means a cold context: the key will not match and the hook ranks live."""
    raise NotImplementedError


def mark_pending(sid: str, prompt: str, now: Optional[float] = None) -> None:
    """Write <sid>.<digest>.pending {t, pid} before the Jev call starts. Fail-silent."""
    raise NotImplementedError


def clear_pending(sid: str, prompt: str) -> None:
    """Remove the marker (always, in a finally). Fail-silent."""
    raise NotImplementedError


def publish(sid: str, art: Artifact, now: Optional[float] = None) -> None:
    """Atomic write (tmp in DIR, os.replace) of <sid>.<digest(art.prompt)>.json, mode 0600, then sweep
    files older than SWEEP_S. Clears the pending marker. Fail-silent: a full disk costs the speed-up only."""
    raise NotImplementedError


def claim(sid: str, prompt: str, now: Optional[float] = None) -> Claim:
    """Hook side, one call, no waiting. Consumes (unlinks) the artifact whether or not it validates, so
    nothing outlives the prompt it was made for. sid failing _SID_RE_SRC, a missing DIR (no mod ever
    ran: one stat) or any OSError -> Claim(None, None, None). Never raises."""
    raise NotImplementedError


def wait(sid: str, prompt: str, until: float, now=time.time, sleep=time.sleep) -> Optional[Artifact]:
    """Poll claim() every 40 ms until an artifact validates, `until` passes, the marker disappears with no
    artifact (the prerank failed or was skipped), or the marker's pid is dead. Used by the hook's worker
    thread only, so the embed and Qdrant legs run meanwhile."""
    raise NotImplementedError


def validate(art: object, prompt: str, now: float) -> Optional[str]:
    """None when `art` may be served for `prompt`; else the miss reason. Pure; the one list of checks."""
    raise NotImplementedError
