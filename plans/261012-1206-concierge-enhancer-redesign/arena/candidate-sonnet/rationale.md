# Candidate (sonnet): pre-ranked menu

Shape in one line: **the mod ranks your draft while you type, by running concierge's own enforcer ahead of the turn, and the hook that runs on Enter claims that ranking instead of asking Jev again.** The mod draws no band, binds no key and rewrites nothing. One menu, ranked once, by the enforcer.

Labels used below: **Fact** (read in code or doc, with a pointer), **Measured** (a number from grounding.md or run today), **Estimate** (my arithmetic or a guess, not measured), **Judgment**, **Open**.

## Problem

Thinh wants the mod to "enhance & optimize the menu of 5 [concierge] offers initially", integrated with how concierge works, seamless, collision-free, and using Jev through jevd. v0.67.0 did none of that. It copied the prompt-enhancer's band, ranked a *second* menu in a fake session with no transcript (grounding §3 D1-D5), and needed a click.

What makes the shape non-obvious, all from grounding:

- The model's menu is built by a command hook (`enforcer.py`) that no mod can read or rewrite in this build (grounding P3: `classic.UserPromptSubmit` did not fire). The mod can only act *before* it (P5: `prompt.submit` runs first and its `next(e)` waits for the hooks) or *beside* it (P6: `prompt.autocomplete` fires while typing and the engine does not wait on it).
- The hook's cost is Jev. Measured, Claude Code rows since 2026-10-10 23:09: full stage p50 2656 ms, p90 3746 ms, max 6383 ms; wide stage p50 1934 ms; 6 of 531 rows timed out at about 7.05 s (grounding §2). That is the wait between pressing Enter and the model starting, on every turn Jev decides.
- Only `hooks/hooks.json` is frozen. `enforcer.py` and the mod are free, and the only existing mod-to-hook channel (the route-hint file, `enforcer.py:1232-1263`) is one-shot, prompt-keyed and carries route text, not a menu.
- Two ledger facts bind any new mode: offer and turn rows pair on `(sid, q)` with `q` the prompt as sent, and an `enforcer.py` change starts a new epoch (AGENTS.md, ledger rule).
- 81% of hook calls are harness text (428 of 531); drafts typed in the composer are never that. Per-keystroke work on the mod side must stay at constant time.

## Usage (caller's view)

### The person

Install the mod and carry on typing. There is no band and no key. When you pause for a second, one dim line appears under the prompt:

```
Concierge · ui-styling · frontend-design · ak-test · writing-plans · ak-cook
```

It is the five skills concierge will offer the model if you send the text as it stands. Edit the draft and the line goes. Press Enter and the model reads that menu: the same ranking, not a second run. A draft that needs no skill shows `Concierge · no skill needed`. A draft of three words or fewer, a slash command, or non-English text shows nothing and costs nothing beyond one cheap check.

Switches (environment, read once per session): `CONCIERGE_ENHANCER=0` makes the mod a no-op. `CONCIERGE_INTENT=0` ranks the bare draft with no intent line (the control arm for an epoch). `ENFORCER_PRERANK=0` turns the whole feature off on the hook side too, restoring today's hook byte for byte.

### The enforcer, as the mod calls it

```
$ echo '{"prompt":"add a dark mode toggle to the settings page using our ui-kit",
         "intent":"Add a dark mode toggle to the settings page of the ui-kit app.",
         "session_id":"sess-42","cwd":"/work/app"}' | python3 enforcer.py --prerank
{"status":"ready","band":"offer","offered":[["ui-styling",0.4411],["frontend-design",0.2204], ...],"jev":{"stage":"full","ms":2711}}
```

The readout reuses the key names of the `skillConciergeOffer` object that `ENFORCER_LEDGER=defer` already returns (`band`, `offered`, `jev.stage`), so no new vocabulary appears. Other answers: `{"status":"skipped","reason":"lane"}` and `{"status":"failed","reason":"BudgetExceeded"}`.

### The mod's own code

```ts
// register.tsx: the whole public behaviour
on('prompt.autocomplete', ($, e, next) => { if (enabled) schedulerFor($).onEdit(e.text); return next(e) })
on('prompt.submit',       ($, e, next) => { if (e.origin.kind === 'composer') schedulerFor($).onSubmit(); return next(e) })
```

### The hook side

```python
# main(), first thing, replacing _route_hint:
_claim = _pre_claim(sid, prompt)           # consumes any artifact for this exact text
# ...after the no-I/O lanes...
_jev_job = _jev_start(prompt, tp, pre=_claim) if not _hits else None   # same job shape; _jev_join untouched
```

## Shape

### Data structures first

One new durable thing: the **pre-ranked verdict**, a file `~/.claude/skill-concierge/preranks/<sid>.<digest>.json`, where `digest` is sha1 of the stripped text the user will send. It holds `prompt`, `intent`, `route`, `skey`, the Jev verdict (`rows`, `pulled`, `best`, the full `event`) and `t`. The schema and its rules live in one module, `hooks/scripts/prerank.py`, with these properties:

- **Keyed by the sent text.** Two drafts never overwrite each other; the hook finds its artifact by computing a file name, not by scanning. This replaces the route-hint's "one file per session, unlink even on mismatch" with exact-key lookup, which also removes the stale-overwrite race (an old slow prerank finishing after a newer one).
- **Believed only when the Jev state matches.** `skey = sha1(route, last assistant text tail, last loaded skills)`: exactly the three things `_jev_route` puts in the Jev `state` (`enforcer.py:2252-2253`). At serve time the hook re-reads the transcript tail (`_jev_context`, a bounded 256 KB tail read) and compares. Equal key means a cold run would send Jev the same state. If the assistant spoke or a skill loaded since, the artifact is a miss and the live route runs as today.
- **Only full-stage rankings are stored.** A wide-only result (a failed rerank) is dropped: the live hook gets its own chance at a full one and keeps the wide menu as its safety net (ADR-0087).
- **A pending marker** `<sid>.<digest>.pending` `{t, pid}` is written before the Jev call. A hook whose exact text has a live marker *adopts* the run in flight: its worker thread polls for the artifact (40 ms) for at most 3 s, then falls through to the live route with the rest of its 7.8 s budget.
- **One-shot, 300 s TTL, mode 0600, swept hourly, written atomically.**

The route text (what Jev actually ranks) is composed in one place, `prerank.route_text`: `draft + "\n\n" + intent`, with the draft cut to leave room so the intent survives a draft longer than the router's 4000-character request cap (`JEV_MAX_CHARS`). This is the A/B's winning shape (raw draft plus intent line), and the mod no longer composes it (v0.67.0 composed it in TS and sent it through the hint: split ownership).

### How data flows

1. `prompt.autocomplete` → `Scheduler.onEdit(text)`: cancel one timer, arm one timer, clear the status line if shown. Constant time, no I/O.
2. Timer fires after 1000 ms of quiet → read the draft → `worthRanking` (≥ 4 words, not `/…`) → rate cap → one run at a time, latest draft wins.
3. **Intent step** (mod): `$.model.complete` on `haiku` through the session's own client (Max, [72]), ≤ 1200 ms, aborted by any edit. Failure or timeout means no intent, not no ranking.
4. **Rank step** (enforcer): `python3 enforcer.py --prerank` with `{prompt, intent, session_id, cwd}`. It runs `_early_lane`, a secret check, the named-skill check, the language check, then **the same `_jev_route` the hook runs**, with the real transcript (found from `session_id` and `cwd`), the real jevd ladder and the same flags. It publishes the artifact and prints the readout. It writes no offer row and prints no hook payload.
5. Readout → `statusLine` → `$.ui.status`.
6. Enter → `prompt.submit` clears the status; `next(e)` runs the command hooks → `enforcer.py` → `_pre_claim` → the worker thread serves the artifact (or adopts the run in flight, or runs Jev live) → embed and Qdrant still run as before (annex sizing) → `_ranked_mandate(... whole_shelf=True ...)` renders exactly what it renders today → the offer row carries a `pre` block.

### Load-bearing decisions

1. **The ranker stays where it is.** No ranking, rendering or Jev protocol in TypeScript. The mod's two outputs are an intent string in and a status string out. (per boundary-discipline, single source of truth)
2. **The visible Enhance rewrite goes.** Against the owner's goal: his purpose is the menu. The A/B (n = 20, blind judge, modest and not proof) ranked the full rewrite last in 11 of 20 menus and found nothing the rewrite adds to ranking beyond the intent line. The rewrite is the standalone prompt-enhancer's feature, and Thinh may re-enable that; with this design both coexist because this mod owns no `AbovePrompt`, no hotkey and no `prompt.fill`. The one useful by-product of the rewrite, the intent line, survives as a hidden input. If Thinh wants an explicit rewrite action in concierge later, a `/command` is the collision-free place for it; I do not build it now.
3. **The intent line stays, as an input only.** It is the one lever with measured benefit: raw plus intent beat raw 13-7 in round 2 (same-round comparison only; the raw arm itself scored 24 then 15 points across rounds, so the effect is suggestive). It is generated by `haiku` on Max, not the sonnet/fork the A/B used, so **that generator is untested** (Open). Its instructions carry the owner's standing decisions: name only the work and its domain, copy the author's terms verbatim, name no skill, ask nothing.
4. **Jev through jevd without the mod learning jevd.** The enforcer's `_jev_route` already reads jevd's `/ladder` and sends through it, keyless and warm (grounding §2). The mod could call jevd directly (P1) but would then re-implement the SystemOne protocol in a second language. Instead the mod buys jevd's warmth by *starting the call before the user presses Enter*, which is where the latency goes. (per information-hiding)
5. **Truth by construction, with one named gap.** The status line is the artifact's rows; the hook serves those rows if the state key matches. The gap: when the key does not match at Enter (the assistant spoke meanwhile), the hook ranks live and the menu can differ from the line. The ledger records which happened.
6. **Fail open at every seam.** Mod absent, `prerank.py` missing, artifact missing, expired, mismatched, `--prerank` crashed, jevd down: the hook runs exactly today's path. The import of `prerank` is guarded, so a stripped install loses speed, never the menu.

### Interface depth

- **Mod public surface: none to callers.** Two pass-through hooks. Behind them, `createScheduler` hides debounce, gating, in-flight and cap rules, intent handling and parsing behind `onEdit`/`onSubmit`.
- **Enforcer public surface:** one CLI mode, `--prerank`, and one flag. Behind it: lane check, secret check, route composition, context lookup, the Jev call, atomic publish and the ledger row.
- **`prerank.py`:** `claim`, `wait`, `publish`, `mark_pending`, `route_text`, `state_key`, `digest`, `find_transcript`, `validate`. The hook calls `claim` and `wait`; the prerank mode calls the rest.
- **What remains exposed:** `MIN_WORDS` in TS must equal `MAX_SHORT_WORDS + 1` in Python (a test fails the build when they differ); the user-visible status line format. Nothing else is shared.

### Ledger (visible, epoch-safe)

- Offer row of a turn that met a prerank gains `pre`: `{"hit": true, "age_ms", "waited_ms", "intent": bool}` or `{"hit": false, "why": "ttl"|"schema"|"prompt"|"state"|"named"|"language"}`. `q` stays the prompt as sent; `rq` carries the ranked route text when an intent was used. A session without the mod gets no `pre` key and a row identical to today's.
- A new row `{"ev": "prerank", sid, d, status, reason?, ms, intent, stage, tier}` per prerank run, so wasted runs are countable. `analyze.py` ignores unknown `ev` values (it filters on `ev == "offer"`, `"turn"`, `"auto"`; `analyze.py:177-307`).
- **`jev.ms` on a `pre.hit` row is the ranking's compute time, not the user's wait** (that is `pre.waited_ms`). Any analysis that pools `jev.ms` (for example `scripts/calibrate_jev_gate.py:695`, which reads `r["jev"]["ms"]`; I did not check that those are ledger rows) must exclude `pre.hit` rows. This goes into `docs/epoch-watch.md` and the CHANGELOG. This change starts a new epoch.

## Turn timeline

Process names: **mod** = the Claude Code mod worker; **hook** = `enforcer.py` run by `hooks.json`; **prerank** = `enforcer.py --prerank` started by the mod; **jevd** = `127.0.0.1:4377`.

| t (after the last keystroke) | Who | What | Latency source |
|---|---|---|---|
| each keystroke | mod | `prompt.autocomplete` → cancel and re-arm one timer, clear status | Fact: the engine does not wait on it (d.ts `prompt.autocomplete` doc). Constant time. |
| 1.0 s | mod | timer fires; gate; reads the draft | design constant |
| 1.0 – 2.2 s | mod → Max | `haiku` writes the intent line | **Estimate** 0.7–1.2 s, unmeasured; hard cap 1.2 s, then no intent |
| about 2.2 s | mod → prerank | process starts; marker written | **Measured today**: `enforcer.py` with empty stdin runs in 0.17–0.19 s wall (3 runs, Python 3.12) |
| 2.4 – 5.1 s | prerank → jevd | wide pass, rerank, publish | **Measured** (grounding §2): full stage p50 2656 ms, p90 3746 ms; wide p50 1934 ms. jevd Command Code p50 980 ms, p90 1477 ms per call |
| about 4.9 s (p50), about 6.2 s (p90) | mod | status line shows the five names | **Estimate**: 1.0 + 1.0 + 0.18 + 2.66 and 1.0 + 1.2 + 0.18 + 3.75 |
| Enter at E | mod | `prompt.submit` clears status; `next(e)` waits for hooks | Fact: P5 |
| E + 0.18 s | hook | Python start-up | **Measured** as above |
| E + 0.18 s | hook | `_pre_claim` (one stat when the mod never ran) | Fact |
| E + 0.2 – 0.4 s | hook | **hit**: artifact served; embed (p50 83 ms) and Qdrant (p50 25 ms) overlap; render | **Estimate**: the hook's total wall time is not recorded (grounding §2) |

What the person feels, by when they press Enter:

- **E ≥ about 5 s after the last keystroke (hit).** The Enter-to-model wait drops from about 2.9 s (0.18 + Jev p50 2.66; **Estimate**) to about 0.4 s. A saving of about 2.5 s at p50 and about 3.5 s at p90 (0.18 + 3.75 - 0.4; **Estimate**).
- **E between about 2.2 s and 5 s (adopt).** The hook waits for the run in flight, up to 3 s. Saving equals the time the prerank had already run: from 0 up to about 2.6 s.
- **E under about 2.2 s, or any edit after the prerank (miss).** Identical to today, plus nothing: the hook ran no extra work. The only cost is a wasted prerank in the background.

I do not know how long people wait between their last keystroke and Enter. If that gap is mostly under 2 s, this design saves little and the wasted-call count will say so (`ev:"prerank"` rows against `pre.hit` offers). That is the first thing the ledger must answer after release, and it is why the intent step has a kill switch: it adds about a second before Jev starts and shrinks the adopt window.

## Synthesis decision

*(left empty for the arena orchestrator)*

## Tradeoffs accepted

- We accept **wasted Jev calls and wasted `haiku` calls** on drafts that are edited or abandoned, in exchange for taking Jev off the critical path. Bounded by: 1 s quiet time, one run in flight, one run per distinct text, 8 runs per rolling minute. Jev calls ride the owner's approved Command Code and TypeSafe channels through jevd; `haiku` rides the session's own Max client ([72]). The count is measurable.
- We accept that **an unsent draft leaves the machine to a Jev provider**, which v0.67.0 did only on a click and the hook does only for a sent prompt. Mitigation: `_prerank_run` skips drafts matching the enforcer's existing secret patterns (`_JEV_SECRET_RES`, `enforcer.py:1580`). That covers token shapes, not prose. Thinh must accept this (see Open questions).
- We accept an **intent step that delays the start of Jev by about a second** for the one measured quality lever, with a 1.2 s cap and a kill switch. If the haiku generator fails its parity check (verification plan, gate G1), intent ships off by default.
- We accept **no visible rewrite and no band**. Thinh loses the Enhance button; the old prompt-enhancer still exists for that.
- We accept that **the status line can disagree with the served menu** when the conversation moved between the pause and Enter. The line is cleared on every edit and the ledger records the miss; we do not poll the transcript to chase it.
- We accept **breaking mod 0.67.0's hint**. A 0.67.0 mod keeps writing `route-hints/<sid>.json`; the new enforcer ignores it. This is deliberate (two ways to do one task), and the 0.67.0 band keeps working as a band.
- We accept **a refactor of `main()`'s early lanes into `_early_lane`** so `--prerank` and the hook share one lane order. It is the riskiest Python edit; existing tests are the net, plus a new equivalence test.
- Things that may look like oversights: the mod copies `MIN_WORDS` (guarded by a test, not derived); the `pre` block is absent when no mod ran (so rows stay identical for the other seven harnesses); `jev.ms` on a hit row is not the felt latency; the status uses names only, not scores (scores are relative shares the doctrine says not to read as confidence).

## Alternatives considered

1. **Repair v0.67.0: keep the Enhance band, run the real enforcer with `ENFORCER_LEDGER=defer`, real session id and transcript, and pin the previewed menu into the hint** (preview-then-pin). Fixes D1-D5 but loses on the owner's terms: it still needs a click, still owns `AbovePrompt` and hotkey `e` (grounding §3: the old prompt-enhancer wins the chain, the later hotkey wins), still ranks the rewrite machinery that the A/B put last, and the pinned menu travels as text through a file the hook must trust (a second renderer or a verbatim injection, either one a second path to the model's menu). Interface depth: a rich public surface (band, hotkey, pending state, hint file) for one capability.
2. **Native injection: at `prompt.submit` the mod calls jevd itself (P1) and adds the menu through `context` (P4).** Uses a channel the probes proved. Loses because the hook's own menu still arrives (P3: the mod cannot suppress or rewrite it), so the model reads two menus from two rankings, the doctrine's one-menu contract breaks, and the SystemOne protocol gets a TypeScript copy. It also puts the Jev wait on the critical path again, inside `next(e)`.
3. **Explicit chord instead of autocomplete.** Same pre-ranking, started by a key. Cheaper in wasted calls, and it would not depend on `prompt.autocomplete` cadence. Loses on "seamless, no click": nobody will press it every turn, so the median turn gets nothing.
4. **Enforcer-only speed-up (warm cache, parallel legs).** Without a pre-submit signal the hook cannot start Jev before Enter; embed (83 ms) and Qdrant (25 ms) already overlap with it. Only a pre-submit observer, the mod, can move Jev off the path. This was the only way to hide the latency; it is not an alternative for quality.

## Red-flags screen (design-red-flags.md)

| Red flag | How this design avoids it, or why it does not apply |
|---|---|
| Shallow module | Mod: two pass-through hooks over a scheduler whose public surface is `onEdit`/`onSubmit`; it hides debounce, gating, in-flight and cap rules, intent boundary check and readout parsing. Enforcer: one CLI mode and one flag over lane, secret, route, context, Jev, publish and ledger. Callers do not coordinate several calls. |
| Information leakage | The artifact schema is private to `prerank.py` (the mod never opens the file; it reads a readout). The Jev/jevd protocol is spoken only by `enforcer.py`. The route text is composed only in `prerank.route_text`. The readout reuses `skillConciergeOffer` key names instead of inventing a vocabulary. The mod does not branch on skip reasons (opaque string). |
| Temporal decomposition | Not organised as load/validate/save. `prerank.py` groups by the knowledge it owns (the artifact's key, state rule, TTL and schema), though its functions run at different times in different processes. |
| Pass-through method | `Ports.prerank` adds boundary parsing and failure mapping; `_jev_start(pre=...)` extends the existing job instead of wrapping it. `register.tsx` is thin by intent: it is the adapter that turns `$` into `Ports`. I accept that as a forwarding boundary with policy (kill switch, install lookup), not a pass-through. |
| Split ownership | One owner per fact: artifact = `prerank.py`; route composition = `prerank.route_text` (the mod no longer composes it); lane order = `_early_lane`; status line = the scheduler; intent text = the mod; Jev state = `_jev_route`. The old hint path is deleted, not kept as a second writer. |
| Two ways to do one task | `_route_hint`, `ROUTE_HINTS`, `_VIA`, the mod's `leaveRouteHint`, `Enhance`, the preview `rankMenu` and the `AbovePrompt` band are all deleted in the same change. One way to pre-rank, one way to serve it. |
| Importable internals | `register.tsx` exports only `register`; tests import the pure core from `prerank.ts`, which is the intended unit. Python: the hook uses `claim`/`wait`; underscore functions in `enforcer.py` stay private. The mod cannot import the enforcer's internals (it shells out to a CLI). |
| Hand-synced list | `MIN_WORDS` ↔ `MAX_SHORT_WORDS + 1` is the one copied constant, and `tests/test_prerank.py::test_min_words_matches_enforcer` fails the build if they differ. Skip reasons are opaque to the mod, so there is no reason list to keep in step. The new flag appears in the AGENTS.md table and `docs/runtime-flags.md`; `tests/test_flag_docs_parity.py` already fails when they disagree. |

## Verification plan

### A. Mod unit tests (`claude plugin test adapters/claude-code/mod`, kit `claude-code/testing`)

The kit cannot raise `prompt.autocomplete` (grounding §4), so the scheduler is exercised through `Ports` fakes plus the kit's `mock.clock`; the hooks' wiring is checked structurally.

| Test | Pass condition |
|---|---|
| Debounce | Twenty `onEdit` calls 100 ms apart, then `clock.advance(1000)`: exactly one `readDraft`, one `intent`, one `prerank`. |
| Gate | Drafts `"ok thanks"`, `"/help me"`, `"  "` start no run and call no port except `status(undefined)`. A 4-word draft runs. |
| Supersede | An edit while `intent` is pending sets `signal.aborted`; no `prerank` call; the late result is never shown. |
| Latest wins | A second text settles during a run: after the first finishes, exactly one more run, for the second text only. |
| Dedupe and cap | The same settled text twice: one run. Nine distinct settled texts within one mocked minute: eight runs. |
| Intent degraded | `intent` resolves null or times out: `prerank` is called with `intent: null`, status still shown. |
| Status truth | `ready/offer` shows five names; `ready/jev_skip` shows `no skill needed`; `skipped`/`failed` show nothing; the line is cleared by the next edit and by `onSubmit`. |
| Boundary parsing | `parseReadout` returns `failed` for empty, non-JSON, wrong shape and extra trailing lines; accepts a JSON line after log noise. `cleanIntent` strips tags and quotes, drops multi-line and over-length replies. |
| Kill switches | `CONCIERGE_ENHANCER=0` leaves all ports untouched on `onEdit`; `CONCIERGE_INTENT=0` never calls `intent`. |
| Pass-through and coexistence, with inline peers | (1) Load an inline peer plugin that hooks `prompt.submit` and appends `context`, and raise `prompt.submit` with origin `composer`: the peer's context survives, `e.text` unchanged, no extra context from this mod. (2) Load an inline peer that renders the old prompt-enhancer's `AbovePrompt` band with hotkey `e`, mount `AbovePrompt`: the peer's band renders unmodified and `find({key})` shows no element owned by `concierge-enhancer`. (3) Load the peer in both orders (`tier` prepend, append). (4) Structural: the plugin's validate report lists hooks `session.start`, `prompt.autocomplete`, `prompt.submit` and no `ui.render`, `command.register`, `prompt.edit`, `prompt.fill`, hotkey. |
| Install lookup | `enforcerPath` picks the highest `version` among `skill-concierge@*` entries and honors `SKILL_CONCIERGE_ROOT`; returns null when absent. |

### B. Python tests (`tests/test_prerank.py` and edits)

| Test | Pass condition |
|---|---|
| Store round trip | `publish` then `claim` returns the artifact and unlinks the file; a second `claim` returns nothing. |
| Rejections | TTL beyond 300 s, `t` NaN, wrong schema, wrong prompt, traversal sid `../x`, a malformed file: all give a miss with the reason, none raises. A malformed file is unlinked. |
| Atomicity and permissions | A reader never sees a partial file; mode is 0600; the sweep removes files older than an hour and leaves fresh ones. |
| `route_text` | A short draft gives `draft + "\n\n" + intent`; a 6000-character draft keeps the whole intent and totals at most `JEV_MAX_CHARS`. |
| `state_key` | Changes when the last assistant text, the loaded skills (order too) or the route changes; stable otherwise. |
| `_early_lane` equivalence | For a table of prompts (empty, `/x`, three words, `<task-notification>`, refusal, consult, self-reference, normal), the lane name equals the band main() writes with `ENFORCER_JEV_ROUTER=0`; existing tests for each lane still pass untouched. |
| `_prerank_run` | With `_jev_route` monkeypatched (pattern from `tests/test_jev_router.py`): full stage gives artifact, `ready` readout and a `prerank` ledger row; wide stage gives no artifact and `skipped/not-full`; a skip verdict is stored and reads `jev_skip`; named skill, secret, non-English, lane, `ENFORCER_PRERANK=0` give `skipped` and call `_jev_route` zero times; no `offer` row and no hook JSON on stdout. |
| One ranking | With a valid artifact on disk, `main()` calls `_jev_route` zero times and the injected context equals `_ranked_mandate` over the artifact's rows (compared byte for byte with a cold run fed the same rows). The offer row has `pre.hit: true`, `q` as sent, `rq` set when intent was used, and still pairs with `ledger.py`'s turn row on `(sid, q)`. |
| Misses | Moved transcript (a new assistant message) gives `pre.why == "state"` and one live `_jev_route` call; a different prompt text finds no artifact and no `pre` key; an expired artifact gives `ttl`. |
| Adopt | With only a marker (live pid) and an artifact published 300 ms later by a thread, the hook waits, serves, and records `waited_ms` ≥ 200. With a marker whose publisher never comes, the hook gives up at `ADOPT_MAX_S` and runs live inside the original 7.8 s deadline. A marker with a dead pid causes no wait. |
| No mod | With no `preranks/` directory the row has no `pre` key and every other key equals a golden row from the parent commit (`tests/test_prerank.py::test_rows_without_the_mod_are_unchanged`). |
| Missing module | Copy `hooks/scripts/` without `prerank.py`: the hook still emits its menu (this extends the harness-import precedent in `tests/test_harness_import_failure.py`, but degrades instead of exiting silently). |
| Guards | `MIN_WORDS` in `prerank.ts` equals `MAX_SHORT_WORDS + 1`; `prerank.py` loads on Python 3.9 (`tests/test_python39_hooks.py`); `tests/test_flag_docs_parity.py` passes with the new flag in both documents; `tests/test_hook_definitions_pinned.py` still passes (hooks.json untouched). |
| Old tests | `tests/test_enforcer_route_hint.py` is deleted with `_route_hint`; the suite shows no reference left (`rg route_hint` is empty outside CHANGELOG history). |

### C. One live drive (Claude Code 2.1.296, dev mod read from its folder, `/reload-plugins`)

Preconditions: jevd healthy (`GET /health`), mod loaded from the checkout, a ledger tail open, `SKILL_CONCIERGE_ROOT` unset (so the installed-plugin lookup is exercised), the old `prompt-enhancer@prompt-enhancer` disabled for steps 1-6 and enabled for step 7. Never run against a live machine's production state beyond this session.

| Step | Action | Pass condition |
|---|---|---|
| 1 | Type a 12-word English task, stop, wait 7 s | Status line shows five names within 7 s. The names equal `rows[0..4]` of `preranks/<sid>.<digest>.json`. |
| 2 | Press Enter | The `SKILL-FIRST` block the model received (from the transcript's hook context) lists the same five names in the same order; the offer row has `pre.hit: true`; Enter to model start is under 1.0 s; the turn row pairs with the offer row on `(sid, q)`. |
| 3 | Control: same prompt with `ENFORCER_PRERANK=0` | Enter-to-model wait is the cold figure (about 2.7 s); the offer row has no `pre`. The two waits are reported side by side, not averaged into one figure. |
| 4 | Type, wait for the status line, add one word, press Enter | The line disappears on the edit; no `pre.hit`; a live menu arrives; no error text anywhere. |
| 5 | Type, press Enter about 1.5 s after settling | `pre.waited_ms > 0` (adopt) or a miss with a reason; never a failure; time to menu no worse than control. |
| 6 | Send `/help`, `ok thanks`, a Vietnamese sentence | Zero new `ev:"prerank"` rows for the first two; the third gives `skipped/language` or no run. |
| 7 | Enable the old prompt-enhancer; type a draft | Its band and hotkey `e` work as before; this mod's status line appears beside it; concierge's menu is unchanged. Repeat after toggling enablement order. |
| 8 | Disable this mod; send three prompts | Offer rows have no `pre`; behavior and keys equal the parent commit's. |
| 9 | Paste a 30-line block, press Enter | Record whether `$.prompt.read().text` equals the hook's `prompt` (paste placeholders). Pass: outcome recorded; either a hit or a clean miss. |
| 10 | Instrumented facts | Record: autocomplete fires on every token; a `clock.after` callback may call `$.model.complete`, `$.process.run` and `$.ui.status`; `$.ui.status` is visible in the terminal; the child process sees the same env as the hook (the artifact's `event.bench` equals the live row's); `haiku` intent latency p50 and p90 over 10 drafts. |
| 11 | Spend | Over a 20-prompt session, report prerank runs against `pre.hit` offers (the waste ratio). Not gated; reported. |

### D. Gates before intent is on by default

- **G1.** Re-run `plans/261012-0935-prompt-enhancer-ab/` with `haiku` and the new intent instructions as the generator on the same kind of sample (n ≥ 20, blind judge, rank raw vs raw+intent). Pass: raw+intent wins or ties head to head (≥ 10-10) with no empty menus. Fail: ship with `CONCIERGE_INTENT` defaulting to off; the rest of the design stands unchanged.
- **G2.** Step 10's intent latency: if haiku p50 exceeds 1.2 s, intent is off by default.

## Implementation reconciliation

*(stub; to be filled during implementation: accepted deviations, their acceptance source, and the updated usage, signatures and ownership)*

## Open questions and risks

1. **Does `prompt.autocomplete` fire often enough to be the trigger?** Grounding P6 saw it fire while typing; I assume once per token and not when the caret follows a space. Is that so, and does it fire for a paste? If it only fires on some edits, the draft is read at timer time through `$.prompt.read()` so a trailing-space draft is still ranked, but a draft that is only pasted may never arm the timer. Live step 10 settles it. Fallback if it fails: the mod ranks nothing and the hook runs as today; the fix would be a second trigger, which I have not designed.
2. **Does a `clock.after` callback keep a usable `$`?** The 0.67.0 mod relies on the same pattern for `onPress` (grounding does not probe timers). Unproven for timers. If it fails, `Scheduler` must be armed with the `$` of the latest dispatch.
3. **Does the child process see the hook's environment?** `$.process.run` documents "variables set over the host process's own environment" and grounding D8 says the command hook's env is unverified. A difference in `JEVD_URL` or `ENFORCER_*` would make the prerank rank under another configuration. Step 10 compares `event.bench`/tier fields.
4. **Pasted text.** `prompt.submit` `e.text` has pastes expanded (d.ts:9061); `$.prompt.read().text` may hold placeholders. Then the digest differs and every pasted prompt misses. Is that acceptable? My pick: yes for now, record the rate, and fix by keying on `e.text` at submit only if the rate matters.
5. **Dwell time is unmeasured.** The saving depends on how long people wait before pressing Enter. I recommend releasing behind the ledger and judging on `pre.hit` share and `waited_ms`, per epoch, not before.
6. **Privacy (needs Thinh's decision).** Unsent drafts now reach a Jev provider through jevd, and settled drafts reach Anthropic through `haiku` (which they would anyway if sent). Source: this design, `enforcer.py` secret patterns at 1580. Options: accept (my pick, with the secret guard), or run the prerank only for drafts that have sat at least 3 s (smaller leak, smaller hit rate), or off by default with an opt-in flag. Which?
7. **Is `haiku` good enough for the intent line?** The A/B used sonnet. Gate G1 decides. I recommend running G1 before the release.
8. **Risk: the `_early_lane` extraction touches the hottest path.** Mitigated by equivalence tests; if the diff proves too invasive, the fallback is for `--prerank` to call the existing predicates in the same order and for a test to assert both orders match (a guarded duplicate instead of a shared function).
9. **Risk: new script on every install.** I did not check whether each installer copies `hooks/scripts/` wholesale or by list (Codex, Cline, OpenCode, OMP, ZCode, DSH). The guarded import means a missed copy costs only the speed-up; the doctor should still list `prerank.py` as an expected file. Which installers list files, if any?
10. **Risk: an old mod still installed.** A 0.67.0 mod keeps its band and writes ignored hints. The marketplace update path replaces it; until then the person sees an Enhance button whose "unchanged menu" promise no longer holds. README and CHANGELOG must say so.
11. **What I did not check:** I did not run the kit or any mod test; did not run Jev, jevd or the enforcer's ranking path; did not read `ledger.py` beyond the turn-row join; did not read `docs/epoch-watch.md` or `tests/test_jev_router.py` (the monkeypatch pattern I cite is from the file list, not read); did not verify `analyze.py` consumers of `jev.ms` beyond the grep line cited. The only numbers measured by me are the three 0.17-0.19 s start-up timings; every other latency is grounding.md's or an Estimate.

## Next implementation step

Write `hooks/scripts/prerank.py` (store, `claim`, `publish`, `validate`) with `tests/test_prerank.py` store-level tests first, because everything else (the hook's serve path, `--prerank`, the readout the mod parses) depends on that file format and its rules being right.
