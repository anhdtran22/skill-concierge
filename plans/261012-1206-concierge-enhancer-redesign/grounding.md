# Grounding: concierge-enhancer redesign (2026-10-12)

Inputs for the design arena. Sources: two read-only explorers (concierge offer path; Claude Code 2.1.296 mod API) and a live probe plugin run in this build. Line numbers: `enforcer.py` = `hooks/scripts/enforcer.py`; `d.ts` = `~/.tmp/claude-501/bundled-skills/2.1.296/fbcef4cae6acb4b2799e4c236f7676c1/plugin-authoring/types/claude-code.d.ts`; `R:` = the same folder's `reference.md`.

## 1. The owner's goal and standing decisions

- **Goal (Thinh's words):** the enhancer exists to "enhance & optimize the menu of 5 [concierge] offers initially". It must be "integrated with how the concierge works", "seamless, sophisticated", "works as expected", and "won't collide with other mods". Thinh: "you'd need to consider the integration with jev via jevd as well - which is a critical advantage you've ignored".
- **Thinh's verdict on v0.67.0:** it "replicat[ed] the exact mechanism from my prompt-enhancer without any adaptation to how the concierge works".
- **Decisions in force (answered questions):**
  - The rewrite names no skills; it keeps the author's own terms verbatim; it has no ask-the-author section.
  - The old standalone `prompt-enhancer@prompt-enhancer` (v0.1.3, `~/in-PROD/MY-WORKBENCH/mods-dev/prompt-enhancer/hooks/register.tsx`) is disabled but installed. Thinh may re-enable it; both must be able to coexist.
- **Measured evidence (A/B, `plans/261012-0935-prompt-enhancer-ab/report.md`, n=20 real prompts, blind judge, no transcript context):** ranking raw draft + a one-line intent beats raw draft alone 13-7; the intent line alone ties raw+intent; the full rewrite ranks worst (last in 11 of 20). Modest effect, not proof. The intent line came from a sonnet/fork rewrite prompt; no other generator was tested.

## 2. How concierge's per-turn offer reaches the model today

- `hooks/hooks.json` runs `enforcer.py` (10 s timeout) then `ledger.py` (5 s) on every Claude Code UserPromptSubmit. **This file is pinned**: changing any hook in it fails `tests/test_hook_definitions_pinned.py` and makes every Codex user re-trust the hooks (caveats §27). The mod lives in a separate plugin, `adapters/claude-code/mod/` (`concierge-enhancer`, second entry of `.claude-plugin/marketplace.json`).
- **Stdin read:** `prompt`, `session_id`, `agent_id`, `transcript_path` (enforcer.py:3058-3123). It does not read `cwd` or `source`.
- **Lane order in `main()` (3052-3249):** route-hint consume (3061) → empty or `/` silent (3065) → ≤3 words silent (3067) → harness-message lane (3075, regex `_HARNESS_MSG_RE` 1458) → refusal (3082) → consult route (3092) → self-reference (3101) → hint applied: `prompt = route` (3110-3112) → deterministic routes (3117) → Jev start (3123, thread, deadline 7.8 s) → embed (0.5 s timeout) → Qdrant retrieve → filters → Jev join (3171): `jev_skip` if best fit < 0.30, else Jev rows replace the menu → embedding-only gates (getaway < 0.45, actionability) → annexes → render `_ranked_mandate` (2868-2937) + `_chain_hint` → print `additionalContext`, write offer row.
- **Jev router (`_jev_route` 2227-2342):** English only (`_is_english`, 1654). Ladder from jevd `/ladder` when `JEVD_URL` is loopback, else `ENFORCER_JEV_BENCH`. Catalogue = Qdrant scroll of ~616 installed skills (`_jev_catalog` 1932). State = `{request: prompt[:4000], recent_context (last assistant text ≤1500 ch), skills_already_loaded_this_session}` from `transcript_path` (`_jev_context` 1674). Per tier: a wide Choice pass over 250-skill chunks, then a rerank (Choice + one `fits` question per shortlisted skill); `_jev_decide` (2023). On a timeout the wide menu (`stage: wide`) is served; with neither, the embedding "Preview" menu.
- **Menu text:** line 1 `SKILL-FIRST · reply line 1 = USING | SEARCH | NO SKILL`; header `Whole-shelf ranking…` (Jev) or `Preview for this task…` (embedding); rows `• name<badge> (NN%) — blurb`; owner pull-ins; ROUTE line; external and other-harness annexes; badge legend; tail. The header type changes what the doctrine (`hooks/doctrine/skill-first.md`, rule 1) obliges the model to do.
- **Structured output already exists:** `ENFORCER_LEDGER=defer` makes the enforcer print `{hookSpecificOutput, skillConciergeOffer}` at exit (3265-3270): band, offered with scores, `jev.stage`, pulled, ext, xh, fallback. `ENFORCER_LEDGER=0` writes no row. Cline consumes `defer` (ADR-0086/0087).
- **Ledger pairing:** offer row `q` (≤120 ch) pairs with `ledger.py`'s turn row `q` by `(sid, q)`; `analyze.py`, `build_keep_off.py`, `extract_turn_labels.py` depend on it. A hinted turn records `via:"enhancer"`, `q` = prompt as sent, `rq` = route text.
- **Route-hint file (the one existing mod→hook channel):** `~/.claude/skill-concierge/route-hints/<sid>.json` = `{prompt, route, t}`, one-shot (deleted before validation), TTL 300 s, exact stripped-prompt match, finite `t`, depth-capped JSON (enforcer.py:1232-1263).
- **Latency (live ledger, epoch since 2026-10-10 23:09, Claude Code rows):** 531 rows: `harness_skip` 428 (81 %), `offer` 90, `jev_skip` 9. Jev full stage p50 2656 ms, p90 3746 ms, max 6383; wide p50 1934 ms. embed p50 83 ms; Qdrant p50 25 ms. 6 rows timed out at ~7.05 s and fell back to the embedding Preview. Answering tier: jevd `commandcode` 81, `typesafe` 2. The hook's total wall time (Python start-up, annexes) is not recorded.
- **jevd live status (12:00 today):** v0.2.0, healthy; Command Code p50 980 ms / p90 1477 ms over 393 calls; TypeSafe p50 357 ms / p90 924 ms. Endpoints: `POST http://127.0.0.1:4377/v1/systemone` (SystemOne `state` + `questions`: noul, choice, score), `GET /ladder`, `GET /health`; headers `X-Jevd-Provider` (pin), `X-Jevd-Budget`; refuses an `Origin` header, a non-loopback Host, a non-JSON body. jevd holds every provider key; callers send none. The owner's standing split (2026-10-06): jevd's config is the single source of the Jev ladder; the hook keeps its switches.

## 3. What the v0.67.0 mod does, and where it diverges

`adapters/claude-code/mod/hooks/register.tsx`: an `AbovePrompt` band (`Concierge [ Enhance ]`, hotkey `e`); Enhance → `$.model.fork` rewrite (sonnet fallback) → `$.prompt.fill` → `rankMenu(draft + intent)` by shelling out to `enforcer.py` with `ENFORCER_LEDGER=0`, session id `concierge-enhancer-preview`, no transcript, parsing the bullet text; `prompt.submit` (composer) writes the route hint when the sent text equals the rewrite.

- D1: preview has no transcript → no `recent_context` / `skills_already_loaded`.
- D2: in the preview the early lanes judge the route text; in the real hook they judge the sent text.
- D3: Jev runs twice per enhanced turn (preview, then the real hook); Jev is not deterministic, so the band can show a different menu than the model gets. The hint carries route text only, not a computed menu.
- D4: different session id → no CHAIN-HINT / ROUTE seed in the preview.
- D5: text scraping loses the header type, shares, badges, pull-ins, annexes, the skip reason, Jev stage.
- D6: 20 s preview timeout vs the hook's 10 s. D7: `enforcerPath` takes the first registry entry. D8: `$.process.run` env vs the command hook's env is unverified.
- **Collision:** its `AbovePrompt` hook returns its own tree and calls `next(e)` only when a survey shows; so does the old prompt-enhancer. Only the first in chain draws. Both use hotkey `e` ("Two on one hotkey: the later wins", d.ts:9405). Order among `user`-tier plugins is undocumented (d.ts:3918, 12600-12618); observed: the old one wins.

## 4. Claude Code 2.1.296 mod API: what is real

**Live-probed today** (throwaway plugin `plans/261012-1206-concierge-enhancer-redesign/probe/`, interactive session):

- P1. **A mod can call jevd directly.** `$.http.fetch('http://127.0.0.1:4377/v1/systemone', {method:'POST', headers:{'Content-Type':'application/json'}, body})` → 200, answered by `commandcode`. The engine adds no `Origin`.
- P2. **One plugin's `hooks/hooks.json` can hold both `modules` and command `hooks`;** both ran.
- P3. **A mod's `classic.UserPromptSubmit` hook did not fire** (one clean run with one file per event; an earlier run shared one log file and was inconclusive). An untested benign rival: the classic chain may include only `settings.json` hooks, not a plugin's own command hooks (d.ts:1250-1251). So a mod cannot read, replace or rewrite a command hook's `additionalContext` or stdin in this build, despite d.ts:1236-1300. Design must not depend on it.
- P4. **`prompt.submit` `context` reaches the model:** `next({...e, context:[...(e.context??[]), text]})` showed up in the model's context as "prompt.submit hook additional context: …". A native model-only injection channel.
- P5. **`prompt.submit` runs before the command hooks, and its `next(e)` waits for them:** origin `{kind:'composer'}`; `next(e)` resolved 2.6 s later (the UserPromptSubmit command hooks, concierge's enforcer included). A file the mod writes before `next(e)` is there when the enforcer runs (confirmed earlier by a live `via:"enhancer"` row).
- P6. **`prompt.autocomplete` fires while typing** (token, whole draft text, cursor), and the engine does not wait on it: a non-blocking draft observer.
- P7. **Command hook stdin** carried `cwd, hook_event_name, permission_mode, prompt, prompt_id, session_id, transcript_path` (no `source` yet).

**Documented, not probed:**

- `prompt.submit` result never carries the command hooks' output (d.ts:9104-9148). `e.text` = "as it will reach the model (pastes already expanded)". Context put after `next` resolved is dropped.
- Hook budget: 10 s of the hook's own time per dispatch; the clock stops while `next(e)` or any `$` call is in flight (d.ts:5100-5133). `next.signal` aborts on interrupt.
- `prompt.edit` fires per edit burst, on the keystroke path (returns the box the editor shows); its result may carry additive `decorations` (d.ts:8519, 8540-8615).
- `$.model.complete({model:'haiku'|…, timeoutMs, effort, maxTokens})` on the session's own client (Max); `$.model.fork` reuses the main thread's last request (all tools denied; `nothing-to-fork` on a fresh session); `$.model.classify(text, labels)` on the small fast model.
- **UI surfaces:**
  - `AbovePrompt`: one shared instance; `next(e)` = the drawing beneath; a hook may "return it, wrap it, draw your own, or rewrite props" (d.ts:3977-3988, 10253-10309); capped at half the terminal rows, then scrolls.
  - `PromptHint`: one shared line; props `isDraft`, `isWorking`, `hint`, `tail` ("The terminal keeps the engine's line … and draws `tail` dim at its end"; "a rewritten `hint` replaces the line, `tail` with it") (d.ts:10212-10252). Terminal only for `tail`.
  - `$.ui.status`: "One per plugin" (d.ts:2472-2483): additive. `$.ui.toast`: per plugin. `Pane`: one per id, placed unasked only from 144 columns.
  - Button `hotkey` fires only while the band/pane is focused; Button `action` chord "presses this from the prompt … while mounted" (d.ts:1095-1103); valid action names undocumented.
  - `command.register` / `command.run` → `{text, context?}`; a typed `/cmd` leaves the command in the box, so a command cannot read an earlier draft.
  - `$.ui.invalidate`: ≤10 redraws/s (30 for band and prompt hint).
- **State:** `$.state` (session, any plugin reads, owner writes, subscribes drawings), `$.store` (per plugin, cross-session, 4 MiB), `$.fs` (no append), `$.session.id()` (async; the transcript file's name), `$.env.set` (process-wide; inheritance by command hooks untested).
- **Test kit:** can raise `prompt.submit` (with origin), `classic.*` (no real settings hooks beneath), mount `AbovePrompt`/`PromptHint`, and load inline peer plugins (`test(name, {plugins:[…]})`) to test coexistence with another band mod. Cannot raise `prompt.edit` / `prompt.autocomplete`.

## 5. Prior art in this repo (native adapters that integrate deeper than a command hook)

- **Cline** (`adapters/cline/skill-concierge.cline-plugin.ts`, ADR-0086/0087): two enforcer passes per run, both `ENFORCER_LEDGER=defer`: full (Jev, typesafe tier, 20 s) and preview (`ENFORCER_JEV_ROUTER=0`, embedding only, 2 s). Waits ≤2 s; logs exactly the menu the first model call carried (`seen: full|preview`); a later full row is `offer_late`.
- **Command Code** (`adapters/commandcode/skill-concierge.mod.ts`): ranks the typed text, not the stored message; caches per prompt key; `ENFORCER_JEV_BUDGET=1.6`.
- **OpenCode** (`adapters/opencode/plugin/index.ts`): context hook pushes the enforcer block as system text; writes the turn row itself.

## 6. Constraints any design must keep

- Fail open everywhere: a mod failure never blocks or delays a prompt beyond today's behavior; concierge's command hook keeps working with the mod absent (the other seven harnesses never see the mod).
- The model must receive one menu per turn, from one ranking; the doctrine's header semantics (whole-shelf vs preview) must stay truthful.
- Offer/turn rows keep pairing on `(sid, q)`; a new mode must be visible in the ledger (`via`, stage), and an enforcer change starts a new epoch (AGENTS.md *Ledger metrics are EPOCH-SCOPED*).
- `hooks/scripts/*.py` must load on Python 3.9 (`tests/test_python39_hooks.py`); `ENGINE_ENV_KEYS` invariant untouched unless index-shaping.
- No secrets in the mod; jevd holds keys. Spend stays on Max (the session's own client) or the owner-approved Jev channels (Command Code, TypeSafe) via jevd.
- 81 % of UserPromptSubmit calls are harness text; any per-keystroke or per-prompt work must skip those cheaply and never fire on slash commands or ≤3-word drafts.
- Coexistence: a good-citizen mod composes on every shared surface (`next(e)` inside its tree, appends to `tail`/`decorations`/`context`), uses no contested hotkey, and still works when another mod above it does not compose.

## 7. Corrections from the explainer's spot-check

See `grounding-explained.md`: Jev starts only when no deterministic route matched (enforcer.py:3123); a malformed hint file stays on disk (harmless); `prompt.submit` may rewrite `text` via `next({...e, text})` (d.ts:9114, unprobed). Untested: whether a rewritten `prompt.submit` text reaches the command hook's stdin, and whether `$.env.set` reaches the command hook's environment. Do not depend on either.
