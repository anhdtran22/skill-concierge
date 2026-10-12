# How the concierge offer reaches the model, and where a mod can act (2026-10-12)

Explains `grounding.md`, checked against source; corrections at the end. "Probed" = seen live in Claude Code 2.1.296; "documented" = read in the bundled `claude-code.d.ts`, untested.

## Overview

On every UserPromptSubmit, `hooks/hooks.json` runs the command hook `enforcer.py` (10 s timeout), then `ledger.py` (5 s). `enforcer.py` ranks the skill catalogue for the prompt and returns a short menu as `additionalContext`, which the model reads beside the prompt.

The `concierge-enhancer` mod (`adapters/claude-code/mod/`, a separate plugin) cannot touch that menu once built. Its levers: change what the hook ranks (route-hint file), add its own context beside the prompt, and preview before sending.

## Key Concepts

- **The offer.** A menu of up to about five skill rows, with a header that tells the model what kind of list it holds. "Whole-shelf ranking…" means Jev judged every skill. "Preview for this task…" means an embedding top-k (`enforcer.py:2859-2865`). The doctrine sets different duties for each header (`hooks/doctrine/skill-first.md:33-39`), so the header must stay truthful.
- **Jev router.** A second-opinion ranker reached through jevd (`127.0.0.1:4377`). It runs in a thread alongside the embedding lookup (`_jev_start`, `enforcer.py:2351`), English prompts only (`:2232`). Its hard cap is 7.8 s (`JEV_BUDGET_S`, `:1543`). Its input state is the prompt, the last assistant text, and the skills already loaded, read from the transcript (`:2252`).
- **Lanes.** Cheap early exits that skip ranking: slash commands, three words or fewer, harness-generated text, refusals, consult routing, and self-reference.
- **Route hint.** The only channel from the mod to the hook: a file at `~/.claude/skill-concierge/route-hints/<sid>.json` holding `{prompt, route, t}` (`enforcer.py:1231-1263`).
- **Ledger pairing.** The hook's offer row and `ledger.py`'s turn row are joined on `(sid, q)`, where `q` is the first 120 characters of the prompt as sent. On a hinted run, `_VIA` keeps `q` as the sent text and adds `via:"enhancer"` and `rq` (`:1373`, `:3111`).

## How It Works: one turn

1. **Typing (mod can act).** `prompt.autocomplete` fires on keystrokes, unawaited: a free draft observer (probed, P6). `prompt.edit` can add `decorations` (documented). The `AbovePrompt` band and the `PromptHint` `tail` can show a preview. A mod can call jevd here with `$.http.fetch` (probed, P1).
2. **Enter pressed: `prompt.submit` (mod can act, last chance).** It runs before the command hooks, and `next(e)` does not resolve until they finish. The probe measured 2.6 s from the hook's entry to `next(e)` resolving (`~/.tmp/ce-probe/submit.*`). A file written before `next(e)` is on disk when `enforcer.py` starts; that is why the route hint works (`register.tsx:191-194`, `:155-163`). Context appended as `next({...e, context:[…]})` reaches the model as a separate block. The probe transcript holds "prompt.submit hook additional context: PROBE-SUBMIT-CONTEXT-GAMMA" (P4). A hook can also rewrite `text` (documented, d.ts:9114-9115; whether the command hook's stdin then sees the rewrite is not probed).
3. **Command hooks run (mod cannot act).** `enforcer.py main()` (`:3052`):
   - It reads `prompt`, `session_id`, `agent_id` and `transcript_path` from stdin (`:3058-3123`).
   - It consumes the route hint first (`:3061`), so even a turn an early lane ends spends the hint.
   - The early lanes judge the **sent** text (`:3065-3104`).
   - Only after the lanes does a valid hint replace `prompt` with the route text (`:3110-3112`).
   - Deterministic name routes come next (`:3117`). Jev starts only when no route matched (`:3123`).
   - Then the embedding lookup (0.5 s timeout) and the Qdrant query (`:3137`, `:3149`).
   - The Jev result is joined (`:3171`). A best fit under 0.30 gives `jev_skip` (`:3172-3176`). Otherwise Jev's rows become the menu and the getaway and actionability gates are skipped (`:3185`, `:3198`).
   - The annexes are queried (`:3218-3227`) and the menu is rendered with the chain hint added (`:3235`).
   - `_inject` prints `{hookSpecificOutput:{additionalContext}}` (`:1408-1413`). Under `ENFORCER_LEDGER=defer` the offer row is returned in the same JSON at exit (`:3265-3270`).

   A mod's `classic.UserPromptSubmit` hook never fired in the probe: the hook's `PROBE-CMD-CONTEXT-ALPHA` reached the model and the mod's replacement `PROBE-REPLACED-BETA` never appeared (P3). The mod cannot read or edit the hook's output.
4. **The model reads** prompt, menu, and any `prompt.submit` context.

## Where Things Live

| What | Where |
|---|---|
| Hook wiring (pinned; any edit forces Codex users to re-trust the hooks) | `hooks/hooks.json`, `tests/test_hook_definitions_pinned.py` |
| Ranking, lanes, Jev, render | `hooks/scripts/enforcer.py` (`_jev_route` 2227, `_ranked_mandate` 2868, `main` 3052) |
| Turn row | `hooks/scripts/ledger.py:143` |
| Mod (v0.67.0) | `adapters/claude-code/mod/hooks/register.tsx`; plugin entry 2 in `.claude-plugin/marketplace.json` |
| Mod API types | `~/.tmp/claude-501/bundled-skills/2.1.296/…/plugin-authoring/types/claude-code.d.ts` |
| Live probe | `plans/261012-1206-concierge-enhancer-redesign/probe/`; output in `~/.tmp/ce-probe/` |
| Prior art: two-pass `defer` | `adapters/cline/skill-concierge.cline-plugin.ts` |

## Gotchas

- **The preview is not the menu.** `rankMenu` (`register.tsx:57-86`) runs a second `enforcer.py` under the fake session `concierge-enhancer-preview`, with no transcript, so no recent context and no chain-hint seed. Jev is not deterministic, so the band can differ from what the model gets; the hint carries route text, not a menu.
- **Text scraping loses meaning.** Parsing `• ` rows drops header type, shares, badges, pull-ins, Jev stage; `ENFORCER_LEDGER=defer` returns them as JSON.
- **Early lanes ignore the hint**: they judge the sent text.
- **Hint files.** One-shot only once parsed; a malformed file stays on disk (`:1248-1254`), harmless because of the exact-match and 300 s checks.
- **Budget.** Hook timeout 10 s; Jev may take 7.8 s (full-stage p50 2.66 s per grounding.md, not re-measured). A mod's 10 s budget pauses during `$` calls and `next(e)` (d.ts:5100-5133).
- **Collisions.**
  - `AbovePrompt` is one shared instance. v0.67.0 calls `next(e)` only when a survey shows (`register.tsx:197`); the disabled `prompt-enhancer` does too, so the first in chain hides the other.
  - Both mods bind hotkey `e`, and "Two on one hotkey: the later wins" (d.ts:9405).
  - Additive surfaces are safe: `$.ui.status`, `PromptHint.tail`, `prompt.submit` `context`, `decorations`. Rewriting `hint` replaces the whole line (d.ts:10249).
- **81 % of hook calls are harness text.** Mod work must exit cheaply on those, slash commands, and drafts of three words or fewer.
- **Epochs.** An `enforcer.py` change starts a new ledger epoch; a new mode must show in the row.

## Corrections to grounding.md

1. §2 lane order: Jev starts **only when no deterministic route hit** (`enforcer.py:3123`, `if not _hits`).
2. §2 route hint:
   - The file is removed only **after** it parses as JSON. A malformed or unreadable file stays on disk (`:1248-1254`).
   - "Depth-capped JSON" overstates the guard. The code catches `RecursionError` and has no explicit depth cap.
3. §4: the `e.text` quote "as it will reach the model" is at d.ts:9061, not inside 9104-9148.
4. §4 P3: the conclusion holds, but there is an untested benign explanation. d.ts:1250-1251 defines the classic chain as "[managed settings hooks, ...hooks modules, the other settings hooks as core]". A **plugin's** command hook may sit outside that chain, so the event may still fire for hooks defined in `settings.json`.
   - Only one run's files remain in `~/.tmp/ce-probe/`; its transcript shows ALPHA and GAMMA reached the model, BETA did not.
5. Added: `prompt.submit` can rewrite `text` (d.ts:9114-9115). This is not probed.

## Open questions

- Does a rewritten `prompt.submit` `text` reach the command hook's stdin `prompt`?
- Does `classic.UserPromptSubmit` fire for a hook defined in `settings.json` (not one from a plugin)?
- Does `$.env.set` reach the command hook's environment? Untested: the probe set it inside the `classic` hook, which never ran.
