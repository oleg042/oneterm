import subprocess, re, time, os, hashlib
OUT = os.path.expanduser('~/Projects/oneterm/test/fixtures')
def sh(*a): return subprocess.run(a, capture_output=True, text=True).stdout
seen, end = {}, time.time() + 480
while time.time() < end:
    for n in [x for x in sh('tmux','ls','-F','#{session_name}').split() if x.startswith('oneterm_')]:
        pane = sh('tmux','capture-pane','-p','-t',n).rstrip('\n')
        L = pane.split('\n')
        while L and not L[-1].strip(): L.pop()
        if not L: continue
        # Only Claude Code panes are fixtures for THIS test. chaos.sh spins up
        # plain shells while this runs and one got captured, which then failed
        # the suite as an unexplained layout.
        if not any(('auto mode on' in l) or ('bypass permissions' in l) for l in L[-6:]):
            continue
        N = len(L)
        def up(pred):
            for i in range(N-1,-1,-1):
                if pred(L[i]): return N-i
            return None
        status  = up(lambda l: 'auto mode on' in l or 'bypass permissions' in l)
        spinner = up(lambda l: re.match(r'^\s*\S{1,2}\s+[A-Za-z][\w-]*…', l))
        shells  = up(lambda l: re.search(r'·\s*[1-9]\d*\s+shells?\s*(?=·|$)', l))
        prompt  = up(lambda l: re.search(r'❯\s*\d+\.\s', l))
        sig = (status, spinner is not None, shells, prompt is not None)
        if sig in seen: continue
        seen[sig] = 1
        tag = f"status{status}_spin{spinner or 0}_shells{shells or 0}_prompt{1 if prompt else 0}"
        h = hashlib.md5('\n'.join(L).encode()).hexdigest()[:6]
        open(f"{OUT}/{tag}_{h}.pane",'w').write('\n'.join(L))
        print(f"NEW {tag}", flush=True)
    time.sleep(3)
print(f"--- collected {len(seen)} distinct layouts ---")
