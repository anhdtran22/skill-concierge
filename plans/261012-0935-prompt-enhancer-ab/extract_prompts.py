"""Pick N real, typed, English task prompts from Claude Code transcripts for the A/B.

Skips harness text, slash commands, short replies, non-English prompts and any prompt
carrying an email address or a long digit run (personal data stays out of the sample).
Usage: extract_prompts.py OUT.jsonl [N] [SEED]
"""
import glob
import json
import os
import random
import re
import sys

out, n, seed = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 20, int(sys.argv[3]) if len(sys.argv) > 3 else 7
PII = re.compile(r"[\w.+-]+@[\w-]+\.\w+|\d{6,}|AUTH_TOKEN|API_KEY|Heartbeat check|ack via:")
files = sorted(glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")), key=os.path.getmtime, reverse=True)[:400]
seen, pool = set(), []
for f in files:
    project = os.path.basename(os.path.dirname(f))
    for line in open(f, errors="replace"):
        if '"promptSource":"typed"' not in line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        text = (row.get("message") or {}).get("content")
        if not isinstance(text, str):
            continue
        text = text.strip()
        words = len(text.split())
        if (text.startswith(("<", "/", "!")) or not 12 <= words <= 220 or PII.search(text)
                or sum(c.isascii() for c in text) / len(text) < 0.97 or text in seen):
            continue
        seen.add(text)
        pool.append({"project": project, "prompt": text})

random.Random(seed).shuffle(pool)
picked, per_project = [], {}
for p in pool:  # at most 3 per project, so one busy repo does not dominate the sample
    if per_project.get(p["project"], 0) < 3:
        per_project[p["project"]] = per_project.get(p["project"], 0) + 1
        picked.append(p)
    if len(picked) == n:
        break
with open(out, "w") as fh:
    for i, p in enumerate(picked):
        fh.write(json.dumps({"id": i, **p}) + "\n")
print(f"pool={len(pool)} picked={len(picked)} projects={len(per_project)}")
