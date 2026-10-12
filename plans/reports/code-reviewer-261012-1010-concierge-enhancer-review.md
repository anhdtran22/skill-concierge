# Code review: concierge-enhancer mod and the enforcer route hint

Date: 2026-10-12 (Asia/Saigon). Reviewer: independent code-reviewer subagent. Read-only on source.
Snapshot: uncommitted working tree on top of `bc57b45`. While this review ran, the author added the 0.67.0 version bump and doc edits (CHANGELOG, README, AGENTS.md, docs/repository-layout.md, openwiki/quickstart.md); those were read too. The reviewed `register.tsx` hash is md5 `4ecfcf9b9dd8d85fa0cb8b0bbb86f12f`.

## Scope

- `hooks/scripts/enforcer.py` (+43 lines: `_route_hint`, `ROUTE_HINTS`, `ROUTE_HINT_TTL`, `_SID_RE`, `_VIA`, the call in `main()`)
- `adapters/claude-code/mod/` (new: `hooks/register.tsx` 246 lines, `types/index.d.ts`, `hooks/hooks.json`, `.claude-plugin/plugin.json`, tests 275 lines)
- `.claude-plugin/marketplace.json` (second plugin entry), `tests/test_enforcer_route_hint.py` (new)
- Consumers of the changed data, checked for impact: `hooks/scripts/ledger.py`, `scripts/analyze.py`, `scripts/build_keep_off.py`, `scripts/extract_turn_labels.py`, `adapters/omp/install.sh`, `scripts/doctor.py`
- `hooks/hooks.json`: confirmed untouched (not in `git status`).

## Checks run (tails)

`python3 -m pytest tests/test_enforcer_route_hint.py tests/test_python39_hooks.py -q`
```
..................                                                       [100%]
18 passed in 1.14s
```
(None skipped, so the Python 3.9 load check ran.)

`claude plugin test adapters/claude-code/mod` (Claude Code 2.1.296)
```
(pass) During a running turn the band stays and Send reads as queue [10.37ms]

 13 pass
 0 fail
Ran 13 tests across 1 file. [0.31s]
```

`claude plugin validate adapters/claude-code/mod`
```
  ❯ ./register.tsx gating hook without .catch: prompt.submit
  ...
✔ Validation passed
```
(`claude plugin validate .` on the repo root also passes, with one pre-existing warning about CLAUDE.md at the plugin root.)

`python3 scripts/driftcheck.py driftcheck.json` (re-run after the author's version bump)
```
  [ok]    command check passed: flag-docs-parity
================================================
IN SYNC: every fact matches its source of truth.
driftcheck exit=0
```

## High

### H1. Enhanced turns drop out of every offer-to-turn metric (the ledger join breaks)

- Where: `hooks/scripts/enforcer.py:3111-3113` (the prompt variable is replaced by the route text), then every `_append_offer(..., prompt)` writes `q` = route text via `enforcer.py:1371`. `hooks/scripts/ledger.py:143` writes the turn row with `q` = the prompt as sent. The comment above that line says the two must match: "Log the STRIPPED prompt so analyze.py can join this `turn` to the enforcer's `offer` event by (sid, q)".
- Consumers that join on `(sid, q)`: `scripts/analyze.py:183` and `:196` (`_segment_windows`), `scripts/build_keep_off.py:71` and `:85`, `scripts/extract_turn_labels.py:127`.
- Proven on the author's own live run: in `plans/261012-0935-prompt-enhancer-ab/live/logs/skill-invocation-ledger.log` both enhanced turns have an offer row whose `q` starts "write a docker compose file for postgres w/ a healthcheck…" and "add a --since flag to analyze.py…", while the turn rows start "Write a docker compose file for postgres with a healthcheck, in \"chisl…" and "Add a `--since` flag to `analyze.py`…". Running `analyze._segment_windows` on that ledger gives:
  ```
  turn 'Write a docker compose file for postgres' offered= None band= None
  turn 'Add a `--since` flag to `analyze.py` in ' offered= None band= None
  ```
- Failure: every enhanced turn is counted as "no menu shown"; its offer row is silently dropped; offer conversion, the keep-off map and turn labels all lose these turns. The CHANGELOG's advice to "window them apart" cannot be followed, because the join drops the `via` row before any windowing. `tests/test_enforcer_route_hint.py:39` (`assert row["q"] == ROUTE[:120]`) locks the broken behaviour in.
- Fix: keep `q` as the prompt as sent and record the ranked text in a new key. For example, keep `sent = prompt` before line 3111, have `_route_hint` set `_VIA.update(via="enhancer", rq=route[:120])`, and in `_offer_ev` write `q` from the sent prompt (pass `sent` to every `_append_offer` call, or store it in a module value next to `_VIA`). Change the test to assert `row["q"] == PROMPT[:120]` and `row["rq"] == ROUTE[:120]`.

### H2. The band's Send can lose the user's prompt, and sends a weaker prompt than Enter

- Where: `adapters/claude-code/mod/hooks/register.tsx:167-178`.
- Order today: `$.prompt.fill({ text: '' })` clears the box, then `leaveRouteHint` (awaits `$.fs.write`, `$.session.id`, `$.clock.now`), then `$.prompt.submit`, whose result is ignored.
- Failure 1: if `leaveRouteHint` throws (an `fs.write` denied by another plugin's guard, an unwritable home), the box is already empty and nothing is submitted. The rewrite and the original draft are both gone.
- Failure 2: `$.prompt.submit` resolves `{ drop: reason }` when a hook refuses it (the d.ts `PromptSubmitResult`: "The prompt did not enter: a hook's refusal ... or a settings hook's block beneath"). Send ignores it, so the box stays empty and the prompt is lost; the hint also stays on disk.
- Failure 3 (behaviour gap, not loss): the d.ts says of `asUser`: "`@file` mentions and pasted images are not expanded for a plugin's prompt, `asUser` or not." A draft with `@path` mentions or a pasted image goes out without them on Send, but with them on Enter. The transcript also names the plugin as the sender.
- Fix: submit first, clear only on success, and restore on drop or throw:
  ```ts
  const res = await $.prompt.submit({ text, asUser: true }).catch(() => null)
  if (!res || res.drop) { $.ui.toast(res?.drop ?? 'Send failed; your prompt is still in the box'); return }
  ```
  with the hint write moved out of `send()` (see M3) and wrapped so it can never throw into the send path. Simpler still: drop the Send button and tell the user to press Enter, which keeps `@file` and image handling. That also removes the plugin-origin path that M3 is about.

## Medium

### M1. A prompt edited after Enhance is still routed on the old draft

- Where: `register.tsx:15` (`SAME_PROMPT = 0.6`), `register.tsx:162` (Jaccard word overlap), `register.tsx:163` (the hint names the edited text but carries the old route).
- Failure: the user enhances, then adds "Also deploy it to Vercel and add a GitHub Actions workflow", or swaps PostgreSQL for MySQL. I measured the same word-set overlap on a 40-word rewrite: 0.795 for the appended line and 0.906 for the database swap, both above 0.6. The hint is written, and the enforcer ranks the pre-edit draft plus intent, so deployment and CI skills are never considered. The constraint "never route a prompt other than the exact one it names" holds in letter (the hint names the edited text) but not in effect.
- Fix: write a hint only when the sent text equals the rewrite (after trimming). On any edit, write no hint, so the enforcer ranks the prompt as sent (the pre-change default). This deletes `words`, `overlap` and `SAME_PROMPT`, which is less code.

### M2. The band can show a menu the model does not get; the docs say it cannot

- Claims: CHANGELOG 0.67.0 "So the model gets the menu the band showed"; README "the mod leaves a one-shot route hint, so the model gets the same menu the band showed"; marketplace description "shows the five skills skill-concierge will offer".
- Causes, each checked in source:
  1. The Jev rerank is an LLM call. The preview and the real hook make two separate calls, and the A/B report itself says "The Jev router is not deterministic" (the raw arm scored 24 then 15 points on re-ranking).
  2. The preview sends no `transcript_path` (`register.tsx:76`), so `_jev_context` (`enforcer.py:1674`) gives Jev no recent context and no loaded skills. The real hook does: the live ledger's second enhanced offer row has `"ctx": true`.
  3. The early lanes run on different text. In the real hook the short, harness, refusal, consult and self-reference checks (`enforcer.py:3063-3103`) judge the sent rewrite, before the hint is read. The preview runs them on draft plus intent.
  4. `rankMenu` takes the first five `• ` lines (`register.tsx:86-92`). `_ranked_mandate` emits primary rows, then pulled rows, then the external annex, then the cross-harness annex, all as `  • ` lines. When the embedding path shows fewer than five primary rows, annex skills (search-only, or not invocable in this harness) appear under "Skills offered".
  5. Any hint failure (M3, M4, a hook below that rewrites the text) makes the real hook rank the full rewrite, the worst arm in the A/B, while the band showed the best arm.
- Fix: the smallest honest fix is to call the band a preview in the docs and UI ("Concierge preview: …"), parse only the primary block (stop at the first blank line, or at the `pulled`/annex headers), and pass `transcript_path` if the API exposes one (I found no transcript-path getter on `$.session` in the d.ts; `id()` is "the transcript file's name"). A full fix, where the enforcer serves the previewed menu verbatim from the hint, would guarantee equality but adds a second offer path. I judge that over-engineering unless the owner wants the guarantee.

### M3. Send while a turn runs ("s queue"): the hint can expire or be eaten before its prompt runs

- Where: `register.tsx:174-177`; `enforcer.py:1233` (`ROUTE_HINT_TTL = 300`, with the comment "the mod writes the hint inside the same submit, so this only guards clocks").
- Facts from the d.ts: a plugin's `$.prompt.submit` "runs once it is idle" (`PromptSubmitInput.turnId` doc), and its `prompt.submit` event is what runs the UserPromptSubmit settings hooks (`'prompt.submit'` doc: "`next(e)` runs the hooks beneath and the UserPromptSubmit settings hooks"). A composer prompt typed mid-turn "fires at Enter".
- Failure A: the user queues the enhanced prompt with `s` during a turn that runs longer than 5 minutes (common in agentic work). The hint is written at the press, and the enforcer reads it after the turn ends, more than 300 s later, so it is dropped as stale.
- Failure B: after queueing with `s`, the user types a quick follow-up and presses Enter. That prompt's UserPromptSubmit runs at once, reads the hint, finds a different prompt, and deletes it. The queued enhanced prompt then ranks the full rewrite.
- Failure C: there is one hint file per session (`<session_id>.json`), so two queued enhanced sends overwrite each other.
- The comment at `register.tsx:174`, "A plugin's own submit does not raise its own prompt.submit hook", contradicts the d.ts `prompt.submit` doc: "It goes through every hook but the calling one (the plugin's others see it)". The call is made from the `ui.render` hook's `$`, so this plugin's `prompt.submit` hook should see it, with `origin` `{ kind: 'plugin', name: 'concierge-enhancer', asUser: true }`. UNVERIFIED live.
- Fix: write the hint in the `prompt.submit` hook, for `origin.kind === 'composer'` and for `origin.kind === 'plugin' && origin.name === 'concierge-enhancer'`, and remove it from `send()`. The hint is then written just before the UserPromptSubmit hooks run, whenever that is, and the TTL comment becomes true. Correct the comment at `enforcer.py:1233` either way.

### M4. Exact comparison fails on surrounding whitespace

- Where: `enforcer.py:1259` compares the hint's raw `prompt` with the enforcer's stripped `prompt` (`main()` strips it).
- Proven with a probe (temporary HOME, real `enforcer.py`): with a hint prompt and a sent prompt that both end in `"\n"`, the offer row has no `via` and ranks the sent prompt. Whether Claude Code ever hands `prompt.submit` a text with leading or trailing whitespace is UNVERIFIED. If it does, the feature silently never fires.
- Fix: compare `str(data.get("prompt") or "").strip() != prompt` in the enforcer, and trim in `leaveRouteHint`.

## Low

- L1. A hint is not consumed when an early lane returns first (`enforcer.py:3063-3103`: short, slash, harness, refusal, consult, self-reference). It lingers on disk as plaintext draft plus rewrite until the next prompt in that session, and forever if the session ends. The same happens when Claude Code dies between the write and the hook. There is no sweep. Fix: read and unlink the hint once at the top of `main()`, right after the empty-prompt check, and apply it only where it is applied now.
- L2. A crafted hint with `"t": NaN` passes the freshness check, because `abs(nan) > 300` is False. Proven with the probe: `via` = `enhancer`. A deeply nested JSON body raises `RecursionError`, which neither `_route_hint` nor `main()` catches. Both need write access to `~/.claude`, so they are robustness gaps, not a trust-boundary hole. Fix: `if not (isinstance(t, (int, float)) and abs(time.time() - t) <= ROUTE_HINT_TTL)`, and add `RecursionError` to the read's except tuple.
- L3. Stale menu after a quick send: `enhance()` sets `pending` (`register.tsx:143`) before the up-to-20 s `rankMenu`, then writes `menu` unconditionally (`:146`). If the user sends inside that window, `leaveRouteHint` clears the menu (`:161`), and then the late ranking redraws "Skills offered" for a prompt already sent. Fix: write the menu only if `pending` is still the same object.
- L4. `enforcerPath` takes `entries[0].installPath` (`register.tsx:60`). `installed_plugins.json` keeps a list per plugin (user, project and local scopes), and the first entry need not be the copy this session's hook runs. The preview can then run a different enforcer version. Fix: prefer the entry whose scope matches the session, or document that `SKILL_CONCIERGE_ROOT` overrides it.
- L5. The new comment block at `enforcer.py:3107-3110` sits between the ADR-0054 comment ("deterministic routes run BEFORE the embed step…", line 3104) and the `_route_hits` call it describes. Move the hint block above that comment.
- L6. Test gaps. No test covers the Enter (composer) path, which is the main path; no test covers an edit after Enhance, a dropped or failed submit on Send, or the early-lane leftover. The Python test asserts the H1 defect.
- L7. Informational: every Enhance makes a second Jev call through the preview (the live rows show `"prov": "commandcode"`), so enhanced turns use two Jev calls. This is stated as a fact about which billing channel is used, not as a cost objection.
- L8. README now says "Current release: `0.67.0` — **published**" before anything is committed or pushed. This follows the existing template, but it is false until the push.

## Constraint checklist

| Constraint | Verdict | Evidence |
|---|---|---|
| Fail-silent, additive | Holds for the enforcer, apart from the crafted-file `RecursionError` (L2). The mod's `prompt.submit` hook fails open (the d.ts says "a broken plugin never blocks one"; validate lists it as "gating hook without .catch"). It does **not** hold for Send (H2). | `enforcer.py:1245-1256`; register.tsx:167-178 |
| The hint routes only the exact prompt it names | Holds literally. In effect it is defeated by M1 (an edited prompt routed on the old draft). | `enforcer.py:1259`; register.tsx:162-163 |
| No path traversal through session_id | Holds. `_SID_RE` `^[A-Za-z0-9_-]{1,128}$` rejects `.` and `/`, and `test_a_session_id_that_is_not_a_plain_name_reads_no_file` covers it. The mod's path comes from `$.session.id()` ("the transcript file's name"). | `enforcer.py:1234`, `:1245` |
| `enforcer.py` stays 3.9-compatible | Holds. `test_python39_hooks.py` ran rather than skipped. | pytest output |
| `hooks/hooks.json` untouched | Holds. | `git status` |
| Marketplace second entry with no version | OK. driftcheck passes, and `doctor.py:1584` and `adapters/omp/install.sh:346` read `plugins[0]`, which is still the main plugin. That makes the entry order load-bearing; it is not documented. | marketplace.json; driftcheck |

## What was done well (only what affects the risk)

- The enforcer side is small, one-shot, and checks prompt equality before using the hint, so a hint can never route a different prompt. `_VIA` follows the existing `_DEFERRED` per-process pattern.
- The ledger is turned off for the preview (`ENFORCER_LEDGER=0`), and I confirmed that `enforcer.py` writes no other per-session state (the only writes are the ledger, the hint unlink and the owner-autostart stamp). The shared `PREVIEW_SESSION` id therefore cannot pollute anything.
- `enhance()` refuses to overwrite a draft the user changed during the rewrite (`register.tsx:135`).

## Verdict

Not ready to commit as is. H1 corrupts the project's core telemetry for every enhanced turn, and the live ledger already shows it. H2 can lose a user's prompt. Both fixes are small. M1 and M3 decide whether the feature routes the prompt the user actually sent; M2 and M4 are honesty and robustness fixes. After H1 and H2 (and preferably M1, M3 and M4), the change is sound.

## Unverified

- Whether the UserPromptSubmit `prompt` for a plugin `asUser` submit is byte-identical to `e.text`. The author's live ledger shows two composer-path matches; I found no evidence for the Send path.
- Whether this plugin's own `prompt.submit` hook sees its Send submit. The d.ts says yes; the code comment says no.
- Whether Claude Code ever passes `prompt.submit` a text with leading or trailing whitespace (M4).
- Whether OMP, which reads this marketplace, lists or tries to install the Claude Code-only mod.

## Unresolved questions

1. M2: does the owner want a guaranteed-equal menu (the enforcer serves the previewed menu from the hint), or an honest "preview" label? My pick is the label, because it adds no code path.
2. H2: fix Send, or remove it and rely on Enter? My pick is to remove it, because Enter keeps `@file` and image handling and makes M3 go away.

---

## Re-review (2026-10-12, after the author's fixes)

Decisions applied: for M2 the band is labelled "Skill preview" and parses only the main list; for H2 the Send button is removed, so Enter is the only way to send.

### Checks re-run (tails)

`python3 -m pytest tests/test_enforcer_route_hint.py tests/test_python39_hooks.py -q`
```
.....................                                                    [100%]
21 passed in 2.63s
```
`claude plugin test adapters/claude-code/mod`
```
 12 pass
 0 fail
Ran 12 tests across 1 file. [0.26s]
```
`claude plugin validate adapters/claude-code/mod`
```
  ❯ ./register.tsx gating hook without .catch: prompt.submit
  ❯ ./register.tsx calls: ... $.prompt.fill (via enhance), $.prompt.read (via enhance), ...   (no $.prompt.submit any more)
✔ Validation passed
```
`python3 scripts/driftcheck.py driftcheck.json`
```
IN SYNC: every fact matches its source of truth.
driftcheck exit=0
```

Extra proof for H1. I ran the real `enforcer.py` and then `ledger.py` on one hinted prompt (temporary HOME), and passed the resulting ledger through `analyze._segment_windows`:
```
offer enhancer 'Write a docker compose file for postgres' 'write a compose file\n\nAuthor a'
turn None 'Write a docker compose file for postgres' ''
window turn offered= [] band= fallback
```
The offer now pairs with its turn: `band` is set, where before it was `None`. `offered` is empty only because the index owner was off in the probe.

### Verdict per finding

| Finding | Verdict | Evidence |
|---|---|---|
| H1 ledger join | **Closed** | `enforcer.py:3111` sets `_VIA` with `q=prompt[:120]` (the stripped prompt as sent, matching `ledger.py:143` `s[:120]`) and `rq=` the route; `enforcer.py:1373` `ev.update(_VIA)` overrides `q`. Test `tests/test_enforcer_route_hint.py` asserts `q == PROMPT[:120]` and `rq == ROUTE[:120]`. The join probe above passes. |
| H2 Send loses prompt | **Closed** (Send removed) | `register.tsx` has no `send()`; the band has only Enhance (`register.tsx:215`), and the key hint is `[chord, 'e enhance', 'esc back']` (`:204`). Validate lists no `$.prompt.submit` call. |
| M1 edited prompt, stale route | **Closed** | `register.tsx:147-150` `routeHintFor` requires `text.trim() === waiting.rewrite.trim()`; the overlap code is gone. Test `concierge-enhancer.test.ts:229-231` checks that an appended "Then deploy it to Vercel." gets no hint. |
| M2 band vs model menu | **Code closed; docs partly open** | The parse stops after the first run of `• ` rows (`register.tsx:73-82`). I checked `_ranked_mandate`: the primary rows are contiguous, and every later block (note, pulled, ROUTE, external annex, cross-harness annex) starts with a non-bullet line, so the break is correct. The label is "Skill preview" (`:223`), with a test at `:129`. README and CHANGELOG no longer claim the same menu. **Still open:** the install-facing descriptions still overclaim, word for word "shows the five skills skill-concierge will offer for it", in `.claude-plugin/marketplace.json` (the `concierge-enhancer` entry) and `adapters/claude-code/mod/.claude-plugin/plugin.json:4`. |
| M3 queued Send race | **Closed** | Send is gone; the hint is written only in `prompt.submit` for `origin.kind === 'composer'` (`register.tsx:191-193`), before `next(e)`. The d.ts says `next(e)` "runs the hooks beneath and the UserPromptSubmit settings hooks", and a prompt typed mid-turn "fires at Enter", so the TTL comment at `enforcer.py:1233` is now accurate. |
| M4 whitespace | **Closed** | `enforcer.py:1259` `sent.strip() != prompt`; test `test_surrounding_whitespace_on_the_hinted_prompt_still_matches`. |
| L1 leftover hint after early lane | **Closed** | `enforcer.py:3061` reads and unlinks right after `sid`, before every lane; test `test_a_hint_is_consumed_even_when_an_early_lane_ends_the_turn`. |
| L2 NaN / RecursionError | **Closed** | `enforcer.py:1250` (`RecursionError` caught), `:1260` (`math.isfinite(t)`, with `math` already imported at `:40`); test `test_a_hint_with_a_non_finite_time_is_dropped_unused`. |
| L3 stale menu after send | **Closed** | `register.tsx:137` writes the ranking only if the same rewrite is still pending. |
| L4 `enforcerPath` first entry | **Open, not a release blocker** | `register.tsx:47` still takes `entries[0]`. Worst case, the preview runs another installed copy's enforcer. The real offer is unaffected, and `SKILL_CONCIERGE_ROOT` overrides it. Fix when convenient. |
| L5 comment placement | **Closed** | The hint comment and the apply block (`enforcer.py:3106-3112`) now sit above the ADR-0054 comment (`:3114`). |
| L6 test gaps | **Partly open (Low)** | The Python side is well covered now (21 tests). On the mod side, `routeHintFor` is tested as a pure function, but no test drives the `prompt.submit` composer hook through `leaveRouteHint` to `fs.write`, which is the only live path. A regression in the hook's wiring (origin filter, path, session id) would pass CI. |
| L7 second Jev call per Enhance | Informational, unchanged | — |
| L8 README "published" before push | **Open (Low)** | `README.md:420` "Current release: `0.67.0` — **published**". It becomes true once pushed. |
| Marketplace first-entry dependency | **Documented** | `docs/repository-layout.md` (the `mod/` entry): "`skill-concierge` must stay the first entry in `.claude-plugin/marketplace.json`, because `doctor.py` and the OMP installer read the first entry". The order today is `['skill-concierge', 'concierge-enhancer']`. |

### New issues the fixes introduced

- N1 (Low). The comment at `enforcer.py:1373` is now wrong. It still reads `"via": "enhancer" when q is the enhancer's route text, not the prompt as sent`, but after H1 the `q` is always the prompt as sent and the route text is in `rq`. Suggested wording: `# a hinted run: via, q (as sent) and rq (the route text ranked)`.
- No functional regressions found. Two side effects of moving the hint read to the top of `main()`, checked and acceptable:
  - Harness-message and slash-command turns now do one file read and unlink attempt before their no-I/O lanes. That is not embed or Qdrant I/O, which is what ADR-0054 excludes.
  - The hint is consumed on a turn whose prompt does not match. That is the intended one-shot behaviour.

### Release verdict

Go for release, on one condition: correct the two install-facing descriptions (M2 docs: the `concierge-enhancer` entry in `marketplace.json` and the mod's `plugin.json:4`), because they are what a user reads at install time and they still promise "the five skills skill-concierge will offer". N1, L4, L6 and L8 are Low and can follow.

Unverified, unchanged from the first pass: live Claude Code behaviour of the `prompt.submit` composer path, and whether the UserPromptSubmit `prompt` is byte-identical to `e.text`. The author's earlier live ledger showed two composer-path matches, which supports it.
