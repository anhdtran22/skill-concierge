"""Rank the raw and the enhanced text of each prompt through concierge's own enforcer.

Runs hooks/scripts/enforcer.py exactly as the UserPromptSubmit hook does (stdin JSON), with
the ledger switched off and the log dir pointed at a scratch folder, so the live ledger is
untouched. Keeps the band line and the menu rows ("  • name ...") the model would see.
Usage: rank_prompts.py IN.jsonl OUT.jsonl
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile

ENFORCER = os.path.join(os.path.dirname(__file__), "..", "..", "hooks", "scripts", "enforcer.py")
SCRATCH = tempfile.mkdtemp(prefix="ab-rank-")


def rank(text, sid):
    env = {**os.environ, "ENFORCER_LEDGER": "0", "SKILL_CONCIERGE_LOG": SCRATCH}
    r = subprocess.run(["python3", ENFORCER], input=json.dumps({"prompt": text, "session_id": sid}),
                       capture_output=True, text=True, timeout=60, env=env)
    out = r.stdout.strip().splitlines()
    ctx = ""
    if out:
        try:
            ctx = json.loads(out[-1]).get("hookSpecificOutput", {}).get("additionalContext", "")
        except ValueError:
            ctx = r.stdout
    rows = [ln.strip()[2:] for ln in ctx.splitlines() if ln.strip().startswith("• ")]
    head = next((ln.strip() for ln in ctx.splitlines() if ln.strip() and not ln.startswith("SKILL-FIRST")), "")
    return {"menu": rows, "head": head[:200], "context_chars": len(ctx)}


def both(row):
    return {**row, "raw_rank": rank(row["prompt"], f"ab-raw-{row['id']}"),
            "enh_rank": rank(row["enhanced"], f"ab-enh-{row['id']}"),
            "intent_rank": rank(row["intent"], f"ab-int-{row['id']}") if row.get("intent") else None,
            "combo_rank": rank(row["prompt"] + "\n\n" + row["intent"], f"ab-combo-{row['id']}") if row.get("intent") else None}


rows = [json.loads(l) for l in open(sys.argv[1])]
with concurrent.futures.ThreadPoolExecutor(3) as pool:
    done = list(pool.map(both, rows))
with open(sys.argv[2], "w") as fh:
    for d in done:
        fh.write(json.dumps(d) + "\n")
print("ranked", len(done), "| empty raw menus:", sum(not d["raw_rank"]["menu"] for d in done),
      "| empty enhanced menus:", sum(not d["enh_rank"]["menu"] for d in done))
