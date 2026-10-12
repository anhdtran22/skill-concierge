# Intent-line gate (2026-10-12)

Question: does adding a one-line restatement of the draft (the mod's `intent` option) to the text concierge ranks give better menus than the draft alone?

Method: the same 20 real prompts as `plans/261012-0935-prompt-enhancer-ab/`; intent lines written with `rules.txt` by `gen.py` (headless `claude -p`, hooks off, Max); both arms ranked by `rank.py` through a frozen copy of the v0.67.0 enforcer; a blind opus judge picked the better menu per prompt (X/Y order randomized, key kept apart).

| Intent writer | Draft alone won | Draft + intent won | Tie |
|---|---|---|---|
| haiku | 9 | 5 | 6 |
| sonnet | 7 | 7 | 6 |

Result: no gain from either writer, so the `intent` option ships off by default. The earlier 13-7 gain in the round-2 A/B came from an intent line produced by a different, richer rewrite prompt; that generator was not re-tested here.

The prompts, intent lines, menus, verdicts and keys are the owner's real typed prompts and stay out of this public repository, in `~/_ARCHIVE/skill-concierge-enhancer-ab-261012/intent-gate-261012/`.
