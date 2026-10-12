# Cross-judge: concierge-enhancer arena (2026-10-12, Asia/Saigon)

Read-only. Inputs: task, rubric, grounding (+explained), four candidates with sketches. Spot-checked against `enforcer.py` (main, `_route_hint`, `_jev_route`, `_jev_join`, `_jev_start`), `harness.py:30-57`, the current `register.tsx`, the cited `claude-code.d.ts` sections and `reference.md:152-160`. `enforcer.py` on empty stdin, three runs: 0.18 s each.

## 1. Scores (0-3), evidence from each candidate's own text

| Criterion | opus | fable | sonnet | haiku |
|---|---|---|---|---|
| 1 One menu, one ranking | **3** "Jev runs once per sent prompt … The hook redeems that verdict"; preview from "the same `whole_shelf` boolean `_ranked_mandate` receives" | **3** "`_jev_join` returns it at once instead of starting a thread"; `jev.src`, `age_ms` | **3** "`main()` calls `_jev_route` zero times and the injected context equals `_ranked_mandate` over the artifact's rows" | **2** "The stored context goes out byte for byte": annexes, keep-off, chain hint served as of draft time via a second path (`_serve_menu`) |
| 2 Concierge-native, jevd | **3** same `main()`, real sid, transcript by sid; "No TypeScript ranking or jevd client" | **2** "`main()` cut after the Jev start"; but asserts the child "sees `JEVD_URL` and the `ENFORCER_*` flags the hook sees" (see Wrong claims) | **3** "the same `_jev_route` the hook runs", secret guard, `stage == "full"` only | **2** real enforcer, passes `JEVD_URL`; a "Stage 1: lanes only" process per draft exists only to avoid copying one constant |
| 3 Coexistence | **3** "no `AbovePrompt`, no `PromptHint`, no hotkey and no added `context`"; inline non-composing PEER test | **3** band wraps `next(e)`, "`tail` appended, `context` untouched"; composing and non-composing peers tested | **3** "Not registered: ui.render, command.register, prompt.edit, prompt.fill, hotkeys"; both chain orders | **3** status only; peer check thin ("no `Enhance` string does") |
| 4 Seamless, fail-open | **3** "`redeem` never waits past the caller's own deadline"; matching run kept alive across Enter | **2** waits "at most 3750 ms − age" *before* `next(e)`; on a miss the hook then spends its own 7.8 s: worst case exceeds today's; two Jev routes at once | **3** adopt wait "at most 3 s, then falls through to the live route with the rest of its 7.8 s budget" | **2** never waits, but 1.5 s settle + stage-1 start-up + 15 s intent cap means few hits; no run cap |
| 5 Interface depth | **2** 4 methods, but a 5-state ticket, ctx+env fingerprints, pid liveness, polling | **2** 3 pure functions, one file; `--prepare` mirrors `main()`'s head, needs the `_early_lane` hot-path refactor | **2** 9-function `prerank.py`, pending markers, sweep; a `Ports` layer; three flags | **2** small module; two-stage stdin protocol to avoid one constant |
| 6 Honest to evidence | **3** Fact/Inference/Unmeasured labels; "That Jev dominates the wait is an **Inference**" | **2** "estimate" labels; env inheritance stated as fact | **3** self-measured start-up 0.17-0.19 s (reproduced: 0.18 s); "What I did not check"; `calibrate_jev_gate.py:695` verified | **3** L4 "a design target, not a claim"; blind tester per [57]; only one to note `process` is "CLI only" (d.ts:3500) |
| **Total** | **17** | **14** | **17** | **14** |

**Rubric leakage.** Opus shows none of the rubric's phrases. **Haiku** cites it by number: "This loses on one ranking (rubric 1)" (rationale line 117).

**Wrong or overstated claims.**
- opus: "harness.py reads `CLAUDE_PLUGIN_ROOT` first". Wrong: `SKILL_CONCIERGE_HARNESS` comes first (`harness.py:31-33`); its fix (set that var) still holds.
- fable: child env equals the hook's env. d.ts 8014/8105 says only "over the host process's own environment"; equivalence with the command hook's env is grounding D8, unverified. All four depend on it; only fable states it as settled. Its "never above today's p90" covers the wait alone, not wait + miss.
- sonnet, haiku: list "does a `$.clock.after` callback keep a usable `$`" as open. `reference.md:152-160` answers it: start from `session.start`; timers "run until cancelled or until the module reloads". Opus cites this correctly.

## 2. Convergence and differences

All four converge: rank the settled draft before Enter with concierge's own enforcer (real sid, transcript by sid, Jev through jevd), hand the verdict to the hook, serve it instead of routing again; a haiku intent line feeds the ranker only; the Enhance band, hotkey `e`, `prompt.fill` and fake preview session go.

| Axis | opus | fable | sonnet | haiku |
|---|---|---|---|---|
| Handoff | Jev verdict, Python-to-Python ticket | Jev verdict + route in v2 hint, mod writes at Enter | Jev verdict artifact, Python-to-Python | whole rendered menu + row, replayed |
| Preview | `$.ui.status` | PromptHint `tail` + composing band row | `$.ui.status` | `$.ui.status` |
| Wait at Enter | hook polls ticket inside its Jev deadline | mod waits ≤3750−age before `next(e)` | worker adopts pending marker ≤3 s inside deadline | none |
| Intent timeout / caps | 2.5 s; 700 ms settle, 6 runs/draft, pause in turns | 2.5 s; 1200 ms, single-flight, no cap | 1.2 s, `CONCIERGE_INTENT=0`; 1000 ms, 8/min, secret guard | 15 s; 1500 ms, single-flight, no cap |
| Keying / freshness | sha256(sent)+sid, ctx and env fingerprints, 900 s, pid | prompt equality, mtime 300 s, `jev.route == rank_text`, 120 s, catalogue membership | digest file name, `skey(route, prev, skills)`, 300 s, full stage only | prompt equality, transcript-tail fingerprint, 300 s |
| Old route hint | deleted | v1 → v2 | deleted with `_VIA`; `via` dropped | kept, extended with `menu` |

## 3. Recommendation

**Base: opus.** The hook never writes; its wait lives inside the hook's existing Jev deadline (the only design whose worst case provably equals today's); the speculative run is the unmodified `main()`, so the preview reflects every gate; the env fingerprint turns D8 into a per-turn ledger fact. Sonnet ties on score; its store and `Ports` layer are larger for the same guarantee.

**Grafts.**
- sonnet: skip drafts matching `_JEV_SECRET_RES` (enforcer.py:1580); settle only `stage == "full"` as `ranked`; a per-run ledger row so abandoned drafts are countable (opus's `spec.n` shows only on served rows); the `CONCIERGE_INTENT=0` control arm.
- fable: catalogue-membership check before serving handed rows; `jev.age_ms` beside `src`.
- haiku: pass `JEVD_URL` explicitly to the child; golden-fixture test that the no-mod path is byte-identical; document that desktop gets no speculation.

**Reject.** Haiku's whole-menu replay (stale annexes, second serve path) and stage-1 process. Fable's pre-hook wait (outside the budget that bounds it) and band row (the one shared surface claimed; status suffices). Sonnet's dropping of top-level `via` (grounding §6 names it). Opus's 700 ms settle with 6 runs/draft is aggressive; start at 1000 ms, tune from `spec.n`.

## 4. Riskiest unverified assumption

That a child spawned by the mod runs with the command hook's effective environment (D8: `JEVD_URL`, `ENFORCER_*` from settings.json `env`, harness detection without `CLAUDE_PLUGIN_ROOT`). If not, every ticket misses on the env fingerprint and the feature is silently inert (visible only as `spec.st = "env"`). The value assumption, that people pause ≥ ~3 s before Enter, is unmeasured; only the ledger answers it.

**Cheapest live check.** Extend `probe/hooks/probe.ts`: on `session.start`, keep `$`, arm `$.clock.after(3000, …)` running `$.process.spawn({argv:['sh','-c','env']})` and write stdout to `~/.tmp/ce-probe/child-env.txt`; add a settings.json `UserPromptSubmit` hook `env > ~/.tmp/ce-probe/hook-env.txt`. `diff` the two for `JEVD_URL`, `ENFORCER_*`, `CLAUDE_PLUGIN_ROOT`. The file's existence also proves a `session.start` `$` survives into a timer (opus Q4).

## Not checked

No test kit, Jev, jevd or live session run; grounding latencies not re-measured; `design.md` not read.
