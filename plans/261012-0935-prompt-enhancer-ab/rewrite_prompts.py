"""Rewrite each sampled prompt the way the intent-only enhancer would.

The rules are prompt-enhancer's (mods-dev/prompt-enhancer/hooks/register.tsx:9-19) with
two changes Thinh ordered on 2026-10-12: name no skills (intent only), and no ask-the-author
section (the agent acts autonomously). It also writes a separate <intent> line. Each call
is an isolated `claude -p` on sonnet (the mod's fresh-session fallback model), run from an
empty folder with no settings sources, so no hook or project context leaks in. That gives
the rewrite less context than the mod's forked path has, so this A/B is conservative.
Usage: rewrite_prompts.py IN.jsonl OUT.jsonl
"""
import concurrent.futures
import json
import re
import subprocess
import sys
import tempfile

RULES = """Goal: rewrite the rough prompt below into a clear, complete prompt that an autonomous coding agent acts on in this project from start to finish.

Success means the rewrite:
1. Keeps the author's intent, scope and language, with requirements drawn only from what they asked for or clearly implied.
2. States the kind of work and its domain: what is built, fixed, reviewed, researched or written, and the tools, file types, services and artifacts involved.
3. Describes the finished result: the deliverable and how to tell it is done.
4. Fits this project, using only the paths and facts its folder, files, conventions and the conversation show.
5. Leaves skill choice to the agent's skill router: it names the work, and leaves skills, plugins, agents and slash commands unnamed.

Output, in this order:
- <intent></intent>: one or two plain sentences naming only the work and its domain. Copy the author's own names verbatim: tools, files, procedures, people, and any coined or misspelled term ("chisle" stays "chisle").
- <prompt></prompt>: the rewritten prompt, in the author's voice, as the message they will send, in short sections or bullets.

Stop after </prompt>."""


def rewrite(row):
    ask = f"{RULES}\n\n<rough_prompt>\n{row['prompt']}\n</rough_prompt>"
    with tempfile.TemporaryDirectory() as cwd:
        r = subprocess.run(["claude", "-p", "--model", "sonnet", "--setting-sources", "", "--strict-mcp-config", ask],
                           cwd=cwd, capture_output=True, text=True, timeout=180)
    m = re.search(r"<prompt>([\s\S]*?)</prompt>", r.stdout)
    i = re.search(r"<intent>([\s\S]*?)</intent>", r.stdout)
    return {**row, "intent": i.group(1).strip() if i else "", "enhanced": (m.group(1) if m else r.stdout).strip(), "rewrite_ok": bool(m) and r.returncode == 0}


rows = [json.loads(l) for l in open(sys.argv[1])]
with concurrent.futures.ThreadPoolExecutor(4) as pool:
    done = list(pool.map(rewrite, rows))
with open(sys.argv[2], "w") as fh:
    for d in done:
        fh.write(json.dumps(d) + "\n")
print(f"rewritten={sum(d['rewrite_ok'] for d in done)}/{len(done)}")
