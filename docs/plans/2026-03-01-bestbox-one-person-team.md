# BestBox One-Person Team Orchestration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire up the "One Person Team" agent swarm on BestBox (192.168.1.107) with OpenClaw's Zoe agent on the Jetson as orchestrator, reachable via Telegram.

**Architecture:** Scripts on BestBox manage git worktrees + tmux sessions for each coding agent. A cron job monitors agents and notifies via OpenClaw/Telegram when PRs are ready. Zoe (OpenClaw agent on Jetson) holds BestBox context and dispatches tasks via SSH.

**Tech Stack:** Bash, Python 3, tmux, git worktrees, gh CLI, npm (Claude Code, Opencode, Gemini CLI, OpenClaw), OpenClaw agent system.

---

## Environment Reference

| Thing             | Value                                                       |
| ----------------- | ----------------------------------------------------------- |
| BestBox SSH       | `ssh -i ~/.ssh/bestbox unergy@192.168.1.107`                |
| BestBox project   | `~/BestBox`                                                 |
| BestBox worktrees | `~/BestBox/worktrees/`                                      |
| BestBox scripts   | `~/BestBox/scripts/clawdbot/`                               |
| Task registry     | `~/.clawdbot/active-tasks.json`                             |
| Cron logs         | `~/.clawdbot/logs/`                                         |
| BestBox test cmd  | `cd ~/BestBox && ./scripts/run_integration_tests.sh --fast` |
| BestBox activate  | `source ~/BestBox/activate.sh`                              |
| Jetson SSH key    | `~/.ssh/bestbox`                                            |

All `ssh` commands in this plan run **from the Jetson** unless noted.

---

## Task 1: SSH Config on Jetson

**Files:**

- Create: `~/.ssh/config`

**Step 1: Write the SSH config**

```bash
cat >> ~/.ssh/config << 'EOF'

Host bestbox
  HostName 192.168.1.107
  User unergy
  IdentityFile ~/.ssh/bestbox
  StrictHostKeyChecking accept-new
EOF
chmod 600 ~/.ssh/config
```

**Step 2: Verify the alias works**

```bash
ssh bestbox "echo 'SSH alias working'"
```

Expected: `SSH alias working`

---

## Task 2: Install Agent CLIs on BestBox

**Files:** None (global npm installs)

All steps run as a single SSH session on BestBox.

**Step 1: Install Claude Code**

```bash
ssh bestbox "sudo npm install -g @anthropic-ai/claude-code"
```

Verify:

```bash
ssh bestbox "claude --version"
```

**Step 2: Install Opencode**

```bash
ssh bestbox "sudo npm install -g opencode-ai"
```

Verify:

```bash
ssh bestbox "opencode --version"
```

> If `opencode-ai` fails, check https://opencode.ai for the correct npm package name.

**Step 3: Install Gemini CLI**

```bash
ssh bestbox "sudo npm install -g @google/gemini-cli"
```

Verify:

```bash
ssh bestbox "gemini --version"
```

> If package name is wrong, check https://github.com/google-gemini/gemini-cli for the correct package.

**Step 4: Install OpenClaw thin client**

```bash
ssh bestbox "sudo npm install -g openclaw"
```

Verify:

```bash
ssh bestbox "openclaw --version"
```

**Step 5: Verify gh CLI is authenticated on BestBox**

```bash
ssh bestbox "gh auth status"
```

Expected: shows an authenticated account. If not: `ssh bestbox "gh auth login"` and follow prompts.

---

## Task 3: Directory Structure on BestBox

**Files:**

- Create: `~/.clawdbot/active-tasks.json` (on BestBox)
- Create: `~/.clawdbot/logs/` (on BestBox)
- Create: `~/BestBox/scripts/clawdbot/` (on BestBox)
- Create: `~/BestBox/worktrees/` (on BestBox)

**Step 1: Create directories and empty registry**

```bash
ssh bestbox "
  mkdir -p ~/.clawdbot/logs
  mkdir -p ~/BestBox/scripts/clawdbot
  mkdir -p ~/BestBox/worktrees
  echo '[]' > ~/.clawdbot/active-tasks.json
  echo 'Directory structure created'
  ls ~/.clawdbot/
  ls ~/BestBox/scripts/clawdbot/
"
```

Expected output:

```
Directory structure created
active-tasks.json  logs
(empty clawdbot dir)
```

---

## Task 4: Write `route-agent.sh`

**Files:**

- Create: `~/BestBox/scripts/clawdbot/route-agent.sh` (on BestBox)

**Step 1: Write the script**

```bash
ssh bestbox "cat > ~/BestBox/scripts/clawdbot/route-agent.sh << 'SCRIPT'
#!/usr/bin/env bash
# Usage: route-agent.sh <task-type>
# task-type: complex | bulk | implement | research
# Prints the agent name to use: claude | opencode | copilot | gemini
set -euo pipefail

TASK_TYPE=\${1:-bulk}
HOUR=\$(date +%H)

case \"\$TASK_TYPE\" in
  complex)
    # Claude Code 07:30-14:30 (rate limit window); fall back to opencode
    if [ \"\$HOUR\" -ge 7 ] && [ \"\$HOUR\" -lt 14 ]; then
      echo \"claude\"
    else
      echo \"opencode\"
    fi ;;
  implement)
    # Codex 5.3 for one focused implementation task
    echo \"copilot\" ;;
  bulk)
    echo \"opencode\" ;;
  research)
    echo \"gemini\" ;;
  *)
    echo \"opencode\" ;;
esac
SCRIPT
chmod +x ~/BestBox/scripts/clawdbot/route-agent.sh
"
```

**Step 2: Test routing logic**

```bash
ssh bestbox "
  bash ~/BestBox/scripts/clawdbot/route-agent.sh bulk
  bash ~/BestBox/scripts/clawdbot/route-agent.sh implement
  bash ~/BestBox/scripts/clawdbot/route-agent.sh research
"
```

Expected:

```
opencode
copilot
gemini
```

For `complex`, output depends on current hour (claude inside 07:30–14:30, opencode outside).

---

## Task 5: Write `spawn-agent.sh`

**Files:**

- Create: `~/BestBox/scripts/clawdbot/spawn-agent.sh` (on BestBox)

**Step 1: Write the script**

```bash
ssh bestbox "cat > ~/BestBox/scripts/clawdbot/spawn-agent.sh << 'SCRIPT'
#!/usr/bin/env bash
# Usage: spawn-agent.sh <task-id> <branch> <agent> <prompt-file>
# agent: claude | opencode | copilot | gemini
set -euo pipefail

TASK_ID=\$1
BRANCH=\$2
AGENT=\$3
PROMPT_FILE=\$4
WORKTREE_PATH=\$HOME/BestBox/worktrees/\$TASK_ID
REGISTRY=\$HOME/.clawdbot/active-tasks.json
LOG=\$HOME/.clawdbot/logs/\$TASK_ID.log

echo \"[spawn] task=\$TASK_ID agent=\$AGENT branch=\$BRANCH\"

# Ensure worktrees dir exists
mkdir -p \$HOME/BestBox/worktrees

# Fetch latest and create worktree
git -C \$HOME/BestBox fetch origin --prune
git -C \$HOME/BestBox worktree add \"\$WORKTREE_PATH\" -b \"\$BRANCH\" origin/main

# Set up Python venv in worktree
python3 -m venv \"\$WORKTREE_PATH/venv\"
source \"\$WORKTREE_PATH/venv/bin/activate\"
pip install -r \"\$WORKTREE_PATH/requirements.txt\" -q

# Build agent command
case \"\$AGENT\" in
  claude)
    AGENT_CMD=\"claude --model claude-opus-4-6 --dangerously-skip-permissions < \$PROMPT_FILE\"
    ;;
  opencode)
    AGENT_CMD=\"opencode run --model minimax/minimax-text-01 < \$PROMPT_FILE\"
    ;;
  copilot)
    AGENT_CMD=\"gh copilot suggest -t shell \\\"\$(cat \$PROMPT_FILE)\\\"\"
    ;;
  gemini)
    AGENT_CMD=\"gemini < \$PROMPT_FILE\"
    ;;
  *)
    echo \"[spawn] Unknown agent: \$AGENT\" >&2; exit 1 ;;
esac

# Spawn in tmux session with logging
SESSION=\"agent-\$TASK_ID\"
tmux new-session -d -s \"\$SESSION\" -c \"\$WORKTREE_PATH\" \
  \"script -q -c 'source venv/bin/activate && \$AGENT_CMD' \$LOG; tmux kill-session -t \$SESSION\"

echo \"[spawn] tmux session \$SESSION started\"

# Register task in JSON registry
python3 - << PYEOF
import json, os, time
reg = os.path.expanduser('~/.clawdbot/active-tasks.json')
data = json.load(open(reg)) if os.path.exists(reg) else []
data.append({
    'id': '\$TASK_ID',
    'tmuxSession': '\$SESSION',
    'agent': '\$AGENT',
    'worktree': '\$WORKTREE_PATH',
    'branch': '\$BRANCH',
    'startedAt': int(time.time() * 1000),
    'status': 'running',
    'notifyOnComplete': True
})
json.dump(data, open(reg, 'w'), indent=2)
print('[spawn] registered in task registry')
PYEOF
SCRIPT
chmod +x ~/BestBox/scripts/clawdbot/spawn-agent.sh
"
```

**Step 2: Verify script is valid bash**

```bash
ssh bestbox "bash -n ~/BestBox/scripts/clawdbot/spawn-agent.sh && echo 'syntax OK'"
```

Expected: `syntax OK`

**Step 3: Commit to BestBox git**

```bash
ssh bestbox "cd ~/BestBox && git add scripts/clawdbot/spawn-agent.sh && git commit -m 'feat(clawdbot): add spawn-agent.sh'"
```

---

## Task 6: Write `check-agents.sh`

**Files:**

- Create: `~/BestBox/scripts/clawdbot/check-agents.sh` (on BestBox)

**Step 1: Write the script**

```bash
ssh bestbox "cat > ~/BestBox/scripts/clawdbot/check-agents.sh << 'SCRIPT'
#!/usr/bin/env bash
# Cron: */10 * * * * bash ~/BestBox/scripts/clawdbot/check-agents.sh
set -euo pipefail

REGISTRY=\$HOME/.clawdbot/active-tasks.json
[ ! -f \"\$REGISTRY\" ] && exit 0

# Load openclaw gateway URL (set by: openclaw config set gateway.url ...)
GATEWAY_URL=\$(openclaw config get gateway.url 2>/dev/null || echo '')

python3 - << 'PYEOF'
import json, subprocess, os, sys, time

reg_path = os.path.expanduser('~/.clawdbot/active-tasks.json')
tasks = json.load(open(reg_path))
updated = False

def notify(msg):
    gw = os.environ.get('OPENCLAW_GATEWAY_URL', '')
    try:
        subprocess.run(['openclaw', 'message', 'send', '--to', 'michael', msg],
                       capture_output=True, timeout=10)
    except Exception as e:
        print(f'[check] notify failed: {e}', file=sys.stderr)

for t in tasks:
    if t.get('status') != 'running':
        continue

    session = t['tmuxSession']

    # Is the tmux session still alive?
    alive = subprocess.run(['tmux', 'has-session', '-t', session],
                           capture_output=True).returncode == 0
    if alive:
        print(f'[check] {t["id"]} still running in {session}')
        continue

    # Session is dead — check for PR on the branch
    print(f'[check] {t["id"]} session ended, checking for PR on {t["branch"]}')
    pr_result = subprocess.run(
        ['gh', 'pr', 'list', '--head', t['branch'],
         '--json', 'number,statusCheckRollup', '--limit', '1'],
        capture_output=True, text=True, cwd=os.path.expanduser('~/BestBox')
    )
    prs = json.loads(pr_result.stdout or '[]')

    if prs:
        pr = prs[0]
        ci_checks = pr.get('statusCheckRollup') or []
        ci_passed = all(c.get('conclusion') == 'SUCCESS' for c in ci_checks) if ci_checks else None
        t['status'] = 'done'
        t['pr'] = pr['number']
        t['completedAt'] = int(time.time() * 1000)
        t['checks'] = {
            'prCreated': True,
            'ciPassed': ci_passed,
        }
        ci_note = 'CI passing' if ci_passed else ('CI pending' if ci_passed is None else 'CI FAILED')
        msg = f'PR #{pr["number"]} ready: {t["id"]}. {ci_note}. Ready to review.'
        print(f'[check] {msg}')
        notify(msg)
    else:
        t['status'] = 'failed'
        t['completedAt'] = int(time.time() * 1000)
        msg = f'Agent failed (no PR): {t["id"]}. Check log: ~/.clawdbot/logs/{t["id"]}.log'
        print(f'[check] {msg}')
        notify(msg)

    updated = True

json.dump(tasks, open(reg_path, 'w'), indent=2)
PYEOF
SCRIPT
chmod +x ~/BestBox/scripts/clawdbot/check-agents.sh
"
```

**Step 2: Verify bash syntax**

```bash
ssh bestbox "bash -n ~/BestBox/scripts/clawdbot/check-agents.sh && echo 'syntax OK'"
```

**Step 3: Test against empty registry (no-op)**

```bash
ssh bestbox "bash ~/BestBox/scripts/clawdbot/check-agents.sh"
```

Expected: exits silently (empty registry, nothing running).

**Step 4: Commit**

```bash
ssh bestbox "cd ~/BestBox && git add scripts/clawdbot/check-agents.sh && git commit -m 'feat(clawdbot): add check-agents.sh'"
```

---

## Task 7: Write `cleanup.sh`

**Files:**

- Create: `~/BestBox/scripts/clawdbot/cleanup.sh` (on BestBox)

**Step 1: Write the script**

```bash
ssh bestbox "cat > ~/BestBox/scripts/clawdbot/cleanup.sh << 'SCRIPT'
#!/usr/bin/env bash
# Cron: 0 3 * * * bash ~/BestBox/scripts/clawdbot/cleanup.sh
set -euo pipefail

python3 - << 'PYEOF'
import json, subprocess, os

reg_path = os.path.expanduser('~/.clawdbot/active-tasks.json')
if not os.path.exists(reg_path):
    print('[cleanup] no registry, nothing to do')
    exit()

tasks = json.load(open(reg_path))
active = []

for t in tasks:
    if t.get('status') == 'done':
        wt = t.get('worktree', '')
        if wt and os.path.exists(wt):
            result = subprocess.run(
                ['git', '-C', os.path.expanduser('~/BestBox'),
                 'worktree', 'remove', '--force', wt],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                print(f'[cleanup] removed worktree: {wt}')
            else:
                print(f'[cleanup] worktree remove failed: {result.stderr.strip()}')
        else:
            print(f'[cleanup] worktree already gone: {wt}')
    else:
        active.append(t)

json.dump(active, open(reg_path, 'w'), indent=2)
print(f'[cleanup] done. {len(active)} tasks remain active.')
PYEOF
SCRIPT
chmod +x ~/BestBox/scripts/clawdbot/cleanup.sh
"
```

**Step 2: Verify syntax and dry run**

```bash
ssh bestbox "bash -n ~/BestBox/scripts/clawdbot/cleanup.sh && echo 'syntax OK'"
ssh bestbox "bash ~/BestBox/scripts/clawdbot/cleanup.sh"
```

Expected: `[cleanup] no registry, nothing to do` or `[cleanup] done. 0 tasks remain active.`

**Step 3: Commit**

```bash
ssh bestbox "cd ~/BestBox && git add scripts/clawdbot/cleanup.sh && git commit -m 'feat(clawdbot): add cleanup.sh'"
```

---

## Task 8: Install Cron on BestBox

**Step 1: Add cron entries**

```bash
ssh bestbox "
(crontab -l 2>/dev/null; echo '# clawdbot agent monitor') | crontab -
(crontab -l 2>/dev/null; echo '*/10 * * * * bash ~/BestBox/scripts/clawdbot/check-agents.sh >> ~/.clawdbot/logs/cron.log 2>&1') | crontab -
(crontab -l 2>/dev/null; echo '0 3 * * * bash ~/BestBox/scripts/clawdbot/cleanup.sh >> ~/.clawdbot/logs/cleanup.log 2>&1') | crontab -
"
```

**Step 2: Verify cron entries installed**

```bash
ssh bestbox "crontab -l"
```

Expected output includes both clawdbot entries.

**Step 3: Verify cron daemon is running**

```bash
ssh bestbox "systemctl is-active cron || systemctl is-active crond"
```

Expected: `active`

---

## Task 9: Configure OpenClaw Thin Client on BestBox

**Step 1: Find the Jetson's LAN IP**

```bash
# Run on Jetson
ip -4 addr show | grep inet | grep -v 127 | awk '{print $2}'
```

Note the IP (e.g., `192.168.1.XXX`).

**Step 2: Verify OpenClaw gateway is listening on Jetson**

```bash
ss -ltnp | grep 18789
```

Expected: a listening socket on port 18789.

If not running, start it:

```bash
pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &
```

Note: if gateway is `--bind loopback`, it won't be reachable from BestBox. You may need `--bind 0.0.0.0` or the LAN interface. Check the running config:

```bash
cat /tmp/openclaw-gateway.log | head -20
```

**Step 3: Configure openclaw on BestBox to point at Jetson**

```bash
ssh bestbox "openclaw config set gateway.url http://<JETSON_LAN_IP>:18789"
```

Replace `<JETSON_LAN_IP>` with the IP found in Step 1.

**Step 4: Test notification round-trip**

```bash
ssh bestbox "openclaw message send --to michael 'BestBox notification test'"
```

Check Telegram — you should receive the message.

---

## Task 10: Create Zoe Agent on Jetson

**Step 1: Create the agent**

```bash
openclaw agent add zoe --model claude-opus-4-6
```

**Step 2: Write Zoe's system prompt file**

```bash
cat > /tmp/zoe-prompt.md << 'EOF'
You are Zoe, orchestrator for the BestBox project on unergy@192.168.1.107.

## Your job
1. Receive task requests via Telegram from Michael
2. Classify the task type: complex | bulk | implement | research
3. Write a focused, detailed prompt for the coding agent including full BestBox context
4. SSH to BestBox and dispatch the agent via spawn-agent.sh
5. Report status and ping Michael when PRs are ready

## BestBox context
- Stack: Python/FastAPI backend, LangGraph agents (LangGraph), React/Next.js frontend
- GPU: AMD ROCm (Strix Halo) — use `rocm-smi` not `nvidia-smi`. CUDA check returns False on ROCm — this is normal.
- Key agent files: agents/crm_agent.py, agents/erp_agent.py, agents/pcb_agent.py, agents/mold_agent.py, agents/it_ops_agent.py
- Activate env: source ~/BestBox/activate.sh
- Run tests: cd ~/BestBox && ./scripts/run_integration_tests.sh --fast
- SSH alias: ssh bestbox (resolves to unergy@192.168.1.107 via ~/.ssh/config on the Jetson)

## Agent routing (use route-agent.sh or apply these rules yourself)
- complex task + 07:30–14:30 → claude (Claude Code Pro, 5-hour rate limit window)
- complex task + outside window → opencode (MiniMax 2.5, free)
- bulk/parallel/simple task → opencode (free, use liberally)
- one big implementation (after CC designs it) → copilot (Codex 5.3, sparingly — 300 req/month)
- research/docs → gemini

## Dispatch pattern
Step 1 — Write prompt file on BestBox:
```

ssh bestbox "cat > /tmp/<task-id>.prompt << 'PROMPT'
<detailed prompt with full context, definition of done>
PROMPT"

```

Step 2 — Spawn agent:
```

ssh bestbox "bash ~/BestBox/scripts/clawdbot/spawn-agent.sh <task-id> <branch> <agent> /tmp/<task-id>.prompt"

```

## Pre-task health check
Always run before dispatching:
```

ssh bestbox "git -C ~/BestBox fetch origin --prune && python3 -c \"import json,os; t=json.load(open(os.path.expanduser('~/.clawdbot/active-tasks.json'))); print(f'{sum(1 for x in t if x[\\\"status\\\"]==\\\"running\\\")} agents running')\""

```
Report back to Michael how many agents are currently running.

## Definition of done (include in every agent prompt)
- PR created: gh pr create --fill
- Branch synced to main (no conflicts)
- Tests passing: ./scripts/run_integration_tests.sh --fast
- PR description explains what changed and why

## Task ID convention
<short-slug>-YYYYMMDD, e.g. fix-crm-leads-20260301
Branch: feat/<short-slug> or fix/<short-slug>
EOF
```

**Step 3: Set Zoe's system prompt via openclaw config**

```bash
openclaw agent config zoe --system-prompt "$(cat /tmp/zoe-prompt.md)"
```

> If the above command format is wrong for your OpenClaw version, check: `openclaw agent --help`

**Step 4: Verify Zoe is listed**

```bash
openclaw agent list
```

Expected: `zoe` appears in the list.

---

## Task 11: End-to-End Smoke Test

**Step 1: Check BestBox is reachable via alias**

```bash
ssh bestbox "echo OK"
```

**Step 2: Manually trigger a dry-run spawn (no real agent — use `echo` as a stand-in)**

```bash
ssh bestbox "
  echo 'Test prompt: create a hello.txt file' > /tmp/test-dry-run.prompt
  cat > /tmp/dry-spawn.sh << 'SH'
#!/usr/bin/env bash
TASK_ID=test-dry-run
BRANCH=test/dry-run
WORKTREE_PATH=\$HOME/BestBox/worktrees/\$TASK_ID
REGISTRY=\$HOME/.clawdbot/active-tasks.json

git -C ~/BestBox fetch origin --prune
git -C ~/BestBox worktree add \"\$WORKTREE_PATH\" -b \"\$BRANCH\" origin/main 2>/dev/null || echo 'worktree already exists'
SESSION=agent-\$TASK_ID

# Use 'sleep 2' instead of real agent for dry run
tmux new-session -d -s \"\$SESSION\" -c \"\$WORKTREE_PATH\" 'sleep 2 && echo done'

python3 - << PYEOF
import json, os, time
reg = os.path.expanduser('~/.clawdbot/active-tasks.json')
data = json.load(open(reg)) if os.path.exists(reg) else []
data = [x for x in data if x['id'] != 'test-dry-run']
data.append({'id':'test-dry-run','tmuxSession':'agent-test-dry-run','agent':'echo',
  'worktree':'\$WORKTREE_PATH','branch':'test/dry-run',
  'startedAt':int(time.time()*1000),'status':'running','notifyOnComplete':False})
json.dump(data, open(reg,'w'), indent=2)
print('registered')
PYEOF
SH
  bash /tmp/dry-spawn.sh
"
```

**Step 3: Verify task appears in registry**

```bash
ssh bestbox "cat ~/.clawdbot/active-tasks.json | python3 -m json.tool"
```

Expected: `test-dry-run` entry with `status: running`.

**Step 4: Wait for session to end, then run check-agents.sh**

```bash
sleep 5
ssh bestbox "bash ~/BestBox/scripts/clawdbot/check-agents.sh"
```

Expected: `[check] test-dry-run session ended, checking for PR...` then `[check] Agent failed (no PR): test-dry-run` (no real PR exists — this is correct).

**Step 5: Clean up dry-run worktree and registry**

```bash
ssh bestbox "
  git -C ~/BestBox worktree remove --force ~/BestBox/worktrees/test-dry-run 2>/dev/null || true
  git -C ~/BestBox branch -D test/dry-run 2>/dev/null || true
  python3 -c \"import json,os; reg=os.path.expanduser('~/.clawdbot/active-tasks.json'); d=json.load(open(reg)); json.dump([x for x in d if x['id']!='test-dry-run'],open(reg,'w'),indent=2); print('cleaned')\"
"
```

**Step 6: Send a Zoe test message via Telegram**

Message Zoe on Telegram:

```
Zoe, how many agents are running on BestBox right now?
```

Expected response: Zoe SSHes to BestBox, reads the registry, replies with `0 agents running`.

---

## Done

The system is fully operational when:

- `ssh bestbox "echo OK"` works from Jetson
- All 4 scripts exist and pass bash syntax check
- Cron is installed (`crontab -l` shows both entries)
- `openclaw message send --to michael "test"` from BestBox reaches you on Telegram
- Zoe agent is listed in `openclaw agent list` and responds to Telegram messages with live BestBox data
