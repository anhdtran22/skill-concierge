import concurrent.futures, json, os, subprocess, sys, tempfile
ENF = os.path.expanduser('~/.tmp/intent-gate/snap/hooks/scripts/enforcer.py')
SCR = tempfile.mkdtemp(prefix='gate-rank-')
def rank(text, sid):
    env = {**os.environ, 'ENFORCER_LEDGER': '0', 'SKILL_CONCIERGE_LOG': SCR}
    r = subprocess.run(['python3', ENF], input=json.dumps({'prompt': text, 'session_id': sid}), capture_output=True, text=True, timeout=60, env=env)
    ctx = ''
    for ln in reversed(r.stdout.strip().splitlines()):
        try: ctx = json.loads(ln).get('hookSpecificOutput', {}).get('additionalContext', ''); break
        except ValueError: pass
    return [ln.strip()[2:] for ln in ctx.splitlines() if ln.strip().startswith('• ')]
def both(r):
    return {**r, 'raw': rank(r['prompt'], f"g-raw-{r['id']}"), 'combo': rank(r['prompt'] + '\n\n' + r['intent'], f"g-combo-{r['id']}")}
rows = [json.loads(l) for l in open(sys.argv[1])]
with concurrent.futures.ThreadPoolExecutor(3) as ex: done = list(ex.map(both, rows))
with open(sys.argv[2], 'w') as fh:
    for d in done: fh.write(json.dumps(d) + '\n')
print('ranked', len(done), 'empty raw', sum(not d['raw'] for d in done), 'empty combo', sum(not d['combo'] for d in done))
