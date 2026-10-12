# concierge-enhancer v0.2: the draft-time ticket

Candidate design (runner: opus). Sketch files: `sketch/mod/` (the mod) and `sketch/python/` (the enforcer side). Labels used below: **Fact** (read in source or grounding, cited), **Inference**, **Unmeasured**.

## Problem

The goal is a better first menu: the five skill rows concierge's `UserPromptSubmit` hook (`hooks/scripts/enforcer.py`) puts beside each prompt. Four facts shape the answer.

1. A mod cannot touch that menu once the hook builds it. `classic.UserPromptSubmit` did not fire for the plugin's command hook (P3). The mod has two working levers: a file written in `prompt.submit` before `next(e)` is on disk when the enforcer runs (P5), and `context` it adds reaches the model (P4).
2. Jev is the slow part of the hook and the part that is not deterministic. Full stage p50 2656 ms, p90 3746 ms, max 6383 ms; wide p50 1934 ms; embed p50 83 ms; Qdrant p50 25 ms. 6 rows timed out at about 7.05 s (grounding §2, live ledger). Because Jev is not deterministic, any preview that runs Jev a second time can disagree with what the model gets. That was v0.67.0's D3.
3. jevd is warm, loopback and keyless, and the enforcer already walks its ladder (`_jevd_ladder`, enforcer.py:2076; `_jev_call` pins each call to one provider, :2163). A mod can reach jevd (P1). It can also see the draft while the person types, without the engine waiting on it (P6).
4. Boundaries: `hooks/hooks.json` is pinned. The other seven harnesses must not notice anything. Offer rows must keep pairing with turn rows on `(sid, q)`. The doctrine's header semantics (whole-shelf versus preview) must stay true. Hook scripts must load on Python 3.9.

So the shape cannot be "rewrite the prompt, then rank twice". Jev's work has to move to before Enter, and the hook has to serve that same work.

## Usage (caller's view)

**The person (README).**

> Install `concierge-enhancer` beside `skill-concierge`. Type as usual. When you pause, the line under the prompt shows what concierge will offer, for example `concierge ▸ ui-styling · frontend-design · ak-test`. Press Enter and the model gets that exact menu, usually without the 2-3 s Jev wait, because the ranking already ran. There is no button, no hotkey and no band, and your prompt is never rewritten. If you want rewriting, enable `prompt-enhancer`; the two work side by side.

**Call site 1, the mod's wiring** (`sketch/mod/hooks/register.tsx`):

```ts
on('prompt.autocomplete', ($, e, next) => { speculator?.note(e.text); return next(e) })
on('turn.start',    ($, e, next) => { speculator?.working(true);  return next(e) })
on('turn.complete', ($, e, next) => { speculator?.working(false); return next(e) })
on('prompt.submit', ($, e, next) =>
  e.origin.kind === 'composer' && speculator ? speculator.send(e.text, () => next(e)) : next(e))
```

**Call site 2, the speculative run** (spawned by the Speculator; the same `enforcer.py`, stdin):

```json
{"prompt": "add dark mode w/ ui-kit to settings", "session_id": "sess-42",
 "speculate": {"intent": "Add a dark mode toggle to the settings page with ui-kit.", "n": 1}}
```

The last stdout line carries `skillConciergeSpeculation: {"v": 1, "ticket": "ranked", "preview": {"kind": "menu", "skills": [...], "whole_shelf": true}}`.

**Call site 3, the hook** (enforcer `main()`, pseudocode in `sketch/python/enforcer_changes.py`):

```python
ticket = offer_ticket.find(sid, prompt)                         # read-only, before the lanes
... lanes judge the prompt as sent ...
prompt = offer_ticket.route_text(sent, ticket.intent if ticket else "")
_hits = _route_hits(sent, KEEPOFF)                              # the author's words only
_jev_job = _jev_start(prompt, transcript_path, ticket) if not _hits else None
# worker: offer_ticket.redeem(ticket, ctx=..., env=..., until=deadline) -> verdict, or the live route
```

## Shape

**Data first.**

- **Ticket.** Private to `hooks/scripts/offer_ticket.py`. One file per session, `route-hints/<sid>.ticket.json`. It holds `{v, sid, qh: sha256(sent text), intent, state: ranking|ranked|unranked, made, deadline, pid, ctx, env, n, verdict}`. `verdict` is exactly `_jev_route`'s `(result, event)`. It stores no draft text: the hook rebuilds the ranked text from the prompt it receives, with `route_text`.
- **Preview.** The mod's domain type (`sketch/mod/types/index.d.ts`): `menu{skills, wholeShelf} | no-skill | consult | silent`. It is parsed once, at the process boundary, from `skillConciergeSpeculation.preview`. That object is computed by Python from the same `whole_shelf` boolean `_ranked_mandate` receives.
- **Job.** Private to the Speculator: `{draft, abort, stream, killTimer, done}`. At most one is live.

**Flow.**

1. Keystrokes re-arm a 700 ms settle timer. No I/O happens.
2. On settle, the Speculator re-reads the box. If the draft is rankable, it asks the session's small model for an intent line (Max, ≤2.5 s, cached per draft). It then spawns `python3 enforcer.py` with a `speculate` request.
3. The speculative run executes the hook's own `main()` under the real session id, with the transcript found by session id. It runs the same lanes, the same deterministic routes, the same Jev route through jevd, the same gates, annexes and renderer.
   - It writes no ledger row; this is forced in code, not left to the env.
   - After the lanes, it opens the ticket as `ranking`. When its Jev job joins, it settles the ticket as `ranked` with the verdict, by the run's own deadline.
   - It prints the preview. The mod pins it with `$.ui.status`, but only if the box still holds that exact draft.
4. On Enter, the Speculator kills any run for a different text and keeps the matching one alive while `next(e)` runs the command hooks. After that it kills everything.
5. The hook finds the ticket by the sent text's hash. In its Jev worker it checks the context fingerprint (`_jev_context` of the real transcript) and the env fingerprint.
   - `ranked`: it serves the verdict. No Jev call is made.
   - `ranking`: it waits for the run.
   - Anything else: it ranks live with the budget left.
   - The menu then renders through the unchanged pipeline.

**Load-bearing decisions.**

- **One ranking, one implementation.** Jev runs once per sent prompt, at draft time, inside the enforcer's own code. The hook redeems that verdict instead of asking again. The preview is the menu by construction, and the doctrine header stays true: Jev judged the whole shelf for this text under this context (per *two ways to do one task*). This fixes D1-D5. Real transcript and session id mean recent context, loaded skills and chain hints. The lanes judge the sent text in both runs. There is no second Jev call and no text scraping.
- **The ticket is Python to Python.** The mod schedules runs and displays results. It never reads or writes concierge's files, and it never sees the ticket. The v0.67.0 route-hint file and `_route_hint` are deleted (per *information leakage*, *migrate callers then delete*).
- **Staleness is impossible to serve, not merely unlikely.** A ticket is honoured only when the sent text hash, sid, context fingerprint, env fingerprint and TTL all match. The hook never writes or deletes a ticket; writers prune (per *split ownership*). The env fingerprint turns grounding D8 into a per-turn check that shows in the ledger (`spec.st = "env"`).
- **The deadline invariant.** `_jev_start`'s deadline is unchanged: hook start plus `JEV_BUDGET_S`. `redeem` never waits past it, and a live route after a miss gets only the time left (`_jev_route(..., deadline=)`). A speculative run started before Enter, with the same 7.8 s budget, so its own deadline falls earlier. Its worst case is no worse than today's.
- **The intent line feeds the ranker only.** It never reaches the box or the model. Deterministic routes now match the sent text only, because a skill name the intent writer emitted is not the author's explicit intent. The A/B's best arm, raw + intent, is kept verbatim as `route_text` (report.md round 2: raw+intent beat raw 13-7). The intent rules keep the standing decisions: no skill names, the author's terms verbatim, no ask section.
- **jevd, used where it pays.** The speculative run inherits the host env, so `_jev_bench` takes jevd's ladder. jevd's warm loopback connections make draft-time ranking cheap to start. Its keys never touch the mod. The owner's 2026-10-06 split stands: jevd's config is the single source of the ladder, and the hook keeps its switches.
- **No shared UI surface.** The mod has no `AbovePrompt`, no `PromptHint`, no hotkey and no added `context`. It uses only `$.ui.status`, which allows one per plugin. Coexistence holds by construction, whatever the chain order.
- **One-variable revert:** `ENFORCER_TICKET=0`. The hook then ranks live as before, and the preview still shows.

**Interface depth.** The mod's public surface is `locateEnforcer` plus four methods (`note`, `working`, `send`, `end`). Behind them sit settle detection, intent writing, spawn and kill, cost caps, boundary parsing and status. Python's public surface is `find` and `redeem` for the hook, `open_ticket` and `settle` for the speculative run, and three pure helpers. Behind those sit the file format, atomic writes, validation, polling, liveness and pruning. The enforcer's only new seam is `_jev_start(..., ticket)`. A data trace crosses three files: `speculator.ts`, `enforcer.py`, `offer_ticket.py`.

**Deliberately not done.**

- No TypeScript ranking or jevd client.
- No ticket read in the mod.
- No change to `hooks/hooks.json`, `ledger.py`, the doctrine, or `ENGINE_ENV_KEYS` (the new flag is hook-side).
- No full-menu ticket.
- No model context added.

### The visible "Enhance" rewrite goes

1. The owner's goal is the menu, and the A/B ranked the full rewrite worst (last in 11 of 20 in round 1).
2. The measured useful part, the intent line, now runs automatically without a click. A click is not "seamless".
3. Rewriting is the standalone `prompt-enhancer`'s job. Keeping it here meant two ways to do one task, plus the contested `AbovePrompt` band and hotkey `e` (grounding §3).
4. With `prompt-enhancer` re-enabled, its rewrite becomes the draft this mod ranks. The two compose.

### Turn timeline

| When | Process | What happens | Felt latency |
|---|---|---|---|
| Each keystroke | engine → mod (`prompt.autocomplete`, not awaited, P6) | `note()` re-arms the settle timer | none |
| Last key + 700 ms | mod | `prompt.read`; intent via `$.model.complete` (haiku, ≤2.5 s, **Unmeasured** latency) | none (background) |
| Then | `python3 enforcer.py` (speculative) | start-up (**not recorded** anywhere); lanes; open ticket; embed p50 83 ms ∥ Jev through jevd, full p50 2656 / p90 3746 ms; settle ticket; annexes; preview out | none |
| Then | mod | `$.ui.status("concierge ▸ …")` if the box still holds that draft | the preview appears about 0.7 s + intent + start-up + ~2.7 s after the pause (**Inference**) |
| Enter | mod (`prompt.submit`) | kill runs for other text; keep the matching one; `next(e)` | microseconds |
| Then | `enforcer.py` (hook) | find ticket (one small file read); lanes; embed 83 + Qdrant 25 ms ∥ worker: context fingerprint (≤256 KB tail read, **Unmeasured**) + `redeem` | **ranked:** no Jev wait. **ranking:** only the run's remaining time. **none:** today's path |
| Then | `ledger.py`, engine | turn row; the turn starts; the model reads the prompt plus the menu | |

Today the probe measured 2.6 s from `prompt.submit` entry to `next(e)` resolving on one turn (P5), and Jev's p50 is 2.66 s. That Jev dominates the wait is an **Inference**. With a ranked ticket, the expected saving is Jev's share. The rest (Python start-up, retrieval, annexes, `ledger.py`) stays. How often the ticket is ready at Enter is **Unmeasured**: it depends on how long people pause before Enter. The ledger's `spec.st` will show it.

## Synthesis decision

## Tradeoffs accepted

- We accept that drafts the person never sends reach Jev (through jevd to Command Code or TypeSafe) and the session's small model, in exchange for ranking before Enter. Today only sent prompts go to Jev. This is a privacy change the owner must accept (Open question 1).
- We accept more Jev spend per sent prompt: up to `MAX_RUNS_PER_DRAFT` = 6 runs, each with up to two Jev calls plus one haiku call. In exchange, the menu is ready at Enter. The cost is recorded per turn as `spec.n`.
- We accept that one turn can be slower than its own live ranking would have been. This happens when the hook waits on a run that drew a slow Jev answer. In exchange, Jev runs once instead of twice. The worst case stays within today's budget.
- We accept that when a speculative run's Jev fails late, the hook's live retry gets less than the full budget and may end on the embedding Preview menu where today's full-budget run might not.
- We accept that the preview shows only for a settled draft and clears while typing. A preview must never describe text that is not in the box.
- We accept a module-level `speculator` instead of `$.state`, because child processes, timers and abort controllers are not plain data. A hot reload drops them together, which is the correct end for both.
- We accept that `MIN_WORDS` (mod) mirrors `MAX_SHORT_WORDS` (enforcer). It is an optimization only. If the two drift, the cost is a wasted spawn or a missed speculation, never a wrong menu.
- We accept up to one small ticket file per session, pruned by writers after 15 min, in exchange for a hook that never writes.
- We accept losing the visible rewrite (see above).
- We accept a new ledger epoch: `enforcer.py` changes. A served turn's `jev.ms` is the speculative run's routing time, marked `src: "ticket"`. Latency analyses split on `src`.

## Alternatives considered

- **A TypeScript jevd client (whole shape).** The mod would build the Choice questions itself, call jevd directly (P1) while typing, and hand rows to the hook in a hint. It hides little and leaks a lot: the catalogue scroll, keep-off, blocklist, invocability, the tier ladder with its spans, the fits floor and the pull-ins would all exist twice, in two languages. Every concierge change would need a matching mod change. It lost on *information leakage* and *two ways to do one task*.
- **Submit-time intent context (whole shape).** No draft-time work. At `prompt.submit`, write an intent line and add it as model `context` (P4), and let the hook rank as today. It is simple and cannot show a preview. It saves no latency, and its intent reaches the model rather than the ranker, while the A/B measured only the ranker. It lost on the owner's goal.
- **v0.67.0 fixed (whole shape).** Keep the Enhance band, pass the transcript, read `defer` JSON, and serve the previewed menu. It still needs a click, still claims the shared band and hotkey `e`, and still rewrites into the A/B's worst arm. It lost on "seamless" and "won't collide".
- **Hook-side race (variant of this shape).** The hook starts live Jev at once and also watches the ticket; the first answer wins. This is faster on unlucky samples, but every in-flight turn pays two Jev runs, for a gain bounded by the run's head start. Rejected for cost.
- **Full-menu ticket (variant).** The hook prints the speculative run's rendered menu verbatim. It saves about 110 ms of retrieval. But it would serve lanes, keep-off, blocklist, annexes and the chain hint as of draft time, and it is a second offer path. Rejected.

## Red-flags screen

| Red flag | How this design avoids it, or why it does not apply |
|---|---|
| Shallow module | The mod has 4 methods plus `locateEnforcer`, hiding scheduling, intent, spawn and kill, caps, parsing and status. `offer_ticket` exposes 4 lifecycle calls plus 3 pure helpers over the whole file protocol. Callers never coordinate stages: the hook makes one `find`, then `_jev_start(..., ticket)`. |
| Information leakage | The ticket format, path and validation live only in `offer_ticket.py`. The mod parses one versioned object (`skillConciergeSpeculation`) into `Preview` at the boundary, and no wire type crosses into its API. v0.67.0's leak (the mod knew the hint path and schema) is removed. |
| Temporal decomposition | `open_ticket`, `settle`, `find` and `redeem` run at different times but sit in one module, because they protect one decision: when a stored verdict may stand in for a live one. |
| Pass-through method | `_jev_start` gains policy (redeem first, live with the remaining budget); it does not forward. `send()` adds the keep/kill ordering around `next(e)`. |
| Split ownership | Ticket: written only by speculative runs, through atomic replace guarded by hash; the hook only reads; pruning is done by the writer. Mod state: one owner, the `Speculator`. Ledger rows: the hook alone (speculative runs are forced to defer). |
| Two ways to do one task | Ranking: one `main()` for the hook and the speculative run. Mod-to-hook channel: the ticket replaces the route hint, deleted in the same change. Rewrite: left to `prompt-enhancer`. |
| Importable internals | Python cannot enforce privacy. `offer_ticket` exports only the names in its docstring, and the enforcer imports nothing else. TS: the mod's tests import only exported functions. |
| Hand-synced list | `route_text` is the one definition of the ranked text. The fingerprint key set is defined once in `fingerprint_env`. One honest duplicate remains: `MIN_WORDS` (4) against `MAX_SHORT_WORDS` (3). It is an optimization only and is recorded above. The new flag `ENFORCER_TICKET` must enter the AGENTS.md table and `docs/runtime-flags.md`, and `driftcheck` already fails the build when those disagree. |

## Verification plan

**A. Mod unit tests** (`claude plugin test adapters/claude-code/mod`; outline in `sketch/mod/tests/concierge-enhancer.test.tsx`). Each passes on literal values.

1. A settled draft spawns exactly once, with argv `['python3', <install>/hooks/scripts/enforcer.py]` and env including `SKILL_CONCIERGE_HARNESS=claude` and `ENFORCER_LEDGER=defer`. The stdin is `{prompt, session_id:'sess-42', speculate:{intent, n:1}}`. The status reads `concierge ▸ ui-styling · frontend-design · ak-test`.
2. A keystroke before 700 ms means 0 spawns. A change after a spawn means 1 kill, then a second spawn. No status ever names a menu for text no longer in the box.
3. Empty drafts, `/…` drafts and drafts under 4 words get no spawn and no intent call.
4. After `turn.start`, no spawn. After `turn.complete`, a spawn after settle.
5. Enter on the matching draft: the bottom `prompt.submit` hook sees 0 kills; after the submit resolves, 1 kill. Enter on an edited draft: 1 kill already inside the bottom hook.
6. The submitted `e` reaches the bottom unchanged: same text, `context` undefined, same origin.
7. Intent failure (`aborted`): the request carries `speculate.intent === ''`. The intent rules contain the no-skills line and `"chisle" stays "chisle"`, and match no ask or question wording.
8. An enforcer whose output lacks `skillConciergeSpeculation` makes the mod inert for the session.
9. **Coexistence**, with an inline peer band plugin (`test(name, {plugins:[PEER]}, …)`). The peer draws `AbovePrompt` without `next(e)`, binds hotkey `e`, and appends `PEER-CONTEXT`. On both surfaces, the peer's `peer-enhance` button is present, the bottom hook gets `context === ['PEER-CONTEXT']`, our status shows, and the kit reports no skipped hooks.
10. `parseSpeculation` and `statusFor` give the literal values listed in the sketch.

**B. Python tests** (`tests/test_offer_ticket.py`, replacing `tests/test_enforcer_route_hint.py`; stubbed `_jev_route`, temp HOME and log dir). Each passes on asserted values.

1. A speculative run writes no ledger row even with `ENFORCER_LEDGER=1`, and prints `skillConciergeSpeculation.v == 1`. The preview's `skills` equal the main-menu bullet names of its own `additionalContext` (the rows under the header, before any pull-in or annex block), in order.
2. **One menu.** A speculative run, then the hook on the same prompt and transcript. The hook calls `_jev_route` 0 times. Its `additionalContext` is byte-equal to the speculative run's. The offer row has `via == "enhancer"`, `q == sent[:120]`, `rq == route[:120]`, `spec.st == "ready"` and `jev.src == "ticket"`. `analyze._segment_windows` pairs it with `ledger.py`'s turn row (`offered` is not None).
3. An assistant record appended in between gives `st == "stale"`, with exactly 1 live call. A different `ENFORCER_JEV_FITS_FLOOR` gives `st == "env"`.
4. An edited or rewritten prompt finds no ticket: no `via`, no `spec`, 1 live call.
5. A `ranking` ticket settled 300 ms later by a writer thread gives `st == "waited"` and 250 ≤ `wait_ms` ≤ 600, with 0 live calls. A dead pid gives `st == "dead"` and a live call. A ticket that never settles, with `ENFORCER_JEV_BUDGET=0.5`, keeps the whole Jev leg at or under 0.5 s plus 50 ms.
6. An intent holding a configured deterministic route phrase that is absent from the sent text produces no 1.0 deterministic row.
7. Malformed tickets (bad JSON, NaN `t`, deep nesting, wrong `v` or sid, an over-long intent, a non-plain sid) are ignored without an exception.
8. `ENFORCER_TICKET=0`: no ticket is written, and an existing one is ignored.
9. The existing suites stay green: `test_python39_hooks` (its glob picks up `offer_ticket.py`), the `--selftest`, and `test_hook_definitions_pinned`, with `hooks.json` untouched.

**C. Intent-writer gate** (owner-run; it calls Jev and models). Replay the A/B's 20 prompts with the haiku intent writer through `rank_prompts.py`, judged blind. It passes if raw+intent beats raw head to head on at least 11 of 20 and no menu is empty. If it fails, delete the intent stage before release. The ticket shape stands without it.

**D. One live drive** (interactive Claude Code, both plugins installed from the local marketplace, jevd running).

1. Type an English task, wait for the status, press Enter. Pass: the transcript's injected bullet names equal the status names, in order. The offer row has `spec.st "ready"` and `jev.src "ticket"`, and it pairs with its turn row. Record the debug-log Enter→`next(e)` time, and compare it with no-ticket turns in the same session. Report the numbers; do not claim a target.
2. Type and press Enter at once. Pass: a menu is present, and the row has `spec` absent or `st "waited"`.
3. Type during a running turn. Pass: no spawn, and no status.
4. Re-enable `prompt-enhancer@prompt-enhancer`. Pass: its band, `e` hotkey and rewrite work, our status re-ranks the rewritten draft, and the debug log has no skipped-hook lines.
5. Run `/clear`, then type. Pass: it works under the new session id.

**E. Release gates.**

- `python3 scripts/driftcheck.py driftcheck.json` exits 0, with the flag tables carrying `ENFORCER_TICKET`.
- `pytest` passes.
- `claude plugin validate adapters/claude-code/mod` lists exactly `session.start`, `prompt.autocomplete`, `turn.start`, `turn.complete`, `prompt.submit` and `session.end`, with no `ui.render`.
- `python3 scripts/smoke.py` passes on every harness. That is the proof that the other harnesses are unchanged.

**Epoch watch after release:** the `spec.st` distribution (hit rate), mean `spec.n` (cost), `wait_ms`, and Jev stage mix split by `src`. If the current epoch is too small, report "insufficient data".

## Implementation reconciliation

*(stub; filled during implementation)*

## Open questions and risks

1. Owner: unsent drafts would go to Jev providers (through jevd) and the session's small model. Do you accept that? If not, the shape still works with the ranking started on a longer settle, but the exposure only shrinks; it does not vanish.
2. Owner: is up to 6 speculative runs per sent prompt acceptable Jev spend before measurement? Or should the first epoch run with `MAX_RUNS_PER_DRAFT = 2`?
3. Does `$.prompt.read().text` equal `prompt.submit`'s `e.text` for pasted blocks and `@` mentions (d.ts:9061 says pastes are expanded in `e.text`)? If not, paste-heavy prompts always miss. That is safe, but no faster.
4. Does a `$` kept from `session.start` keep serving timers, `model.complete` and `process.spawn` for the whole session? reference.md ("Work that outlives a dispatch") implies yes; live drive D1 confirms.
5. Do `turn.start` and `turn.complete` fire for subagent loops? If they do, the mod would pause during a subagent's turns as well, which is harmless but wastes preview time.
6. Does `$.process.spawn` inherit the `env` block of `~/.claude/settings.json` the way command hooks do (for example `ENFORCER_MULTI_INTENT=0`)? The env fingerprint makes a mismatch safe and visible as `spec.st = "env"`. A systematic one is fixed by passing those keys explicitly.
7. Is `$.ui.status` drawn on the desktop surface, and is a status line the right place for the owner's taste?
8. Haiku intent quality is untested (gate C). The A/B used sonnet with no context.

## Next implementation step

Write `hooks/scripts/offer_ticket.py` and `tests/test_offer_ticket.py` against a stubbed `_jev_route`, through test B2 (the hook's `additionalContext` byte-equal to the speculative run's), before touching the mod.
