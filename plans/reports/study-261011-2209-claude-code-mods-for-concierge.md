# Claude Code mods: what skill-concierge could gain

Date: 2026-10-11 · Claude Code 2.1.296 · Status: study only, nothing built.

## Sources read

- Video transcript: `MY-WORKBENCH/plans/reports/_RESEARCH_ARTIFACTS/prompt-enhancer-video/transcript.txt` (AI Labs, eight mods: prompt enhancer, design-style picker, assumption checker, idea shelf, session board, same-folder session tracker, plain-language answer rewriter, plus the built-in `/diff` and "you should know" mods).
- Thinh's mod: `MY-WORKBENCH/mods-dev/prompt-enhancer/` (`hooks/register.tsx`, 125 lines; README; tests; local marketplace `tk-mods`).
- The mod API for this build: the bundled `plugin-authoring` skill, `reference.md` and `types/claude-code.d.ts` (21,443 lines) under `~/.tmp/claude-501/bundled-skills/2.1.296/.../plugin-authoring/`.
- Concierge's current wiring: `hooks/hooks.json` (5 SessionStart, 2 UserPromptSubmit, 1 PreToolUse(Skill), 2 PostToolUse command hooks).

## What a mod is (facts)

- A plugin whose `hooks/hooks.json` names a TypeScript module under `modules`. The module exports `register(on)`; every hook is `($, e, next)` and runs inside Claude Code, always on (`reference.md`, "What a plugin of function hooks is").
- Unlike a command hook, a mod can rewrite what the engine does (`next({...e, ...})`), draw UI (`ui.render` on `AbovePrompt`, `Pane`, tool rows, `AskUserQuestion`, and others; `claude-code.d.ts:9368`), call a model (`$.model.fork`, `$.model.complete`), and run host commands (`$.process.run`).
- Events that touch concierge's job:
  - `prompt.submit`: fires before the turn; rewrite or drop the prompt (`claude-code.d.ts:4110`).
  - `skill.prompt`: fires whenever the engine expands a skill for the model, from `/name`, the Skill tool, or a preload; the hook can replace the text (`claude-code.d.ts:4318`, input `{ skill, text }` at `:11897`).
  - `prompt.attachment`: one of its kinds is `skill_listing`, the skill list the model sees; text is rewritable (`claude-code.d.ts:14538`).
  - `turn.step` (streams each model request) and `session.append` (every row stored, including the model's response, door `response`).
  - `tool.call` / `tool.check`: gate a tool call, with `.catch` to fail closed.
- Limits: `ui.press` has a 10-second budget (prompt-enhancer README, "Known limits"); the API is early access and "moves between releases" (`reference.md`); `prompt.section` / `tool.describe` answers are cached and an unstable answer spends the prompt cache (`claude-code.d.ts`, docs of both events).

## Recommendations, best first

### 1. Check the SKILL-FIRST ruling where it is written (highest value)

Today the ruling line (`USING:` / `SEARCH:` / `NO SKILL:`) is enforced by doctrine text alone, and compliance is measured afterward from transcripts. A mod hook on `session.append` (door `response`) or `turn.step` can read the model's first text block and check, in the same turn:

- a line 1 ruling exists;
- `SEARCH:` was followed by a `search_skills` call in that reply;
- `USING: X` was followed by a Skill or `get_skill` call for X.

On a miss it appends a user-role meta row (`$.session.append`, which the model reads at the next loop top) naming the breach. This is RULES [47] (deterministic prevention at generation time) applied to concierge's core problem, the dodge. It mirrors the video's assumption checker, which catches what the model decided silently.

Rollout: shadow first (log `ruling_check` rows to the ledger, no nudge), then nudge. It changes what the ledger measures, so it opens a new epoch.

### 2. One capture point for every skill load: `skill.prompt`

`ledger.py` and `skill_exclusions.py` hang on `PostToolUse(Skill|get_skill)`. `skill.prompt` fires for the Skill tool, a typed `/name`, and a preload alike, so:

- the ledger records every real load, not only tool-path ones (Inference: typed `/name` loads are invisible to PostToolUse today; unverified);
- the "Not for" echo can be appended to the skill body itself, instead of a separate context row after the call.

### 3. Feed prompt-enhancer from concierge instead of the model's guess

prompt-enhancer's rule 2 asks the forked model to name fitting skills from the listing it sees (`hooks/register.tsx:13`). Concierge already ranks the whole shelf (Jev router, badges, cross-harness isolation). The mod can call the engine through `$.process.run` (a `bin/` CLI that prints the ranked rows as JSON) and put those names into the rewrite rules. Result: the enhancer names skills by concierge's retrieval, which is measured, instead of by a model reading 600+ skill descriptions.

Same band, two extra buttons: ❤️ / ⭐ on the top row, writing through `scripts/reputation.py`. That gives the owner a one-key way to rank skills while working.

### 4. Shape the skill listing at render time (later)

`prompt.attachment` with type `skill_listing` can drop blocklisted skills and trim keep-off ones in the text the model reads, instead of `apply-overrides.py` editing settings. Hold this until 1–3 prove out: the answer must be stable per session, or it spends the prompt cache.

### 5. Health in a status line (small)

A `session.start` hook can show doctor's one-line verdict (index owner up, engine version skew such as the 11 stale MCP servers after v0.66.4) as a toast or status, without a model turn.

## Constraints that shape any build

- **Claude Code only.** Seven other harnesses keep the Python hooks. The mod is an additive layer: it calls the same Python (enforcer, ledger, reputation) through `$.process.run` and moves no logic out of Python. Cline and OpenCode already have native code plugins (ADR-0085, ADR-0086), so this is the same pattern for Claude Code.
- **Ship it as a separate plugin** (for example `skill-concierge-mod`). Editing `hooks/hooks.json` trips `tests/test_hook_definitions_pinned.py` and makes Codex users re-trust the hooks (caveats §27).
- **Release proof.** `scripts/smoke.py` runs headless turns; `ui.render` never draws there. Add `claude plugin validate` and `claude plugin test` to the release order for the mod.
- **Budgets.** Jev's route budget is 7.8 s, under the 10 s press budget but close: start the work unawaited and guard re-entry, as prompt-enhancer does (`hooks/register.tsx:108-109`).
- **Fail-silent.** Hooks that fail are skipped by the engine; only a guard gets a `.catch`, matching concierge's fail-open rule.

## Not worth doing

- Porting the enforcer into the mod: it would fork the logic from seven harnesses for no gain.
- Re-registering `search_skills` as a mod tool (`$.tool.register`): the MCP server already serves it.

## Unresolved questions

1. Can one `hooks/hooks.json` hold both `modules` and command hooks? Unverified; the separate-plugin route avoids the question.
2. Do typed `/name` skill loads reach `PostToolUse(Skill)` today? Unverified; a one-line probe in a live session settles it and decides how much item 2 gains.
3. Should the ruling check nudge the model (item 1) or only log? Product call for Thinh; recommended: log one epoch, then nudge.
