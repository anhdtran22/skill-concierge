# Rationale: pre-ranked offer (menu ranked while typing, served at submit)

Candidate: haiku (runner model claude-haiku-5-5). Task: `plans/261012-1206-concierge-enhancer-redesign/arena/task.md`. Grounding: `grounding.md` and `grounding-explained.md` in the plan folder. Sketch: `sketch/`.

Labels used below: **Fact** (read in source or docs, or measured in grounding), **Inference** (follows from facts), **Judgment** (my call), **Open** (unverified, listed at the end).

## Problem

The concierge offer is the five-row menu the model reads each turn. The v0.67.0 mod does not improve that menu. It adds a visible "Enhance" band that rewrites the author's prompt in the box, runs a second ranking in a fake session with no transcript, scrapes the bullet text, and writes a route hint. Grounding §3 lists the divergences (D1–D8). The band and hotkey `e` also collide with the old prompt-enhancer (grounding §3).

The constraint that shapes the design is Jev's latency on the send path. **Fact:** the `prompt.submit` hook runs before the concierge's command hook, and its `next(e)` resolved 2.6 s later in the live probe (grounding P5). **Fact:** the Jev full stage has p50 2656 ms and p90 3746 ms (grounding §2). So any design that ranks at submit keeps that wait before the model starts. **Inference:** while the author types, the ranking inputs do not change. The prompt is the draft, the last assistant message is fixed, and the loaded-skill list is fixed until a turn starts. The composer is idle during typing, so the ranking can run then.

## Usage (caller's view)

**Author's experience**

1. Install the mod. No keys, no setup.
2. Type a request of four or more words. After about 1.5 s without a keystroke, one line appears under the prompt, for example `Concierge menu ready: ui-styling · frontend-design · ak-test`.
3. Press Enter. The model reads the author's text unchanged, with the same five rows the line showed.

If the menu is not ready at Enter (sent quickly, or edited after the pause), the enforcer ranks on send exactly as it does today.

**Developer call sites**

- **A. The mod.** Its only public surface is `register(on)` in `hooks/register.tsx`, with two hooks: `prompt.autocomplete` and `prompt.submit`. No band, no button, no hotkey.
- **B. Enforcer, stage 1** (lanes only, no embed, no Jev, no model):
  `printf '{"prompt":"…","session_id":"S","precompute":true}' | ENFORCER_LEDGER=defer python3 hooks/scripts/enforcer.py`
  prints `{"needs_route": true}`. A refusal, consult or self-reference draft gets its finished output instead. A draft of three words or fewer, or a slash command, prints nothing.
- **C. Enforcer, stage 2** (same stdin plus `"route": "<draft>\n\n<intent>"`):
  prints `{hookSpecificOutput, skillConciergeOffer, prompt, fp, built_at, ttl_s}`. No ledger row is written.
- **D. Submit hand-off.** The mod writes `~/.claude/skill-concierge/route-hints/<session_id>.json` as `{prompt, route, t, menu}`, where `menu` is the stage-2 output. The enforcer's next UserPromptSubmit reads and deletes it, and serves `menu` only when it is current for the sent text.
- **E. Ledger.** A served row has `via: "precomputed"`, `q` = the sent text (so it pairs with the turn row on `(sid, q)`), and `lead_ms` (how long before submit the menu was ready).

## Shape

### Data structures first

Three shapes. Each has one owner.

| Shape | Where it lives | Written by | Read by | Per-turn access |
|---|---|---|---|---|
| Ready slot `{prompt, route, out, expiresAt}` | mod module memory | mod only | mod only | one write per settled draft; one read and clear per submit |
| Stage output `out` (JSON) | enforcer stdout; held as opaque data in the slot and the hint | enforcer only | enforcer validates; mod reads `skillConciergeOffer.band` and `.offered` for the status line | none |
| Hint file `route-hints/<sid>.json` | disk | mod, at submit | enforcer, once (read and delete) | one file per submit |

There is no map. Only the latest settled draft can be submitted, so a map of drafts would hold entries that can never be served. A single slot is enough.

Traced access pattern: keystroke clears the slot, cancels the timer and arms a new one. A settled draft runs stage 1, then (if needed) the intent call and stage 2, then fills the slot. Enter copies the slot to the hint file. The enforcer reads the file, checks freshness, and replays. Each step touches one structure.

### Load-bearing decisions

1. **The Enhance band, the rewrite, the prompt-box write and hotkey `e` go.** The mod draws nothing in `AbovePrompt`, binds no key, and never writes the prompt box. (Judgment. Reasons in the open questions, item 8.)
2. **The menu is ranked for the author's text plus one intent line; the author's words are never changed.** **Fact:** the A/B (grounding §1) ranks raw plus intent above raw alone, 13–7, and the full rewrite last in 11 of 20. The effect is modest, and the test used a different generator.
3. **Jev runs off the send path.** A background enforcer process runs at a settled pause, with the real session transcript and session id. At submit, the enforcer replays the stored output if it is current. (Judgment, on the numbers in the timeline.)
4. **The enforcer is the only ranking and the only freshness check.** The mod stores the enforcer's JSON as opaque data and reads two structured fields for its status line. Nothing is scraped from the menu text, which removes D5.
5. **Fail open everywhere, and the mod stays optional.** With the mod absent, the enforcer's path is unchanged. The mod's submit hook does one file write.

### Mechanism

**Mod (`hooks/register.tsx`, pure logic in `hooks/handoff.ts`).**
- `prompt.autocomplete` fires while typing (**Fact:** probed, grounding P6; the engine does not wait on it). The hook bumps a sequence number, cancels the settle timer, clears the slot and status line, and, if the draft is settled, arms `$.clock.after(SETTLE_MS, …)`. It returns `next(e)`, so other plugins' suggestions pass through.
- When the timer fires, `precompute` runs single-flight. Stage 1 runs the lanes. If it needs a route, `intentFor` makes one `$.model.complete` call (haiku alias, on the session's own Max client), with the last assistant text from `$.session.messages()`. Stage 2 then ranks draft plus intent. The slot is written only if the draft is still the latest keystroke's. The status line goes out through `$.ui.status` (one per plugin, d.ts:2466–2484), and an expiry timer drops the slot at `ttl_s`.
- `prompt.submit` with origin `composer` writes the hint file from the slot, clears the slot and status line, and returns `next(e)`. Any failure is skipped by the engine, and the prompt still goes out.

**Enforcer (`hooks/scripts/enforcer.py` plus a new sibling `hooks/scripts/menu_handoff.py`).**
- `main()` takes the hint first, as it does today (`enforcer.py:3061`). In precompute mode it does not take the hint, and it takes the route from stdin. It fixes the transcript fingerprint before any work starts, so the fingerprint names the transcript the ranking used.
- After the early lanes (`enforcer.py:3065–3104`), stage 1 stops with `needs_route`. Otherwise, if the hint's `menu` is current for the sent text, the enforcer replays it with `_serve_menu`. The stored context goes out byte for byte, and the stored row is re-stamped with `via`, `q`, `t` and `lead_ms`.
- Otherwise the route ranks as it does today (`enforcer.py:3110–3112`). The ranking body (deterministic routes, Jev, embedding, gates, annexes, render) is unchanged, so the normal path is byte-identical (golden test P12).
- `menu_handoff.py` owns every freshness check: sent text equals the draft, a non-empty transcript fingerprint matches, the menu is younger than its `ttl_s`, the shape is valid, and `ENFORCER_MENU_HANDOFF` is not `0`. It uses the same sibling-import pattern as `from harness import running_harness`.

### Turn timeline: first keystroke to the model reading the menu

"Felt" means what the author waits for. Every row is either a cited number or marked as unmeasured.

| # | Step | Runs in | Felt by the author | Basis |
|---|---|---|---|---|
| 1 | Keystroke; `prompt.autocomplete` fires | engine | none | **Fact** P6: not awaited |
| 2 | Hook clears slot, cancels timer, arms new timer | mod | none | design |
| 3 | 1.5 s without keystrokes (`SETTLE_MS`) | mod timer | none | design parameter, **unmeasured** |
| 4 | Stage 1: lanes only | `python3 enforcer.py`, defer | none | Python start-up **unmeasured**; no embed, no Jev here |
| 5 | Intent: one short model call | Max client, haiku | none | **unmeasured** |
| 6 | Stage 2: embed, Qdrant, Jev through jevd | `python3` plus jevd on `127.0.0.1:4377` | none | **Fact** grounding §2: embed p50 83 ms; Qdrant p50 25 ms; Jev full p50 2656 ms, p90 3746 ms. jevd: Command Code p50 980 ms, TypeSafe p50 357 ms |
| 7 | Status line appears | mod, `$.ui.status` | visible while typing, by design | d.ts:2466–2484 |
| 8 | Enter: hint file written | mod, `prompt.submit` | a file write, ms scale | **unmeasured**; d.ts:9085–9150 |
| 9 | Enforcer on submit: take hint, fingerprint, replay | `python3 enforcer.py`; no Jev, embed or Qdrant on a hit | Python start-up and JSON; annexes replayed, not re-queried | Python start-up **unmeasured**; the hook's total wall time is not recorded (grounding §2) |
| 10 | Model reads prompt and menu | model | model time-to-first-token | none |

**Today, for comparison.** `prompt.submit` to `next(e)` resolved 2.6 s after entry (**Fact**, P5), because the enforcer runs Jev on the send path. A Jev timeout costs about 7.05 s and falls back to the embedding preview (6 of 531 rows, grounding §2).

**Expected on a hit:** well under half a second before the model starts. **Judgment; unmeasured.** Verification item L4 measures it.

**On a miss** (not ready, edited after the pause, or sent during the precompute): today's path, about 2.7 s p50 before the model starts. The design adds no wait on a miss: the normal path is unchanged, and the submit hook does one file write.

**Not on the path:** the typing observer, the settle timer, stage 1, stage 2 and the intent call.

## Synthesis decision

## Tradeoffs accepted

- We accept one status line under the prompt while the author types. In exchange, the author sees the five rows the model will read. The line is one plugin status and can be removed with one call.
- We accept extra full Jev routes at each settled pause. A pause of 1.5 s inside a long prompt starts a route that a later edit may discard. In exchange, the Enter path has no Jev wait. The count is unmeasured; the ledger counts it (`via`, `lead_ms`, and draft routes that never served).
- We accept that a prompt sent while its precompute is still running, or after an edit, pays today's latency. We do not wait at submit for an unfinished precompute, because that could add the rest of the Jev time to the Enter path.
- We accept losing the visible Enhance button and the rewrite. The standalone prompt-enhancer stays installed. Its band and this mod's hooks do not overlap, so Thinh can re-enable it.
- We accept a second enforcer process per settled draft (stage 1). For short and slash drafts it exits before any model or Jev call. Its start-up cost is unmeasured.
- We accept one model call per settled draft that passes stage 1. The channel is the session's Max login (RULES [72]).
- We accept that the menu is served only for identical sent text. A pasted block the engine expands may miss. The fallback is the normal path.
- We accept an enforcer change, which starts a new ledger epoch (AGENTS.md, *Ledger metrics are EPOCH-SCOPED*). Pre- and post-change rates must not be pooled.
- We accept that the slot lives in module memory. A hot reload drops a ready menu, and the enforcer's normal path takes over.
- We accept that the desktop surface gets no precompute. `$.process.run` is CLI-only (d.ts:3505–3525), so the menu there is ranked on send, as today.

## Alternatives considered

Whole-shape alternatives. Each was judged on interface depth and on what it puts on the Enter path.

- **A. Fix v0.67 in place.** Keep the band and the rewrite, and route the preview through `defer` with a real transcript. This loses on collisions: `AbovePrompt` and hotkey `e` still clash with the old prompt-enhancer (grounding §3). It keeps the prompt-box write and its race ("Draft changed while enhancing"). It keeps a rewrite the A/B ranks last. Its latency is unchanged, since Jev stays on the send path.
- **B. Synchronous submit-time ranking.** At `prompt.submit`, run the intent and the enforcer before `return next(e)`. No observer, no timer, no slot, no state. This is the simplest shape: one hook, one place, and far fewer moving parts (Judgment; no line count measured). It loses on the owner's test. The Enter path pays the intent and the full Jev route, about 2.7 s p50, on every prompt. It is the strongest alternative, and I would choose it if Thinh rejects the typing-time spend (open question 11).
- **C. Mod-owned ranking.** TypeScript reads the catalogue from Qdrant and calls jevd's `/v1/systemone` itself, with its own lanes, keep-off and blocklist checks. This loses on one ranking (rubric 1). It hand-syncs the lanes, the word floor and the blocklist into TypeScript, and it must rebuild transcript-based freshness.
- **D. A second menu as model context.** Use `prompt.submit` `next({...e, context: [menu]})`, which the probe shows reaches the model (P4), next to the enforcer's own menu. This loses on the one-menu constraint (grounding §6): the model reads two menus per turn.

## Red-flags screen

Source: `design-red-flags.md` (eight flags).

| Red flag | Verdict | How the design avoids it, or why it does not apply |
|---|---|---|
| Shallow module | Avoided | The enforcer stays the deep module. Ranking, Jev, annexes, lanes and freshness sit behind `main()`. The mod's surface is `register` plus two stdin keys (`precompute`, `route`) and one file. |
| Information leakage | Avoided; one watch point | Only `_stamp_precompute` writes the stage-output format, and only `menu_handoff.py` validates it. The mod stores the bytes and reads `band` and `offered` for its status line. The `<intent>` tag format is the mod's alone. Watch: if the mod ever parses more of the output, the format leaks. |
| Temporal decomposition | Judged not present | The stages follow the timeline (keystroke, settle, precompute, submit), which could look like temporal splitting. Each piece of knowledge has one owner: freshness in `menu_handoff.py`, ranking in `enforcer.py`, intent in the mod. Each check runs once, in the enforcer. |
| Pass-through method | Avoided | `handOff` does real work: it reads the slot, clears it and writes the file. `enforce` adds the protocol: the stdin shape and the defer env. |
| Split ownership | Avoided | Ranking state is written only by the enforcer. The ready menu is held only by the mod and is cleared on every keystroke and at submit. The hint file is written by the mod and consumed and deleted only by the enforcer. |
| Two ways to do one task | Avoided by design; must be held in code review | A served menu is a replay of the same `main()` ranking, run in defer mode. A second ranking path would violate this. Golden test P12 pins the normal path's output. |
| Importable internals | Avoided | Helpers in `menu_handoff.py` and the new enforcer helpers (`_serve_menu`, `_inject_text`, `_write_offer_event`) are underscored or module-private. The mod's pure logic lives in `handoff.ts`, and tests import only that file. `register` is the only export of `register.tsx`. |
| Hand-synced list | Avoided | The TTL is sent in the output as `ttl_s`; the mod never repeats it. The word floor, slash and harness lanes exist only in the enforcer. Stage 1 prints nothing for a short draft, so the mod holds no copy of `MAX_SHORT_WORDS` (`enforcer.py:685`). |

## Verification plan

Each check has a pass condition. The builder does not judge its own live result. Per RULES [57], a fresh blind tester runs the live drive and reports raw output.

### V-U. Unit tests (`claude-code/testing` kit)

File: `adapters/claude-code/mod/tests/handoff.test.ts`, importing `hooks/handoff.ts`.

- **U1** `settled`: `""` and `"   "` → false; `"/cook x"` → false; `"fix the failing login test"` → true. Pass: literal expected values.
- **U2** `parseEnforcerOutput`: `{"needs_route":true}` → `needs_route` true; `not json` → null; `[]` → null; output with a trailing blank line still parses the last line. Pass: all four.
- **U3** `statusLine`: band `offer` with three names → `Concierge menu ready: a · b · c`; band `jev_skip` → `Concierge: no skill fits this draft`; band `getaway` → null. Pass: literal strings.
- **U4** `handoffFor`: null slot → null; a ready slot → path `<home>/.claude/skill-concierge/route-hints/<sid>.json`, body with `prompt` = the draft, `route` and `menu` present, `t` in seconds. Pass: all four.
- **U5** Composition at submit: a composer `prompt.submit` with no slot returns the engine's result unchanged and performs no `fs.write` (spy count 0). Pass: both.
- **U6** Coexistence with an inline peer band (`test(…, { plugins: [{ name: 'peer-band', register(on) { … AbovePrompt … } }] }, …)`): mount `AbovePrompt`; the peer's text appears and no `Enhance` string does. Pass: both.
- **U7** An outer peer that rewrites `text` at submit: the mod still returns the peer's result and writes nothing when the slot is empty. Pass.
- **U8** `$.ui.status(undefined)` is called at every composer submit (spy). Pass.

Limit: the kit cannot raise `prompt.autocomplete` (grounding §4). The observer, the timer and precompute are therefore covered by V-L and V-P, not by V-U.

Pass for V-U: all green; `tsc -p .claude-plugin/types/tsconfig.json` clean; `claude plugin validate adapters/claude-code/mod` passes.

### V-P. Python tests (`tests/test_enforcer_menu_handoff.py`, in the style of `tests/test_enforcer_route_hint.py`)

- **P1** Stage 1 on a settled draft prints exactly `{"needs_route": true}` in under 2 s, with the embed and Qdrant ports set to a closed port. No ledger file is written. Pass: exact output, no file.
- **P2** Stage 2 prints `hookSpecificOutput`, `skillConciergeOffer`, `prompt`, `fp`, `built_at`, and `ttl_s` = 300. No ledger row. Pass: all keys present, no row.
- **P3** Serve: the hint carries P2's output, with the same prompt and the same transcript tail. stdout's `additionalContext` equals the stored string byte for byte. One ledger row: `via == "precomputed"`, `q == prompt[:120]`, `offered` equal to the stored value, `lead_ms >= 0`. The hint file is gone. Pass: all.
- **P4** Edited prompt: no `precomputed` row; the route applies if present (`via == "enhancer"`). Pass.
- **P5** Transcript tail changed between precompute and submit: not served. Pass.
- **P6** Empty fingerprint (no transcript found): not served. Pass.
- **P7** Hint `t` 301 s old: not served, and the file is removed. Pass.
- **P8** `ENFORCER_MENU_HANDOFF=0`: not served; the route still applies. Pass.
- **P9** Malformed `menu` (a string, `{}`, or no `additionalContext`): normal path, exit 0. Pass.
- **P10** One-shot: a second run with the same session id serves nothing. Pass.
- **P11** `ENFORCER_LEDGER=0` on a served hit: stdout still carries the context; no row. Pass.
- **P12** Golden: before the change, record stdout and the offer row for ten fixtures (`ENFORCER_JEV_ROUTER=0`, local index owner running, no paid call). After the change, the output is identical except for `t`. Pass: zero differing lines other than `t`.
- **P13** Existing suites stay green: `test_enforcer_route_hint.py`, `test_enforcer_selftest.py`, `test_python39_hooks.py`, `test_hook_definitions_pinned.py`, `test_ledger_harness_rows.py`, `test_jev_staged_menu.py`, `test_cline_plugin.py` (the defer behaviour), and the full `pytest`. Pass: all green.

### V-L. Live drive (one fresh blind tester)

The tester gets only the install steps, the list of prompts below and the instruction to report raw output: screen text, status lines, ledger rows, transcript timestamps. It gets no expected results. The builder then judges each check as pass, fail or couldn't-tell, citing the raw line.

- **L1** Typing does not lag. The author notices no delay on keystrokes. Pass: no visible lag. Couldn't-tell if not observable.
- **L2** Settle and status. Type a twelve-word request and pause four seconds. Pass: the status line names two to five skills, and the ledger has no offer row for the draft yet.
- **L3** Hit path. Repeat L2 and press Enter after the status line appears. Pass: the replayed row has `via == "precomputed"`, `q` equals the sent text, `lead_ms > 0`, and `jev.bench` shows jevd (this checks Open question 1). The transcript shows the stored context and a model reply.
- **L4** Hit latency. Five trials each: arm A, mod disabled; arm B, mod enabled with a four-second pause. Measure Enter to the first assistant record's timestamp in the transcript. Pass target: arm B's median at least 1.5 s below arm A's. This is a design target, not a claim. Report both medians and both ranges.
- **L5** Miss path not worse. Arm C: mod enabled, Enter at once, five trials. Pass: median within +0.3 s of arm A's.
- **L6** Edit after the pause. Type, pause, change one word, press Enter. Pass: no `precomputed` row; the response is normal; no error.
- **L7** Gating. A slash command (`/help`), a three-word draft, and a harness-style message produce no status line and no stage-2 run. Pass: zero status lines and zero stage-2 runs in the process log.
- **L8** Paste. Paste a block, then press Enter. Record whether the row is `precomputed`. Couldn't-tell is acceptable; this documents Open question 2.
- **L9** Coexistence. Re-enable the old prompt-enhancer alongside this mod. Pass: both load; the old band draws; no hotkey conflict; this mod's status line still appears.
- **L10** Desktop surface. Pass: no error toast; the prompt ranks on send as before.
- **L11** Kill switch. With `ENFORCER_MENU_HANDOFF=0`, L2 and L3 produce no `precomputed` row. Pass.

### V-R. Release gates (RULES [26], [75])

- `python3 scripts/driftcheck.py driftcheck.json` exits 0 after the version bump and the doc sweep. The sweep adds `ENFORCER_MENU_HANDOFF` to `docs/runtime-flags.md` and to the AGENTS.md runtime-flags table, plus the epoch note and a CHANGELOG entry.
- `tests/test_hook_definitions_pinned.py` stays green, since `hooks/hooks.json` is untouched.
- `scripts/analyze.py --since <commit that changed enforcer.py>` runs on the new epoch.
- A grep of `scripts/` and `hooks/scripts/` found no reader of the top-level `via` field outside the enforcer. The check is repeated on the release branch.

## Implementation reconciliation

Stub. Filled during implementation: each accepted deviation, its acceptance source, and the contract it changes. None yet.

## Open questions and risks

Each item gives its source, what it is, why it matters, the choice Thinh faces, and my pick.

1. **Does a mod's `$.process.run` carry the harness environment (`JEVD_URL`, `ENFORCER_JEV_*`)?** Source: grounding §3 D8 (unverified). Plain words: the precompute process may not see the variables the hook sees. If it does not, it ranks with no jevd and falls back to the embedding preview, which is the defect v0.67 shipped. Choice: pass `JEVD_URL` explicitly (it is a loopback address, not a secret), or rely on the environment. My pick: pass `JEVD_URL` and check `jev.bench` in the replayed row (L3).

2. **Do pasted blocks reach the hook as the same text the composer held?** Source: d.ts:9061 says `e.text` is "as it will reach the model (pastes already expanded)". The draft seen during typing may show a placeholder. Why it matters: a mismatch costs the hit for that prompt. Choice: accept the miss (safe), or hash the expanded text at submit. My pick: accept now and measure with L8.

3. **Is the transcript at `~/.claude/projects/*/<sid>.jsonl` in this build?** Source: the comment at `enforcer.py:1453`. Not probed here. Why it matters: the fingerprint and Jev's context both need the file. An empty fingerprint is never served (P6), so a wrong path is safe but disables the feature. My pick: keep; print `resolve_transcript` during L3.

4. **Does the settle callback run within its own hook budget?** Source: d.ts:5100–5133 (the clock stops during `$` calls; a `$.clock` wait counts). The budget of a `$.clock.after` callback is not stated. Why it matters: a long precompute could be cut short. My pick: keep the precompute inside `$` calls (the clock stops there) and watch for a lingering or skipped hook in L2.

5. **Settle delay and the three-word floor.** Source: a judgment, with no data. `SETTLE_MS` = 1500 is a guess. Too short floods jevd with routes; too long misses hits. My pick: 1.5 s, then tune from the ledger after one epoch (hit rate and `lead_ms`).

6. **Does the owner want a status line under the prompt?** Choice: keep it (the preview equals the menu) or drop it (the menu reaches the model only). My pick: keep. It is one line, and it is the only way the author sees the menu the model gets. This is Thinh's call.

7. **Does the owner accept dropping the visible Enhance rewrite?** Source: the task invites the call. Grounding §1: the full rewrite ranks last in 11 of 20. Grounding §3: the band collides with the old mod. Choice: keep the rewrite with a fixed collision, or drop it. My pick: drop it. The owner's goal is the menu, the rewrite replaces the author's words, and the band is the collision. The old prompt-enhancer remains installed if Thinh wants the rewrite back.

8. **Is a model-written intent worth one Max call per settled draft?** Source: A/B raw plus intent 13–7, a modest effect, and the intent came from a different generator (a sonnet fork). Choice: keep the intent (haiku), or drop it and rank the draft alone at zero model cost. My pick: keep it, since the intent line is the measured lever. The live drive proves the step runs, not that it ranks better. That is a limit of this design.

9. **Desktop surface.** Source: `$.process.run` is "CLI only" (d.ts:3505–3525). Choice: accept an inert mod on desktop, or find an in-process path (none is known without a process). My pick: accept. The menu there is ranked on send, as today.

10. **Load on jevd and its two Jev channels from typing-time routes.** Channel: Jev through jevd, an approved metered exception (RULES [72]). Why it matters: each settled pause may start a full route. My pick: keep the 1.5 s settle, count the routes per prompt in the ledger, and raise `SETTLE_MS` if the count is high.

11. **If Thinh rejects typing-time spend, use Alternative B.** Source: this document, Alternatives. Choice: keep the typing-time design, or move all ranking to submit and accept about 2.7 s p50 on every Enter. My pick: typing-time, because the owner named latency as the issue. This is the decision most likely to change.

12. **Unmeasured quantities.** Python start-up, the hit path's wall time, the number of typing-time routes, and the intent call's latency. All are measured in V-L (L3 to L5), not assumed.

Risks: (a) an installed skill added within the 300 s window will not appear in a served menu; the catalogue changes rarely, so I accept it. (b) The enforcer change starts a new ledger epoch, so rates must be windowed. (c) A hot reload drops the slot, and the enforcer's normal path takes over, which is safe.

## Next implementation step

Capture the golden fixtures first (P12: today's stdout and offer rows for ten prompts). Then write `hooks/scripts/menu_handoff.py` with its tests, then the enforcer change, then the mod.

Status: DONE_WITH_CONCERNS. The design is complete as a sketch, with no implementation and no run of the live drive. The unverified items are listed above, and their measurements are in V-L.
