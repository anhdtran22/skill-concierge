import json, subprocess, sys, concurrent.futures
rules = open('rules.txt').read()
rows = [json.loads(l) for l in open(sys.argv[1])]
def one(r):
    p = subprocess.run(['claude','-p','--model',sys.argv[3] if len(sys.argv)>3 else 'haiku','--setting-sources','','--settings','{"disableAllHooks":true}','--system-prompt',rules],
                       input='Draft:\n'+r['prompt'], capture_output=True, text=True, timeout=60)
    return {'id': r['id'], 'project': r['project'], 'prompt': r['prompt'], 'intent': p.stdout.strip().splitlines()[-1] if p.stdout.strip() else ''}
with concurrent.futures.ThreadPoolExecutor(5) as ex: out = list(ex.map(one, rows))
with open(sys.argv[2],'w') as fh:
    for o in out: fh.write(json.dumps(o)+'\n')
print('intents', sum(bool(o['intent']) for o in out), 'of', len(out))
