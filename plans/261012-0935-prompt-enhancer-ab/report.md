# A/B: does the prompt-enhancer improve concierge's 5-skill menu?

Date: 2026-10-12 · Claude Code 2.1.296 · n = 20 real prompts · two rounds, each judged blind by a fresh Opus agent.

## Verdict

Yes, modestly, and only in one shape: rank the author's raw prompt plus a short intent line the rewrite writes separately, with the author's own terms copied verbatim. Ranking the full rewrite makes the menu worse.

## Method

1. `extract_prompts.py`: 20 typed English prompts from Claude Code transcripts across 12 projects, at most 3 per project. Prompts with an email, a long digit run, a credential name or harness text were excluded.
2. `rewrite_prompts.py`: an isolated `claude -p --model sonnet` call per prompt, run with no settings sources from an empty folder. This gives the rewrite less context than the mod's forked path, so the test is conservative.
3. `rank_prompts.py`: each text ranked by `hooks/scripts/enforcer.py` through its real stdin path, with the ledger off (`ENFORCER_LEDGER=0`) and the log dir in a scratch folder.
4. A blind judge saw the request, the project name and three menus shuffled as X/Y/Z, ranked them, and wrote `judge_verdict.json` / `judge2_verdict.json`. The keys (`judge_key.json`, `judge2_key.json`) were applied afterwards.

## Results

Pre-round finding, from the first rewrite rules, which had an "ask the author before starting" section: `first-ask` landed in 12 of 20 menus and `zero-guess:clarify` in 9. Thinh ordered that section removed (2026-10-12).

Round 1, after removing the ask section (`ranked2.jsonl`):

| Text ranked | Points (2/1/0) | Firsts | Lasts |
|---|---|---|---|
| raw prompt | 24 | 9 | 5 |
| intent line | 23 | 7 | 4 |
| full rewrite | 13 | 4 | 11 |

Head to head: intent beat full 14–6, raw beat full 13–7, and raw beat intent 11–9. The judge's reasons point to the author's own words: "chisle", "ADHD procedure", "ck-team" and "explain the delta" routed well, and the rewrite paraphrased them away (it changed "chisle" to "chisel"). The full rewrite also left 3 menus empty, where long text fell back to "No preview this turn".

Round 2, with the intent line told to copy the author's names and coined terms verbatim (`ranked3.jsonl`):

| Text ranked | Points (2/1/0) | Firsts | Lasts |
|---|---|---|---|
| raw + intent | 23 | 7 | 4 |
| intent line | 22 | 9 | 7 |
| raw prompt | 15 | 4 | 9 |

Head to head: raw+intent beat raw 13–7, intent beat raw 12–8, and raw+intent vs intent was 10–10. Empty menus: raw+intent 0, intent 1.

The raw data (the sampled prompts, rewrites, rankings, judge inputs, keys and verdicts) is the owner's real typed prompts, so it stays out of this public repository; it is kept on the owner's machine in `~/_ARCHIVE/skill-concierge-enhancer-ab-261012/`. The three scripts here reproduce it.

## Limits

- n = 20, and the judge marked 6 to 7 items per round as low confidence (short follow-ups with hidden context). Treat the effect as suggestive, not proven.
- The raw arm was re-ranked in round 2 and scored lower than in round 1 (15 vs 24 points). The Jev router is not deterministic and each round had a different judge, so compare arms within a round, never across rounds.
- The rewrites saw no session context. The live mod forks the session, which should help most on follow-ups.

## Decision this supports

The enhancer writes two things: the full rewrite, which goes into the prompt box for the user, and an `<intent>` line. Concierge ranks the raw draft plus the intent line. That combination never produced an empty menu, tied the intent line alone, and keeps the author's words when a rewrite drops them.

Feasibility check: `$.process.run` takes `stdin` (`claude-code.d.ts`, `ProcessRunInit.stdin`), so the mod can call `enforcer.py` exactly as the hook does.
