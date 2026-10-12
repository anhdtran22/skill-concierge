# concierge-enhancer v2: the typing-time handoff

Candidate `fable`, 2026-10-12 (Asia/Saigon). Sketch: `sketch/mod/hooks/register.tsx`, `sketch/mod/types/index.d.ts`, `sketch/mod/tests/concierge-enhancer.test.ts`, `sketch/enforcer-handoff-sketch.py`. Line numbers cite `hooks/scripts/enforcer.py` at v0.67.0 and the grounding files.

## Problem

Every Claude Code turn, `enforcer.py` ranks the shelf and hands the model a five-row menu as `additionalContext`. The best menu is Jev's whole-shelf ranking, and Jev is slow: full stage p50 2656 ms, p90 3746 ms, max 6383 ms, and 6 of 99 ranked turns in the current epoch hit the 7.8 s budget and fell back to the embedding "Preview", a weaker menu with weaker doctrine duties (grounding §2). The person feels that time after Enter: the probe measured 2.6 s from `prompt.submit` to `next(e)` resolving (P5). The v0.67.0 mod did not touch this. It copied the standalone prompt-enhancer's band, rewrote the prompt box on a click, and ran a second, context-free enforcer to scrape a preview that could differ from the model's menu (D1–D8). The owner's goal is the menu itself: "enhance & optimize the menu of 5 offers initially", "integrated with how the concierge works", using Jev through jevd, without colliding with other mods.

The constraints the shape must honor: one menu per turn from one ranking, with a truthful header; the hook's lanes judge the sent text; offer and turn rows pair on `(sid, q)`; `hooks/hooks.json` is pinned; a mod cannot see or edit the command hook's output (P3) and must not depend on `classic.UserPromptSubmit`; a file written in `prompt.submit` before `next(e)` is on disk when the hook runs (P5); `prompt.autocomplete` is a free draft observer (P6); `$.process.run` env is laid over the host's own, so a child sees `JEVD_URL` and the `ENFORCER_*` flags (d.ts `ProcessRunInit.env`, documented); 81 % of hook calls are harness text that never passes through the composer; everything must fail open and every other harness must keep working unchanged.

## Usage (caller's view)

There are three callers: the person, the hook, and a peer mod. None of them calls a function.

**The person.** Install the mod; type as always. While a draft of four or more words sits still for 1.2 s, the prompt hint's dim tail says `concierge: ranking…`, then `concierge: 5 ranked (full)`, and the band above the prompt shows one dim row: `Concierge · whole-shelf: ui-styling ⭐ 61% · frontend-design 22% · ak-test ❤️🔥 17% · …`. Press Enter. The turn starts about two seconds sooner than today, and the menu the model reads lists exactly the rows the band showed. Edit the draft and the row disappears until the next pause. Type three words, a `/command`, or send from a notification: nothing happens and nothing is drawn. There is no button, no hotkey, no "Enhance", and the prompt box is never rewritten.

**The hook.** `main()` reads the handoff where it read the route hint today:

```python
_hand = _handoff(sid, prompt)                      # :3061, consumed first, one-shot
lane = _early_lane(prompt, data)                  # the same six lanes, one list
...
_jev_job = None if _hits else (_jev_handed(_hand and _hand.get("jev"), prompt)
                               or _jev_start(prompt, data.get("transcript_path") or ""))
_jev = _jev_join(_jev_job)                        # a handed job joins at once
```

**The mod's own prepare call**, the one new process the mod starts:

```ts
const run = await $.process.run(['python3', script, '--prepare'], {
  stdin: JSON.stringify({ prompt: draft, route: `${draft}\n\n${intent}`, session_id: await $.session.id() }),
  env: { ENFORCER_LEDGER: '0' }, timeoutMs: 12_000 })
const out = parsePrepareOutput(run.stdout, draft)   // { handoff: string, view: PreparedView } | null
```

and at Enter: `await $.fs.write(handoffPath, prepared.handoff)` then `return next(e)`.

**A peer mod** needs to know nothing. Our `AbovePrompt` hook awaits `next(e)` and draws under it; our `PromptHint` hook appends to `e.props.tail`; our `prompt.submit` hook passes `e` on unchanged. A peer above us that does not call `next(e)` hides our band row; the tail and the handoff still work.

## Shape

**Data.** Three types carry the design. `Prepared = { text, handoff: string, view: PreparedView, at }` is a finished prepare for one exact draft; `handoff` is opaque bytes the hook owns, `view` is what the band draws, derived by the same Python from the same rows (`_view_of`), so the preview and the menu cannot disagree. `Inflight = { text, startedMs }` is the one prepare that may be running. Both live in `$.state` under the mod's name, written only by the mod, read by the two render hooks (per separate-before-serializing-shared-state: one writer). On the Python side the handoff file is `{"v": 2, "prompt", "route"?, "jev"?: {"route", "result", "event", "t"}}`, validated once in `_jev_handed` and `_handoff` and then trusted as the tuple `_jev_join` already returns (per boundary-discipline).

**Flow.** `prompt.autocomplete` → `observe` (compare, reset a `$.clock.after` quiet timer, drop a preview that no longer matches the draft) → `prepare` (one in flight: `$.model.complete` on `haiku` for the intent line, then `enforcer.py --prepare`, which runs `_early_lane`, `_route_hits`, `_is_english` and `_jev_route` exactly as the hook would, synchronously, against the real session transcript located by id) → `Prepared` in state → the band and the tail redraw from it. `prompt.submit` (composer only) → `settlement` (ready / wait / none) → write the handoff bytes → `next(e)` → the hook consumes the file, runs its lanes on the sent text, applies the route text, checks that the handed verdict was computed on that very text and is under 120 s old, skips its own Jev thread, and runs embed, Qdrant, keep-off, blocklist, annexes, pull-ins, chain hint, render and the ledger row byte-identically. The offer row carries `via: "enhancer"`, `rq` when a route differed, and `jev.src: "handoff"` with `jev.age_ms`.

**Load-bearing decisions.**

- *The hook stays the one ranker and the one renderer.* The mod never computes rows, never scrapes text, never injects a menu. `--prepare` is `main()` cut after the Jev start; `_early_lane` is extracted so the two entries share one lane list (per single-source-of-truth; a hand-synced lane list is the red flag this avoids). The Jev route is the same function with the same jevd ladder, the same catalogue, the same transcript context (D1, D4 closed) and the same budget cap, so a handed verdict is indistinguishable from a threaded one except for `jev.src`.
- *Jev moves off the critical path by being started earlier, not by being made faster.* The quiet-time trigger spends the person's own typing pauses. At Enter, a prepare still in flight for the exact text is awaited for at most `3750 ms − age` (Jev's measured p90), so the person never waits longer than the hook's own route would have taken at p90. This is where jevd matters: warm, loopback and keyless, it can be driven from a second process before the turn exists, and its `/ladder` gives both passes the same tiers (ADR-0080). Timeouts that fell back to the Preview (6 of 99) become whole-shelf menus when the pause covers the route.
- *The intent line feeds Jev, not the model.* The only measured ranking gain in the A/B is raw draft + one intent line (13-7 over raw, n=20, modest). It is generated on `haiku` on the session's own client (Max, per RULES [72]), under the standing rules (no skill names, verbatim terms, no questions), and becomes `route`. The ledger's `rq` records it per row, so the epoch can compare `via:"enhancer"` rows with and without `rq` against plain rows, something v0.67.0 could not do because it ranked in a fake session.
- *The visible Enhance rewrite goes.* The owner's goal is the menu; the A/B ranked the full rewrite worst (last in 11 of 20); the owner's verdict on v0.67.0 was that it copied prompt-enhancer. Removing it also removes `$.prompt.fill`, the `e` hotkey, the Button, the focus-chord reader, and the fake preview session: fewer surfaces to collide on and nothing that changes what the person sends. The standalone prompt-enhancer can be re-enabled beside this mod; if it rewrites `text` at submit above us, our exact-match fails and the hook routes as today.
- *Composition on every shared surface.* `next(e)` inside the band tree, `tail` appended, `context` untouched, `text` untouched, no hotkey, no `$.ui.status`, no toast. The band row is the one element that can be hidden by a non-composing peer; the tail is the fallback indicator.
- *Freshness by mtime, one-shot by unlink.* The hook accepts a file whose mtime is within 300 s and whose `prompt` equals the sent text, then unlinks it (as `_route_hint` does today); it adopts the Jev block only when `jev.route` equals the text it is about to rank and `jev.t` is within 120 s. The mod therefore never stamps or edits the handoff: it writes the bytes Python printed.

**Interface depth.** Public surface: zero commands, zero interactive elements, one file the hook already reads, one CLI flag on a script the repo already ships, three `$.state` keys, three exported pure functions (`eligible`, `settlement`, `parsePrepareOutput`) that exist as the test seam. Behind it: debounce, single-flight, stale-result discard, bounded wait, intent generation, transcript lookup, the full Jev route and its validation. Callers learn nothing about Jev tiers, catalogue scopes, or the menu grammar. What stays exposed is one schema shared by two processes of the same repo (`handoff`), owned by `enforcer.py`, read by the mod through one field.

**What it deliberately does not do.** It does not inject anything through `prompt.submit` `context` (that would be a second menu). It does not rewrite the prompt. It does not run when the hook would not rank (lanes, short, slash, non-composer). It does not prepare on `prompt.edit` (documented, unprobed, on the keystroke path). It does not touch `hooks/hooks.json`, `ENGINE_ENV_KEYS`, or any other harness.

## Turn timeline

Numbers from grounding §2 and §4; "estimate" marks what is not measured.

| When | Process | What happens | Felt latency |
|---|---|---|---|
| keystrokes | engine → mod (`prompt.autocomplete`, unawaited) | compare draft, reset quiet timer | none (P6: engine does not wait) |
| last keystroke + 1200 ms | mod | `$.model.complete` haiku intent (estimate ~1 s, unmeasured); then `python3 enforcer.py --prepare` | none; runs while the person reads or thinks |
| + Python start-up (unmeasured) + Jev route | child enforcer → jevd (`commandcode` p50 980 ms/call, two calls; full stage p50 2656 ms) | lanes, named routes, `_jev_route` on draft+intent with the real transcript | none |
| prepare lands | mod | `Prepared` in state; tail and band redraw | none |
| Enter | engine → mod (`prompt.submit`) | `settlement`: ready → write ~2 KB file; wait → at most 3750 ms − age; none → nothing | 0 ms (ready) to the remaining Jev time (wait), never above today's p90 |
| `next(e)` | engine → command hooks: `enforcer.py` (10 s cap) then `ledger.py` | consume handoff, lanes on sent text, embed p50 83 ms, Qdrant p50 25 ms, two annex queries, render, offer row | estimate 0.3–0.6 s incl. Python start-up, against 2.6 s measured today |
| model request | engine | prompt + the one `additionalContext` menu, whole-shelf header | the turn starts |

Worst case (Enter the instant the draft is finished, no prepare started): identical to today. Typical case (any pause of a few seconds): the Jev time is paid before Enter.

## Synthesis decision

*(left empty for arena)*

## Tradeoffs accepted

- We accept extra Jev calls on abandoned drafts (each 1.2 s pause on an eligible draft may start one route, one at a time, stale results discarded) in exchange for a menu that is usually ready at Enter and never falls back to the Preview for lack of time. The ledger cannot see prepare calls (`ENFORCER_LEDGER=0`); jevd's own counters can.
- We accept a per-pause `haiku` call on the session's Max client in exchange for ranking draft+intent, the one measured improvement, with `rq` making it measurable per row.
- We accept that the band row can be hidden by a non-composing peer above us, in exchange for never contesting the band; the tail still reports and the handoff still works.
- We accept a bounded wait at Enter (≤ 3750 ms − age) in exchange for one Jev route per turn instead of two when the person sends mid-prepare; the cap keeps it at or under today's p90.
- We accept locating the transcript by session id (`<config>/projects/*/<sid>.jsonl`) instead of receiving `transcript_path`, which the mod API does not expose; a miss yields empty context, as a missing path does today.
- We accept removing the visible rewrite, a feature the owner asked for in v0.67.0, because the A/B and the owner's verdict both point away from it; it is not a regression of the menu.
- We accept that a `whole_shelf` view omits annexes and pull-ins the hook will append: the band previews the ranked rows, the menu adds its blocks around them.

## Alternatives considered

- **Rank in TypeScript against jevd directly, inject the menu as `prompt.submit` context.** Exposes the whole Jev grammar (catalogue scroll, wide/rerank questions, `_jev_decide`, pull-ins, badges) to a second implementation, cannot switch the hook's own Jev off (no proven env channel into the command hook), and gives the model two menus. Lost on one-ranking and on depth: it hides nothing and duplicates everything.
- **Keep the v0.67.0 band and fix D1–D8 point by point** (pass the transcript, use `defer`, reuse the session id). Still two Jev runs per enhanced turn, still a click, still a hint that carries text rather than a verdict; the fake preview session goes but the shape stays the standalone enhancer's. Lost on seamlessness and on the owner's verdict.
- **Hook-only: cache Jev verdicts in the enforcer keyed by `(sid, text)`.** Without a draft observer the cache fills only at Enter, so nothing is ever warm; the mod is the only process that sees typing. Lost because it cannot start work before the turn.
- **Write the handoff as soon as the prepare lands, not at Enter.** Simpler submit hook, but the hook consumes any file on the next prompt whatever its origin, so a peer message or notification arriving between the pause and Enter would spend it, and an in-flight prepare could not be awaited. Lost on one-shot discipline.
- **A two-pass hook like Cline's (fast preview served first, full menu later).** Claude Code's command hook returns once; there is no later model call to carry a late menu. Not available on this harness.

## Implementation reconciliation

*(stub: accepted deviations, their sources, and the contract updates go here during Phase D)*

## Red-flags screen

| Red flag | How this design avoids it, or why it does not apply |
|---|---|
| Shallow module | Public surface: one file channel, one CLI flag, three state keys, three pure test seams. Behind it: debounce, single-flight, bounded wait, intent, transcript lookup, the whole Jev route. No caller coordinates methods; no option exposes a stage. |
| Information leakage | The handoff schema is produced and validated in `enforcer.py` only (`_prepare`, `_handoff`, `_jev_handed`); the mod carries it as a string and reads one field. The band's `view` is derived from the same rows by the same Python, not re-derived in TS. |
| Temporal decomposition | `--prepare` and `main()` differ in *when*, not in *what they know*: both live in `enforcer.py`, share `_early_lane`, `_route_hits`, `_jev_route`, `_view_of`'s share formula. Nothing is split by execution stage into separate modules. |
| Pass-through method | `_jev_handed` adds policy (text equality, TTL, catalogue membership) before producing a job; `settlement` adds the ready/wait/none decision. Neither forwards the same shape unchanged. |
| Split ownership | `$.state` keys: written by the mod only. The handoff file: one writer (mod, at submit), one reader (hook, consumes). Jev results: computed by `enforcer.py` in both passes. `_VIA`, `_JEV_EVENT`: hook only. |
| Two ways to do one task | `_route_hint` v1 is replaced by `_handoff` v2, not kept beside it; `rankMenu` text scraping and the fake preview session are deleted; the only Jev route is `_jev_route`. |
| Importable internals | TS exports: `register` plus the three pure functions named as the test seam; module-level timer and draft are not exported. Python helpers are module-private by the file's convention (`_` prefix). |
| Hand-synced list | The six lanes become `_early_lane`, called by both entries. The band's rows and shares come from `_view_of`, the hook's from `_ranked_mandate`; both compute `round(score/total*100)` from the same rows, pinned by the Python test that feeds a `--prepare` handoff back into the hook and compares names and order. |

## Verification plan

Each item names its pass condition. No step calls a paid model or jevd during design; the live drive is a release step.

**Python (`pytest tests/`), new `tests/test_enforcer_handoff.py`:**

1. *Handed verdict is served and the thread never starts.* Monkeypatch `_jev_start` to raise; run `main()` with a v2 file holding a Jev `offer`. PASS: stdout's `additionalContext` carries `WHOLE_SHELF_HEAD` and the handed row names in order; offer row has `via == "enhancer"`, `jev["src"] == "handoff"`, `jev["age_ms"]` an int; the file is gone.
2. *Stale or mismatched Jev block is ignored.* `jev.t` older than 120 s, or `jev.route` ≠ ranked text. PASS: `_jev_start` is called (monkeypatched to return a skip); row has no `jev.src`.
3. *Route-only handoff ranks the route text.* PASS: `q == prompt[:120]`, `rq == route[:120]`, as today's `test_enforcer_route_hint.py` asserts.
4. *`--prepare` mirrors the lanes.* For a `/cmd`, a three-word draft, a `_HARNESS_MSG_RE` text, a refusal, a consult, a self-reference: PASS: `view.kind == "lane"` with the right name, `handoff.jev` absent, no HTTP attempted (monkeypatch `_jev_route` to raise).
5. *`--prepare` on a named skill.* PASS: `view.kind == "named"`, rows lead with the named skill, `_jev_route` not called.
6. *Round trip is one ranking.* Monkeypatch `_jev_route` to a fixed result; run `--prepare`, feed its `handoff` to `main()` as the file. PASS: the names and order in `view.rows` equal the bullet rows of the rendered menu; the header is whole-shelf.
7. *Catalogue membership.* A handed row naming a skill absent from `_jev_catalog()` → PASS: the hook routes itself (`jev.src` absent).
8. *Python 3.9 load* (`tests/test_python39_hooks.py`, existing). PASS unchanged.
9. *Freshness by mtime.* A file with mtime 301 s old → PASS: ignored and unlinked.

**TypeScript (`claude plugin test adapters/claude-code/mod`), sketched in `sketch/mod/tests/concierge-enhancer.test.ts`:**

10. Pure contracts: `eligible`, `settlement`, `parsePrepareOutput`. PASS conditions in the file.
11. Quiet eligible draft → exactly one `process.run` with `--prepare`, `stdin.prompt`, `stdin.route`, `stdin.session_id`, `env.ENFORCER_LEDGER === '0'`; `$.prompt.fill` never called.
12. Stale result discarded; single-flight with chaining; failed prepare leaves no state and no toast.
13. Submit of the prepared text writes the handoff bytes verbatim to `route-hints/<sid>.json` before the bottom hook runs; state is one-shot.
14. In-flight wait capped at 3750 ms − age on the mocked clock.
15. Edited draft, non-composer origin, slash command → no write, `e` unchanged.
16. Band row and tail per view kind, on `['terminal', 'desktop']`; no `Button` in the tree.
17. Inline peer that composes: both trees drawn, tail order `peer  concierge: …`. Inline peer that does not compose: our row absent, tail present, handoff still written.
18. `claude plugin validate adapters/claude-code/mod` reports the module hooks `prompt.autocomplete`, `prompt.submit`, `ui.render` ×2 and lists no gating hook without `.catch` that we did not intend (`prompt.submit` is a gate; it calls `next(e)` on every path).

**One live drive (release step, interactive session, `claude --debug --plugin-dir adapters/claude-code/mod`):**

19. Type a real English task prompt of ≥ 4 words, pause 3 s, observe tail `concierge: ranking…` then `concierge: N ranked (full)` and the band row; press Enter. PASS: the ledger's offer row for that `q` has `via:"enhancer"`, `jev.src:"handoff"`, `band:"offer"`; the transcript's `additionalContext` header is whole-shelf and its first five bullet names equal the band row's names in order; `jev.n` in the row equals `view.n` printed by the prepare (same catalogue scope in both passes).
20. Measure the hook's wall time with a `prompt.submit` timestamp pair (as the probe did): PASS: `next(e)` resolves under 1.0 s on the handed turn, against the 2.6 s probe baseline.
21. Type and send immediately (no pause). PASS: no `via` on the row, menu present, nothing broken.
22. Re-enable `prompt-enhancer@prompt-enhancer`, repeat 19. PASS: no `skipped` or `refused` hook lines for either plugin in the debug log; either both bands show or ours degrades to the tail; the handoff row still appears when the sent text equals the draft.
23. Send a peer message or let a task notification arrive between the pause and Enter. PASS: that turn's row has no `via`, the next composer send still gets its handoff.

## Open questions and risks

- Should the intent stage ship on by default, or should the first epoch run Jev-only to isolate the latency win from the ranking change? My pick: on, with `rq` present only when an intent landed, so both populations exist in one epoch.
- Does the drawing `next(e)` resolves to work as a JSX child of our `Box`? The d.ts says "return it, wrap it" (ui.render); the kit test 17 proves or refutes it before release. Fallback is in the sketch.
- Does awaiting another dispatch's `$.process.run` promise inside `prompt.submit` count against that hook's own 10 s budget? The cap of 3750 ms keeps us inside either way; the live drive confirms no `skipped` line.
- Is `<config>/projects/*/<sid>.jsonl` the transcript's location under `CLAUDE_CONFIG_DIR`? Observed on this machine for `~/.claude`; a miss only costs the context, not the menu.
- Are 1200 ms quiet and the 3750 ms cap the right numbers? Both are tunables with a cited source; one epoch of `jev.age_ms` and prepare counts from jevd should settle them.
- `analyze.py` does not split rows by `via` today; the epoch's handed vs plain comparison needs that split (a follow-up, not in this change).
- Cline's plugin runs two passes per turn; `--prepare` plus a handed `--defer` could replace that (RULES [70] backport candidate), out of scope here.
- jevd concurrency: a prepare in flight plus the hook's own route on a missed handoff means two routes at once; acceptable for jevd v0.2.0? Unverified.

## Next implementation step

Extract `_early_lane` from `main()` in `enforcer.py` with a test proving `main()`'s six lane outcomes are unchanged, then add `_handoff` / `_jev_handed` behind it.
