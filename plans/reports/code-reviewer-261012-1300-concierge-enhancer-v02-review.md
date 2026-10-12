# Code review: concierge-enhancer v0.2 (uncommitted), 2026-10-12

Reviewer: independent code-reviewer subagent (did not write this code). Read-only lane: no source file changed. Scratch work lives outside the repo in `~/.tmp/cr-review-261012/` (a copied mod with two probe tests, one probe pytest file, a scratch HOME for a Python 3.9 run).

Contract: `plans/261012-1206-concierge-enhancer-redesign/design.md` (read in full), background `grounding.md`, mod API `plugin-authoring/` 2.1.296 (`reference.md`, `types/claude-code.d.ts`).

## Verdict

**NO-GO for release as the tree stands.** Two High findings break stated invariants: a served ticket bypasses the blocklist and the session's current catalogue (H1, reproduced offline), and the three-runs-per-prompt cap does not hold (H2, reproduced in the kit: 7 runs against a cap of 3). Both fixes are small. Release after H1, H2 and the doc corrections in M5 land, the suite is re-run after the commit, and the owner either accepts or fixes M1 and M2.

Counts: Critical 0 · High 2 · Medium 5 · Low 9.

## Scope

- `hooks/scripts/enforcer.py` (+192 −62), new `hooks/scripts/offer_ticket.py` (352 lines), new `tests/test_offer_ticket.py` (558 lines; replaces the deleted `tests/test_enforcer_route_hint.py`).
- `adapters/claude-code/mod/`: new `hooks/speculator.ts` (522 lines), rewritten `hooks/register.tsx` (99 lines), new `tests/concierge-enhancer.test.tsx`, `.claude-plugin/plugin.json`, `types/index.d.ts`.
- Docs: README "See the skill menu before you send", AGENTS.md, `docs/runtime-flags.md`, `docs/repository-layout.md`, `.claude-plugin/marketplace.json`, and (they appeared in the tree during this review, after my first `git status`) CHANGELOG 0.68.0, the version bump in the five manifests and `openwiki/quickstart.md`. The reviewed code files did not change during the review (SHA-1 checked at 13:02 and again at the end).

## Checks run

| Command | Result |
|---|---|
| `python3 -m pytest tests/test_offer_ticket.py -q` | 59 passed (3.09 s) |
| `claude plugin test adapters/claude-code/mod` | 27 pass, 0 fail |
| `claude plugin validate adapters/claude-code/mod` | passed; hooks: session.start, prompt.autocomplete, turn.start, turn.complete, prompt.submit, session.end; no `ui.render`; env writes: nothing |
| `python3 scripts/driftcheck.py driftcheck.json` | rc 0, "IN SYNC" |
| `/usr/bin/python3 -c "import ast…" hooks/scripts/*.py` (3.9.6) | all parse |
| `pytest tests/test_python39_hooks.py tests/test_hook_definitions_pinned.py tests/test_no_undefined_names.py` | 17 passed (`hooks/hooks.json` unchanged) |
| `tsc --noEmit -p .` on a scratch copy of the mod | rc 0 |
| Full suite `pytest tests` | 1595 passed, 20 failed: all 19 in `tests/test_codex_installer.py` plus `test_installer_staging_cleanup.py::test_a_signal_killed_codex_export_leaves_no_staging_dir_behind`. Cause: the codex installer refuses because ".claude-plugin/plugin.json says v0.68.0 but HEAD carries v0.67.0" (the uncommitted bump). Not caused by this code; re-run after the commit. |
| Python 3.9 end to end, scratch HOME, `ENFORCER_JEV_ROUTER=0` (no Jev) | speculative run: rc 0, last line carries `skillConciergeSpeculation` (`ticket: unranked`), ticket file mode `-rw-------`, one `speculate` row; hook run for the same text: rc 0, offer row `via: enhancer`, `spec.st: unranked`, `q` as sent |
| Import cost of `offer_ticket` inside the enforcer (`-X importtime`) | 1.6 ms (3.9) / 2.2 ms (3.12) per turn, every harness |

No Jev, jevd or paid model was called. The design's live tmux drive was not repeated by me (decisions.tsv 05:58 records the builder's drive).

## Scout: edge cases checked

Sessions without the mod and the seven other harnesses; `ENFORCER_TICKET=0`; ticket races (newer run, killed run, pid reuse, partial writes); stale context (turns, compaction, notifications); file-backed state outside the fingerprints (blocklist, keep-off, enabledPlugins, index, cwd); the hook's deadline when it waits; ledger consumers and unknown `ev`; mod lifecycle (reload, /clear, subagents, running turn, notification turns, desktop, pastes); secret drafts; Python 3.9.

---

## Critical

None.

## High

### H1. A served ticket bypasses the blocklist, keep-off and the session's current catalogue for up to 15 minutes

- Where: `hooks/scripts/enforcer.py:2344-2380` (`_jev_start` serves `red.verdict.result` as is), `enforcer.py:3344-3345` (`shown = _jev_rows`, no filter), `offer_ticket.py:43` (`TICKET_TTL_S = 900`), `offer_ticket.py:115-127` (the env fingerprint covers env vars only).
- Why: live Jev rows are filtered inside `_jev_catalog` (`enforcer.py:1922-1945`: `_row_invocable`, `_drop_keepoff`, `_drop_blocklisted`). A served verdict skips `_jev_catalog`, and nothing re-filters it. The fingerprints cover env vars and the transcript, not `blocklist.json`, `keep-off.json`, `installed_plugins.json`, `enabledPlugins`, the project cwd or the index. The design's own text says the opposite: "a hook that redeems only the Jev leg (so lanes, keep-off, blocklist, annexes and chain hints stay live)". The cross-judge proposed the fix ("catalogue-membership check on a served verdict", `arena/cross-judge.md:43`); it was not adopted.
- Reproduced offline (`~/.tmp/cr-review-261012/py/test_probe_ticket.py`, stubbed Jev): speculate with an empty blocklist, then block `ak-git`, then send. The hook's `_blocked("ak-git")` is True, yet the served menu is `['ak-git', 'update-config']` with `spec.st = ready`, `jev.src = ticket`.
- Failure scenario: the owner blocks a skill (`scripts/blocklist.py`), or disables a plugin with `/plugin disable`, or a reindex drops a skill, while a draft sits settled. He sends it within 15 minutes. The model gets the blocked or uninstalled skill as the top "Whole-shelf ranking" row; `skill_guard.py` then denies the invocation, so the turn wastes a round and the user-ordered disable tier (ADR-0046) is visible in the menu.
- Fix: in the worker, after a hit, pass the served rows and pull-ins through `_drop_blocklisted` and `_drop_keepoff` (pure, no I/O) and treat an emptied menu as a miss. Add to the env fingerprint the mtimes of `blocklist.json`, `keep-off.json`, `installed_plugins.json`, the three settings layers, `Path.cwd()`, and the last reindex stamp. Consider a TTL of 120 to 300 s, as the other three arena candidates chose.

### H2. The "at most three runs per composed prompt" cap does not hold: every turn start resets it

- Where: `adapters/claude-code/mod/hooks/speculator.ts:296-310`, line 303 `this.runs = 0` inside `working(true)`.
- Why: `turn.start` fires for every main-loop turn, including turns started by task notifications, Monitor events and peer messages. Each one cancels the run, resets the count, and `turn.complete` re-arms the settle timer for the same unchanged draft.
- Reproduced in the kit (scratch copy, probe test): one unchanged draft across 6 notification turns spawned **7** enforcer runs; `MAX_RUNS_PER_DRAFT` is 3.
- Failure scenario: the owner composes a long prompt while a background agent or Monitor raises a notification turn every minute. Each turn spawns one more speculative run: two Command Code Jev calls each (wide pass over about 616 skills, then the rerank), plus a haiku call when `intent` is on. The count is bounded only by the notification rate. README, CHANGELOG:28 and `docs/repository-layout.md` all promise three.
- Fix: do not reset `runs` in `working(true)`. Reset it only on send (`:331`), an emptied box (`:283`) and `end()` (`:348`). Add a kit test with N notification turns that asserts at most 3 spawns.

## Medium

### M1. When the hook waits on a run that then fails, the ADR-0087 wide safety net is lost

- Where: `enforcer.py:2411-2418` (only a full-stage result is stored; the run's wide menu is discarded), `offer_ticket.py:343` (the wait ends at the run's deadline + 0.3 s), `enforcer.py:2374` (the live fallback gets only the time left).
- Why: the docs claim "`unranked` for a wide-only or failed route, so the hook keeps its own full-budget chance and the ADR-0087 wide safety net". That is true only when the run settled before Enter. If Enter lands while the run is still ranking, the hook spends its budget waiting; when the run settles `unranked` near its deadline, the hook's live route has about 1 s left. Every tier needs more than that (`timeout` 1.5 s TypeSafe, 5.5 s Command Code), so both are skipped. Reproduced: real `_jev_route` with `deadline = now + 1.1` returns `result None`, `fell [['m-cc','NoTime'], ['m-ts','NoTime']]`.
- Failure scenario: jevd's Command Code tier is slow (6 timeouts among about 99 Jev-routed rows in the grounding epoch). The user pauses, sees no status yet, presses Enter. Today that turn would still get the wide menu (Jev, whole shelf). With the mod it gets the embedding "Preview" menu, although the speculative run held a wide menu and threw it away.
- Fix: store the wide-stage result in the ticket as a separate `wide` verdict, and let `redeem` return it, marked `stage: wide`, when it ends `late` or `unranked` with less time left than the smallest tier timeout. Or accept it explicitly and correct the docs (M5).

### M2. The status line claims parity it does not have when the ticket is not `ranked`

- Where: `enforcer.py:2959-2962` (`_SPEC["whole_shelf"] = bool(whole_shelf)`), `enforcer.py:3292` and `3351` (wide-stage rows render as whole shelf), `enforcer.py:2425-2450` (`_speculation_report` reports `whole_shelf` regardless of the ticket state), `speculator.ts:233-246` (`statusFor` drops "(preview)" whenever `wholeShelf`).
- Why: a speculative run that ends wide-only renders its menu as "Whole-shelf ranking" and the mod shows it with no "(preview)" marker, but the ticket settles `unranked`, so the hook ranks live and may produce a different menu. The same holds for `ENFORCER_TICKET=0` (README says "the mod's preview still shows"), and for any later `stale` or `env` miss. Design paragraph: "One ranking, one menu; the preview is that menu by construction."
- Failure scenario: the status line shows five skills; the model gets five different skills under the same "Whole-shelf ranking" header. The user cannot tell.
- Fix: report `whole_shelf` true only when `report["ticket"] == "ranked"` (or add an `exact` flag), so every other menu carries "(preview)".

### M3. The mod speculates against a concierge install the hook does not run, or that is disabled

- Where: `speculator.ts:129-151` (`installedEnforcers` reads only `installPath` and `version`), `speculator.ts:161-179`.
- Why: the highest-version `skill-concierge@*` entry is picked with no check of `enabledPlugins`, scope or which copy the session's hook actually runs.
- Failure scenarios: (a) the owner disables skill-concierge but leaves the mod on: every settled draft still spawns a speculative run that calls Jev and pins a menu that no hook will ever deliver. (b) A project-scope copy or a `--plugin-dir` checkout runs the hook while a different user-scope version speculates: the ticket comes from other code (the env and ctx fingerprints do not include the enforcer version).
- Fix: read the merged settings through `$.settings` and go inert when the chosen plugin key is disabled; add the enforcer's own version (or file hash) to `fingerprint_env`.

### M4. The epoch rules do not see this mechanism

- Where: AGENTS.md *Guardrails* (epoch path list, around lines 180-184) and CLAUDE.md:16 list `enforcer.py`, `skill-first.md`, `server.py`, `index_owner.py`. `hooks/scripts/offer_ticket.py` is not there. `docs/epoch-watch.md` has no entry for this release.
- Why: `offer_ticket.py` decides which offer rows carry a served draft-time verdict (TTL, fingerprints, wait rule). A change there changes what the ledger measures with no commit to any listed path. The mod's `userConfig` `intent` toggle and its `SETTLE_MS` change the ranked text and the served share with no commit at all.
- Failure scenario: a later TTL or fingerprint change in `offer_ticket.py` alone; an analysis windows `--since` the last `enforcer.py` commit and pools rows from both configurations, the exact mistake the repo's HARD rule exists to stop.
- Fix: add `hooks/scripts/offer_ticket.py` to the path list in AGENTS.md and CLAUDE.md; add an epoch-watch item (distribution of `spec.st`, `speculate` rows per sent turn, served vs live latency split on `jev.src`), and note that `spec.intent` and `rq` mark the intent-toggle epochs.

### M5. Docs that are now false or overclaimed

- "at most three runs per prompt": CHANGELOG.md:28, `docs/repository-layout.md` (adapters entry), README section. False today (H2).
- "`unranked` for a wide-only or failed route, so the hook keeps its own full-budget chance and the ADR-0087 wide safety net": `docs/runtime-flags.md:21`. False on the waited path (M1).
- "under the same context and settings" / "the ranking settings … are unchanged": AGENTS.md:102, `docs/runtime-flags.md:21`, CHANGELOG.md:13-17 ("Everything after the Jev step … runs as before"). The served rows skip the blocklist and catalogue filters that live in the Jev step (H1).
- "It shares no surface with other mods, so it runs beside the standalone prompt-enhancer": README.md:155, CHANGELOG.md:20. Stated as fact; the live coexistence drive is deferred to the owner (decisions.tsv 05:22). Only the kit test with an inline peer ran. Both mods do sit on the `prompt.submit` chain (composing correctly, by the code).
- "so the usual Jev wait … is already over when you press Enter": README.md:145. Only when the user waited for the settle plus the run (the builder's drive saw the preview 5 s after the pause); earlier, the hook waits (`spec.st: waited`).
- Fix: correct each line, or fix the code so the line becomes true.

## Low

- **L1. Killed speculative runs leave no `speculate` row.** `enforcer.py:2425-2458` writes the row at normal exit only; the mod kills runs on edit, turn start, timeout and after Enter (`speculator.ts:486-500`). The design graft says the row makes "wasted runs countable"; the most wasteful runs (killed mid-Jev, still billed) are the ones missing. Fix: a SIGTERM handler in speculate mode that writes the row with `ticket: killed`, or count spawns on the mod side.
- **L2. The `speculate` row's `ms` undercounts.** `_T_START` is set at `enforcer.py:1248`, after interpreter start-up and about 1,250 lines of module-level work (registry reads, keep-off, blocklist). The 3.9 scratch run logged `ms: 21`. Fix: take the start time at the top of the module, or name the field for what it measures.
- **L3. A status line can outlive a module reload (inference).** `speculator.ts:504` skips `status(undefined)` when `shownFor` is null, and a fresh Speculator starts with null. `$.ui.status` holds a line "until the next call replaces it" (d.ts:2473-2476); I found no documented clear on reload. After a config change or `/reload-plugins` with a line pinned, nothing clears it until a new line is shown. Fix: call `$.ui.status(undefined)` once in `session.start`.
- **L4. With `intent` on, a secret-shaped draft reaches haiku before any secret check.** `speculator.ts:447-473` calls `$.model.complete` on every rankable draft; the secret guard runs later, in Python (`enforcer.py:3225`). CHANGELOG.md:28 says secret drafts "are skipped". Off by default. Fix: mirror `_JEV_SECRET_RES` in the mod before the intent call, or reword the doc.
- **L5. `ENFORCER_TICKET=0` does not stop speculation or its Jev calls.** With the flag off the speculative run still routes through Jev (`enforcer.py:3238`) and, because `find_transcript` runs only when ticketing (`enforcer.py:3158`), it ranks without the conversation context, so its preview differs from the hook's menu by construction. The hook side does restore today's behaviour (verified by test B8 and by reading). Fix: say in README and runtime-flags that the mod's `enabled` option is the switch that stops the spend.
- **L6. The mod overrides an operator's ledger-off setting.** `speculator.ts:66` forces `ENFORCER_LEDGER=defer`; `enforcer.py:2447` writes the `speculate` row unless the value is `0`. A machine with `ENFORCER_LEDGER=0` gets rows anyway. Fix: pass the host's value through when it is `0`.
- **L7. `via: "enhancer"` marks turns the ticket did not change.** `enforcer.py:3214-3215` stamps `via` whenever a ticket was found, including `unranked`, `stale`, `env`, `dead` and `late` with no intent, where the turn ranked exactly as without the mod. Any via-vs-live comparison must split on `spec.st`. Fix: document it in runtime-flags, or set `via` only on a served verdict or when an intent changed the ranked text.
- **L8. Pasted drafts never match (inference).** The mod ranks `$.prompt.read().text`, "the draft as typed so far" (d.ts:8309); the hook gets the text "as it will reach the model (pastes already expanded)" (d.ts:9061). If the box holds a paste placeholder, the hashes differ: the speculative run is wasted and the status line describes the placeholder text. Not probed. Fix: skip speculation when the box holds a paste placeholder, or confirm the engine's behaviour.
- **L9. Labels.** The first kit test is titled "ranked once by the real enforcer path" but drives a fake child (`concierge-enhancer.test.tsx:158`). README.md:416 says "`0.68.0` — **published**" before any push (true only after release).

## Checked and holding

- No offer row from a speculative run: `_append_offer` returns at `enforcer.py:1332-1334` (`if _SPECULATING: … return`); the only other ledger write is the `speculate` row. `ledger.py` is not invoked. Every ledger consumer I read filters on known `ev` values (`analyze.py:177`, `build_keep_off.py:65`, `extract_turn_labels.py:124`, `calibrate_jev_gate.py:669`, `auto_promote.py`, `build_chains.py`, `smoke.py`), so `speculate` rows are ignored.
- Offer and turn rows still pair: `q` is the sent, stripped text on every path (`enforcer.py:3215`; test `test_the_served_offer_row_pairs_with_the_turn_row` runs the real `ledger.py` and `analyze._segment_windows`).
- `ENFORCER_TICKET=0` on the hook side: no `find`, `intent` is empty, `prompt == sent`, `_jev_start(..., None)` calls `_jev_route` exactly as before, stdout is the same unterminated JSON object.
- Sessions without the mod and the other seven harnesses: one `stat` of a missing file plus about 2 ms of import per turn; no output or row change. Their adapters never send `speculate`. A Claude ticket cannot serve another harness: the harness is in the env fingerprint.
- Deadline: `redeem` never sleeps past `until` (`offer_ticket.py:343-345`); the live fallback reuses the same deadline (test `test_a_ticket_that_never_settles…`: 0.45 to 0.55 s at a 0.5 s budget). The hook's Jev leg never runs longer than today's.
- Ticket file: `mkstemp` in the same directory then `os.replace` (`offer_ticket.py:152-168`), mode 0600 (seen live), no draft text stored (SHA-256 only), size and depth caps, sid regex blocks path traversal, every public function fail-silent; `settle` cannot overwrite another text's or another pid's ticket.
- Python 3.9: all hook scripts parse; `offer_ticket` imports and both run modes worked end to end on `/usr/bin/python3` 3.9.6.
- Mod surface: no `ui.render`, no key binding, no `prompt.fill`, no `$.env.set`, `e` passed to `next` unchanged (kit test), `.catch` on the one gate hook, single flight with kill on edit, Enter and turn start, 12 s kill timer, subagent `turn.complete` ignored.

## Recommended actions, in order

1. H1: re-filter served rows (blocklist, keep-off) and widen the fingerprint to the file-backed state and cwd; shorten the TTL.
2. H2: stop resetting `runs` in `working(true)`; add the notification-turn kit test.
3. M5: correct the five doc claims (or make them true through 1, 2 and 4).
4. M2: mark every non-`ranked` preview as "(preview)".
5. M1: keep the wide verdict in the ticket for the waited path, or record the owner's acceptance.
6. M3: go inert when skill-concierge is disabled; fingerprint the enforcer version.
7. M4: add `offer_ticket.py` to the epoch path list and an epoch-watch item.
8. Commit, then re-run the full suite (the 20 installer failures should clear), then the release order in AGENTS.md (`install-all.sh` with the smoke).

## Metrics

- Type coverage: TypeScript strict per the kit tsconfig, `tsc` clean; Python untyped beyond hints.
- Test coverage: not measured (no coverage tool run). 59 Python tests and 27 kit tests cover the new paths; none covers H1, H2 or M1 (my probes do).
- Lint: `pyflakes` via `test_no_undefined_names.py` clean; no other linter run.

## What I did not check

- No live Claude Code drive, no tmux, no jevd or Jev call, no haiku call. Live-only claims (env parity between `$.process.spawn` and the command hook, the hook's cwd versus the spawn cwd, transcript flush timing at `turn.complete`, paste placeholders in `$.prompt.read`, status lines across a reload, the desktop surface) are unverified by me.
- Coexistence with the real standalone prompt-enhancer (owner's own test, deferred).
- The A/B gate data in `~/_ARCHIVE/…/intent-gate-261012/` (not opened).
- Whether one process can host more than one session (the mod keeps one module-level Speculator).

## Unresolved questions

1. Design decision 2 (settled, unsent drafts reach Jev through jevd, and haiku when `intent` is on) is logged "decided, flagged for Thinh". Has Thinh accepted it? Release should wait for his answer.
2. M1: does the owner accept an embedding menu on slow-Jev turns where he pressed Enter mid-run, or should the wide verdict be kept?
3. Is a 15-minute TTL intended, given that the other three arena candidates chose 120 to 300 s?

Status (first review): DONE_WITH_CONCERNS

---

## Re-review (2026-10-12, after the builder's fixes)

Same scope and rules: read-only, scratch work in `~/.tmp/cr-review-261012/` (`mod2`, `mod3`, `py/test_probe_h1_rerun.py`, `py/test_probe_m1_rerun.py`, `home39b`). File state checked (SHA-1 prefixes): `enforcer.py` 2ae7ffbf3e65, `offer_ticket.py` e5bab33cd09f, `speculator.ts` 2040fd99c80f (this includes the late SKILL_CONCIERGE_ROOT-first change), `register.tsx` e0389e441eb8. The enforcer and ticket files did not change during the re-review.

### Verdict

**GO, with conditions.** Both High findings are closed, each proven by my original repro, re-run unchanged. All five Medium findings are closed or reduced to a documented residual. Conditions:

1. Commit first, then re-run the full suite. The 20 failures today are the same pre-commit refusal as before (19 in `test_codex_installer.py`, 1 in `test_installer_staging_cleanup.py`; the log contains the message ".claude-plugin/plugin.json says v0.68.0 but HEAD carries v0.67.0" 19 times). They must be 0 after the commit.
2. Then follow the repo's release order: `adapters/install-all.sh` with the smoke, and push only if green.
3. Design decision 2 (unsent drafts reach Jev) is still logged "flagged for Thinh". I read no answer from him. Releasing ships that behaviour, so the go assumes the lead holds his acceptance or his GO/AFK order covers it.

### Checks re-run

| Command | Result |
|---|---|
| `python3 -m pytest tests/test_offer_ticket.py -q` | 66 passed |
| `claude plugin test adapters/claude-code/mod` (after the SKILL_CONCIERGE_ROOT change) | 34 pass, 0 fail |
| `claude plugin validate adapters/claude-code/mod` | passed; calls now include `$.settings.read`; env writes: nothing |
| `tsc --noEmit -p .` on a scratch copy of the latest mod | rc 0 |
| `python3 scripts/driftcheck.py driftcheck.json` | IN SYNC |
| `/usr/bin/python3` 3.9 parse of `hooks/scripts/*.py` | all parse |
| Python 3.9 end to end, scratch HOME, Jev off | speculative run rc 0 with `skillConciergeSpeculation` (`whole_shelf: false` on an unranked ticket); hook rc 0; one `speculate` row; offer row as before |
| Full suite | 1602 passed, 20 failed: all are the pre-commit Codex installer refusal (see condition 1) |
| Live catalogue scroll that the new H1 check adds to a served turn (`_jev_catalog()`, 3.9, local Qdrant) | 558 rows in 12.7 to 18.3 ms, three runs |

### Closure table

| ID | Claimed fix | Verified how | Status |
|---|---|---|---|
| H1 | `_ticket_verdict_allowed` (`enforcer.py:2349-2365`) re-checks served rows and pull-ins against blocklist, keep-off and the live Jev catalogue; an unreadable catalogue means rank live; TTL 300 s | My original repro re-run (a blocklist **file** change after the ticket settled, env unchanged): served bullets `['update-config']`, `spec.st: stale`, no `jev.src`, Jev called live once. Plus 4 builder tests (blocklist, keep-off, catalogue drop, pull-in, catalogue down). Project isolation and plugin gate are covered because `_jev_catalog` runs `_row_invocable` in the hook's own process. Cost: one local catalogue scroll, about 15 ms, inside the worker thread. | **Closed** |
| H2 | `working()` no longer resets `runs`; only send and `end()` reset it (`speculator.ts:340-399`) | My original kit probe re-run unchanged on the latest mod: 6 notification turns, **3** spawns (was 7) | **Closed** |
| M1 | `TICKET_LIVE_RESERVE_S = 3.5` (`enforcer.py:2347`): the wait ends 3.5 s before the hook's Jev deadline | My original probe re-run with the reserve as the time left: the real `_jev_route` now calls the TypeSafe tier (1.5 s) and skips only Command Code (5.5 s, `NoTime`). Before, it skipped both. Builder test pins the 3.5 s left over. | **Closed with a residual (Low):** the run's own wide menu is still discarded, and on a ladder without a tier whose timeout is ≤ 3.5 s the reserve buys nothing. The grounding shows a TypeSafe tier in this machine's jevd ladder. Documented in `docs/runtime-flags.md`. |
| M2 | `whole_shelf` is true only when the ticket is `ranked` (`enforcer.py:2470-2472`); otherwise the line says "(preview)" | Builder test covers ranked, wide-only and `ENFORCER_TICKET=0`. My 3.9 run printed `whole_shelf: false` on an unranked ticket. `statusFor` appends "(preview)" when it is false. | **Closed** |
| M3 | `locateEnforcer` merges `enabledPlugins` across `user`, `project`, `local`, `flag`, `policy` (the d.ts `SettingsSource` order, lowest to highest) and goes inert when every `skill-concierge@*` id is false; project/local entries apply only inside their `projectPath`. Late change: `SKILL_CONCIERGE_ROOT` is checked first. | Read `speculator.ts:207-226` and `register.tsx:36-43`; kit test at `concierge-enhancer.test.tsx:661`; validate lists `$.settings.read`. | **Closed with residuals (Low):** (a) the check runs once, at `session.start`, so disabling skill-concierge mid-session does not stop the mod until the next session or reload, and the README says without qualification that "It does nothing when skill-concierge is disabled in your settings"; (b) a `SKILL_CONCIERGE_ROOT` set in a shell profile overrides a disabled install even without `--plugin-dir`. It is set nowhere on this machine today (`harness-env.sh`, `.zshenv`, `.zshrc`, `settings.json` checked), and it is documented only in code comments; (c) the enforcer version is still not in the env fingerprint. |
| M4 | `offer_ticket.py` added to the epoch path lists; `docs/epoch-watch.md` v0.68.0 section (W49 to W51) | `AGENTS.md:182`; `CLAUDE.md:16` now reads "last commit to enforcer.py / offer_ticket.py / skill-first.md / server.py / index_owner.py"; the epoch-watch section names the no-commit knobs (intent toggle, settle time, TTL, reserve) and marks its thresholds as proposals, not owner decisions | **Closed** |
| M5 | Doc claims corrected | README.md:145, :147, :155; CHANGELOG 0.68.0 (lines 13-36); `docs/runtime-flags.md:21`; `docs/repository-layout.md` all read true now: the run cap counted until send, the waited-path limit with the 3.5 s reserve, the re-check at Enter, `(preview)` unless ranked, coexistence "by design … the live side-by-side test is pending", and `ENFORCER_TICKET=0` still spending until `enabled` is off | **Closed** (one qualifier missing: M3 residual a) |
| L1 | left open | killed runs still write no `speculate` row; W50 says it undercounts | Open, non-blocking |
| L2 | `_T_START` moved to `enforcer.py:53` | It now counts the module-level work. Interpreter start-up is still outside it (the 3.9 run logged `ms: 53`, was 21). | Mostly closed |
| L3 | left open | a status line from before a module reload can stay pinned (inference, not probed) | Open, non-blocking |
| L4 | left open | with `intent` on (off by default), a secret-shaped draft reaches haiku before any check. CHANGELOG now says "skipped by the enforcer", which is accurate. | Open, non-blocking |
| L5 | docs | README.md:147 and runtime-flags say the mod keeps ranking and calling Jev under `=0`, and that `enabled` is the switch that stops it | Closed |
| L6 | left open | the mod's `ENFORCER_LEDGER=defer` still overrides an operator's `0` for `speculate` rows | Open, non-blocking |
| L7 | docs | runtime-flags and epoch-watch item 3: `via` is set whenever a ticket was found; split on `spec.st` | Closed |
| L8 | left open | pasted-placeholder drafts (inference, not probed) | Open, non-blocking |
| L9 | test title fixed (`concierge-enhancer.test.tsx:163`) | README "`0.68.0` — **published**" is true only after the push (transient) | Closed (title); transient part resolves at release |

I did not find the builder's written reasons for leaving L1, L3, L4, L6 and L8 open, so I judged each on its merits. None changes the menu the model receives or breaks a gate. Each is telemetry or cosmetic, or depends on the off-by-default intent option.

### Not checked in this re-review

- I did not run a live Claude Code drive. The coordinator reports the builder's re-drive: preview 4 s after the pause, `spec.st: ready`, `jev.src: ticket`, offer row 0.09 s after the turn row, rows equal to the preview. decisions.tsv (06:35:29) records the same. I did not see that ledger myself.
- No Jev, jevd or haiku call.
- Coexistence with the real standalone prompt-enhancer: still pending; the owner reserved that test.

### Still open (none blocking)

- M1 residual: a Command-Code-only ladder gets no live tier after a long wait, and the run's wide menu is discarded.
- M3 residuals: the enabled check runs only at session start; a stray `SKILL_CONCIERGE_ROOT` overrides a disabled install; README.md:145 needs "at session start".
- L1, L3, L4, L6, L8 as above; L2 partly.
- Unresolved question 1 of the first review (Thinh's answer on decision 2) still applies.

Status: DONE_WITH_CONCERNS
