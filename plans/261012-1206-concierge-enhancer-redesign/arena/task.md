# Arena task: redesign the concierge-enhancer mod

You produce ONE candidate design package. You change no file outside your own output directory. Working directory: `/Users/thinhkhuat/in-PROD/MY-WORKBENCH/skill-concierge`. Timezone Asia/Saigon. Write in English: plain, direct, complete sentences.

## Read first, in full

1. The architect workflow you are inside: `/Users/thinhkhuat/.claude/plugins/cache/pstack-claude/pstack/0.9.82/skills/architect/SKILL.md`
2. Your runner discipline: `…/skills/architect/references/runner-prompt.md`
3. The package shape: `…/skills/architect/references/rationale-template.md` (leave "Synthesis decision" empty)
4. The screen every candidate must pass: `…/skills/architect/references/design-red-flags.md`
5. The grounding (facts, live-probe results, constraints): `plans/261012-1206-concierge-enhancer-redesign/grounding.md`. Treat its section 4 "Live-probed today" items as settled facts. If `plans/261012-1206-concierge-enhancer-redesign/grounding-explained.md` exists, read it too; where it corrects grounding.md, it wins.

Then read the code you design against: `hooks/scripts/enforcer.py` (at least `main()` 3052-3270, `_route_hint` 1232-1263, `_offer_ev` 1359-1401, `_jev_route` 2227-2342, `_jev_join` 2366-2403, `_ranked_mandate` 2868-2937), the current mod `adapters/claude-code/mod/hooks/register.tsx`, its tests `adapters/claude-code/mod/tests/concierge-enhancer.test.ts`, and the prior-art adapters named in grounding §5. The mod API authority is `/Users/thinhkhuat/.tmp/claude-501/bundled-skills/2.1.296/fbcef4cae6acb4b2799e4c236f7676c1/plugin-authoring/` (`reference.md`, `types/claude-code.d.ts`, `examples/`). Grep it; do not guess an API.

## The task

Design the next version of `concierge-enhancer`, the Claude Code mod in `adapters/claude-code/mod/`, so it improves skill-concierge's initial skill menu (the 5-row offer the model reads each turn) **as part of how concierge works**, not as a copy of the standalone prompt-enhancer's band.

The owner's requirements, verbatim where quoted:
- Its purpose is to "enhance & optimize the menu of 5 [concierge] offers initially".
- It must be "integrated with how the concierge works", "seamless, sophisticated", "work as expected", and "won't collide with other mods".
- It must use Jev through jevd, "a critical advantage" the last version ignored.
- Standing decisions: an intent/rewrite names no skills, keeps the author's own terms verbatim, has no ask-the-author section.

You may change the mod (any files under `adapters/claude-code/mod/`) and `hooks/scripts/enforcer.py` (and add a small Python module beside it if that is the honest shape). You may not change `hooks/hooks.json`. Every other harness keeps working unchanged. Decide for yourself whether the visible "Enhance" rewrite of the prompt box stays, changes, or goes; justify it against the owner's goal.

Commit to one whole shape and make it the best your model can design. Do not hedge toward a safe middle; other runners on other models are designing in parallel, and the differences between candidates are the signal.

## Deliverables (in your output directory, given below)

1. `rationale.md`: the package per the rationale template (Problem, Usage first, Shape, Tradeoffs accepted, Alternatives considered with at least one whole-shape alternative, Implementation reconciliation left as a stub, Open questions and risks). Include a short **turn timeline**: what happens from the first keystroke to the model reading the menu, which process does what, and the latency the user feels, citing grounding numbers.
2. `sketch/`: the type and signature sketch. For the mod: a `register.tsx` (or several files) with real types, hook registrations and signatures, bodies `throw new Error('not implemented')` or `// TODO` pseudocode. For the enforcer: the new or changed Python signatures with docstrings stating invariants, bodies `raise NotImplementedError` or pseudocode. Keep it a sketch, not an implementation.
3. A **red-flags screen**: a short table in `rationale.md` listing each red flag from `design-red-flags.md` and how your design avoids it or why it does not apply.
4. A **verification plan**: how to prove, before release, that it works as expected and does not collide (unit tests with the `claude-code/testing` kit including an inline peer band plugin, Python tests, and one live drive), each with its pass condition.

End your reply with:
Status: DONE | DONE_WITH_CONCERNS | BLOCKED
Summary: one or two sentences naming your shape.
