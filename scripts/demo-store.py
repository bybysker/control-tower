#!/usr/bin/env python3
"""Build a fictional Claude home for screenshots and demos.

    python3 scripts/demo-store.py /tmp/alice
    control-tower --path /tmp/alice/.claude

Creates <home>/.claude/projects with six sessions across four made-up
projects (one running with a plan, one failed, one with an unanswered
question and a PR, one blocked on a tool, one stalled for days), and
<home>/code/<project> as real git repositories in telling states — an
unpushed feature branch, a clean branch off trunk, a branch with no upstream
— plus .env.example files so the "Your turn" panel has something to say.
Nothing in it is real. Safe to publish.
"""
import json, os, pathlib, subprocess, sys, time
from datetime import datetime, timedelta, timezone

home = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/alice').resolve()
code, root, remotes = home / 'code', home / '.claude', home / 'remotes'
for d in (code, root, remotes):
    subprocess.run(['rm', '-rf', str(d)]); d.mkdir(parents=True)

def sh(cwd, *cmd):
    subprocess.run(cmd, cwd=cwd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def repo(name, branch=None, ahead=0, dirty=False, upstream=True):
    d = code / name; d.mkdir()
    sh(d, 'git', 'init', '-q', '-b', 'main'); sh(d, 'git', 'config', 'user.email', 'alice@example.com'); sh(d, 'git', 'config', 'user.name', 'Alice')
    (d / 'README.md').write_text(f'# {name}\n'); sh(d, 'git', 'add', '.'); sh(d, 'git', 'commit', '-qm', 'init')
    bare = remotes / f'{name}.git'; sh(d, 'git', 'init', '-q', '--bare', str(bare)); sh(d, 'git', 'remote', 'add', 'origin', str(bare)); sh(d, 'git', 'push', '-q', '-u', 'origin', 'main')
    if branch:
        sh(d, 'git', 'checkout', '-qb', branch)
        (d / 'work.txt').write_text('x\n'); sh(d, 'git', 'add', '.'); sh(d, 'git', 'commit', '-qm', 'work')
        if upstream: sh(d, 'git', 'push', '-q', '-u', 'origin', branch)
    for i in range(ahead):
        (d / 'work.txt').write_text(f'x{i}\n'); sh(d, 'git', 'commit', '-qam', f'more {i}')
    if dirty:
        (d / 'README.md').write_text('# dirty\n'); (d / 'work.txt').write_text('changed\n') if (d / 'work.txt').exists() else None
    return d

now = datetime.now(timezone.utc)
iso = lambda dt: dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')
def env(ts, cwd): return {"isSidechain": False, "timestamp": iso(ts), "cwd": str(cwd), "gitBranch": "main", "version": "2.1.197", "entrypoint": "cli", "userType": "external"}
def user(ts, cwd, t): return {**env(ts, cwd), "type": "user", "uuid": f"u{ts.timestamp()}", "message": {"role": "user", "content": t}}
def asst(ts, cwd, t, stop="end_turn"): return {**env(ts, cwd), "type": "assistant", "uuid": f"a{ts.timestamp()}", "message": {"role": "assistant", "model": "claude-opus-5", "content": [{"type": "text", "text": t}], "stop_reason": stop}}
def tool(ts, cwd, tid, name, inp): return {**env(ts, cwd), "type": "assistant", "uuid": f"a{tid}", "message": {"role": "assistant", "model": "claude-opus-5", "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}], "stop_reason": "tool_use"}}
def res(ts, cwd, tid, c, err=None):
    b = {"type": "tool_result", "tool_use_id": tid, "content": c}
    if err is not None: b["is_error"] = err
    return {**env(ts, cwd), "type": "user", "uuid": f"r{tid}", "message": {"role": "user", "content": [b]}}
def title(sid, t): return {"type": "custom-title", "customTitle": t, "sessionId": sid}
def write(cwd, sid, recs, age):
    d = root / 'projects' / str(cwd).replace('/', '-').replace('.', '-'); d.mkdir(parents=True, exist_ok=True)
    f = d / f'{sid}.jsonl'; f.write_text('\n'.join(json.dumps(r) for r in recs) + '\n')
    t = time.time() - age; os.utime(f, (t, t))

shop = repo('shop-api', 'feature/oauth2', ahead=2, dirty=True)
(shop / '.env.example').write_text('STRIPE_SECRET_KEY=\nDATABASE_URL=\nLOG_LEVEL=info\nAPP_PORT=3000\n')
infra = repo('infra', 'migration/postgres')
(infra / '.env.example').write_text('GCP_CREDENTIALS_PATH=\nTF_VAR_project=\n'); (infra / '.env').write_text('GCP_CREDENTIALS_PATH=\nTF_VAR_project=staging\n')
dash = repo('dashboard')
pipe = repo('data-pipeline', 'spot-instances', upstream=False, dirty=True)

sid = 'a1b2c3d4-0000-4000-8000-000000000001'; t0 = now - timedelta(hours=2); cwd = shop
r = [user(t0, cwd, 'Move auth to OAuth2 and cover it with tests')]
for i, (s, a) in enumerate([('Audit the current auth flow', 'Auditing the current auth flow'), ('Extract the token store', 'Extracting the token store'), ('Wire the OAuth2 provider', 'Wiring the OAuth2 provider'), ('Write the integration tests', 'Writing the integration tests'), ('Remove the legacy middleware', 'Removing the legacy middleware')], 1):
    r += [tool(t0 + timedelta(seconds=i), cwd, f'tc{i}', 'TaskCreate', {"subject": s, "activeForm": a}), res(t0 + timedelta(seconds=i, milliseconds=500), cwd, f'tc{i}', f'Task #{i} created successfully: {s}')]
for i, st in [(1, 'completed'), (2, 'completed'), (3, 'in_progress')]:
    r += [tool(t0 + timedelta(minutes=i * 10), cwd, f'tu{i}', 'TaskUpdate', {"taskId": str(i), "status": st}), res(t0 + timedelta(minutes=i * 10, seconds=1), cwd, f'tu{i}', 'ok')]
r += [asst(now - timedelta(minutes=4), cwd, 'Token store extracted, 41 tests green. Wiring the OAuth2 provider next.'), user(now - timedelta(minutes=3), cwd, 'go ahead, keep refresh tokens out of localStorage'), tool(now - timedelta(seconds=5), cwd, 'tx1', 'Edit', {"file_path": f"{cwd}/src/auth/oauth.ts"}), title(sid, 'OAuth2 migration + tests')]
write(cwd, sid, r, 2)
sid = 'a1b2c3d4-0000-4000-8000-000000000002'; t0 = now - timedelta(minutes=25)
write(cwd, sid, [user(t0, cwd, 'run the test suite'), tool(t0 + timedelta(seconds=2), cwd, 'tf1', 'Bash', {"command": "npm test -- --runInBand"}), res(t0 + timedelta(seconds=30), cwd, 'tf1', 'FAIL tests/auth.spec.ts — expected 200, received 401. 3 failed, 41 passed.', err=True), title(sid, 'Test suite after the refactor')], 25 * 60)
sid = 'a1b2c3d4-0000-4000-8000-000000000003'; t0 = now - timedelta(minutes=40); cwd = infra
write(cwd, sid, [user(t0, cwd, 'migrate staging to Postgres and open a PR'),
    tool(t0 + timedelta(seconds=3), cwd, 'tc1', 'TaskCreate', {"subject": "Migrate the schema", "activeForm": "Migrating the schema"}), res(t0 + timedelta(seconds=4), cwd, 'tc1', 'Task #1 created successfully: Migrate the schema'),
    tool(t0 + timedelta(seconds=5), cwd, 'tc2', 'TaskCreate', {"subject": "Open the PR", "activeForm": "Opening the PR"}), res(t0 + timedelta(seconds=6), cwd, 'tc2', 'Task #2 created successfully: Open the PR'),
    tool(t0 + timedelta(minutes=1), cwd, 'tu1', 'TaskUpdate', {"taskId": "1", "status": "completed"}), res(t0 + timedelta(minutes=1, seconds=1), cwd, 'tu1', 'ok'),
    {"type": "pr-link", "sessionId": sid, "prNumber": 44, "prUrl": "https://github.com/alice/infra/pull/44", "prRepository": "alice/infra", "timestamp": iso(t0 + timedelta(minutes=20))},
    asst(now - timedelta(minutes=13), cwd, 'Schema migrated, tests green on SQLite and Postgres. The push is left: the Cloud Build trigger may deploy on push.'),
    user(now - timedelta(minutes=12), cwd, 'check the trigger first'),
    tool(now - timedelta(minutes=11), cwd, 'q1', 'AskUserQuestion', {"questions": [{"question": "The Cloud Build trigger has run once, on main only, and its branch filter is unverified. If it is `.*`, pushing migration/postgres deploys the Phase 0 backend to production. Push?", "header": "Push", "options": [{"label": "Push (trigger is main-only)"}, {"label": "Push anyway"}, {"label": "Do not push"}]}]}),
    title(sid, 'Postgres migration + PR')], 11 * 60)
mem = root / 'projects' / str(cwd).replace('/', '-') / 'memory'; mem.mkdir(exist_ok=True)
(mem / 'MEMORY.md').write_text("# Memory\n- [Cloud Build trigger](trigger.md) — one run on main, branch filter unverified\n- [gcloud broken](gcloud.md) — python 3.13 incompat, use the console\n")
sid = 'a1b2c3d4-0000-4000-8000-000000000004'; t0 = now - timedelta(minutes=6); cwd = dash
write(cwd, sid, [user(t0, cwd, 'shrink the dashboard bundle'), asst(t0 + timedelta(seconds=3), cwd, 'Checking what webpack emits as chunks.', stop='tool_use'), tool(t0 + timedelta(seconds=5), cwd, 'ti1', 'Bash', {"command": "npx webpack --analyze"}), title(sid, 'Dashboard bundle size')], 6 * 60)
sid = 'a1b2c3d4-0000-4000-8000-000000000005'; t0 = now - timedelta(hours=5)
write(cwd, sid, [user(t0, cwd, 'why does the header jump on scroll?'), tool(t0 + timedelta(seconds=2), cwd, 'td1', 'Read', {"file_path": f"{cwd}/src/Header.tsx"}), res(t0 + timedelta(seconds=3), cwd, 'td1', 'export function Header() { ... }', err=False), asst(t0 + timedelta(seconds=8), cwd, "It is `position: sticky` inside a parent with `overflow: hidden`: sticky is neutralised. Drop the overflow on the wrapper and the jump goes away."), title(sid, 'Header jumps on scroll')], 5 * 3600)
sid = 'a1b2c3d4-0000-4000-8000-000000000006'; t0 = now - timedelta(days=3); cwd = pipe
write(cwd, sid, [user(t0, cwd, 'move the staging cluster to spot instances'), tool(t0 + timedelta(seconds=4), cwd, 'ts1', 'Bash', {"command": "terraform plan -out=staging.tfplan"}), title(sid, 'Staging cluster on spot instances')], 3 * 86400)
print(f'{root}: 6 sessions, 4 projects — run: control-tower --path {root}')
