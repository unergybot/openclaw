# BestBox One-Person Team Orchestration — Design

**Date:** 2026-03-01
**Status:** Approved
**Approach:** Approach C — Scripts on BestBox + OpenClaw "Zoe" Agent

---

## Overview

Apply the "One Person Team" orchestration pattern to the BestBox project (`unergy@192.168.1.107`). OpenClaw runs on the Jetson as the orchestration layer. Coding agents (Claude Code, Opencode/MiniMax, Copilot/Codex, Gemini) run directly on BestBox inside isolated git worktrees and tmux sessions. You interact via Telegram; Zoe dispatches agents and notifies you when PRs are ready.

---

## System Diagram

```
[You on Telegram]
      |
      v
[OpenClaw on Jetson] <-- Zoe agent (claude-opus-4-6)
      |                   holds BestBox AGENTS.md context
      | SSH (bestbox alias, ~/.ssh/bestbox)
      v
[BestBox 192.168.1.107 — 124GB RAM, AMD ROCm]
  spawn-agent.sh  -> git worktree -> tmux -> claude/opencode/copilot/gemini
  check-agents.sh (cron */10 min) -> gh pr status -> notify Jetson gateway
  cleanup.sh      (cron 03:00)    -> prune merged worktrees
      |
      v
[GitHub PRs] <- agents push branches, create PRs via gh cli
```

---

## Target Machine

| Property  | Value                                                            |
| --------- | ---------------------------------------------------------------- |
| Host      | `unergy@192.168.1.107`                                           |
| SSH alias | `bestbox` (via `~/.ssh/config`)                                  |
| SSH key   | `~/.ssh/bestbox` (already installed)                             |
| RAM       | 124 GB (supports 15+ parallel agents)                            |
| Storage   | 937 GB NVMe                                                      |
| GPU       | AMD Radeon (ROCm — Strix Halo)                                   |
| OS        | Ubuntu, Linux 6.18 x86_64                                        |
| Project   | `~/BestBox` (Python/FastAPI + LangGraph agents + React frontend) |

---

## Agent Routing Rules

| Task type                | Time window     | Agent                      | Notes                                 |
| ------------------------ | --------------- | -------------------------- | ------------------------------------- |
| Complex / architectural  | 07:30–14:30     | `claude` (Claude Code Pro) | 5-hour rate limit window              |
| Complex / architectural  | Outside window  | `opencode` (MiniMax 2.5)   | Fallback, free                        |
| Bulk / parallel / simple | Anytime         | `opencode` (MiniMax 2.5)   | Free, unknown rate limit              |
| One big implementation   | After CC design | `copilot` (Codex 5.3)      | 300 premium req/month — use sparingly |
| Research / doc lookup    | Anytime         | `gemini`                   | Research only                         |

---

## Directory Structure

### On BestBox

```
~/.clawdbot/
  active-tasks.json        # live task registry
  logs/
    <task-id>.log          # per-agent tmux script output
    cron.log               # check-agents.sh cron output
    cleanup.log            # cleanup.sh cron output

~/BestBox/
  scripts/clawdbot/
    spawn-agent.sh         # create worktree + tmux + launch agent
    check-agents.sh        # cron monitor: tmux alive? PR? CI? notify
    cleanup.sh             # remove merged/stale worktrees
    route-agent.sh         # pick agent based on task type + time of day
  worktrees/               # sibling dir for isolated git worktrees
  AGENTS.md                # source of truth — Zoe reads this
  CLAUDE.md                # already exists
```

### On Jetson (OpenClaw)

```
~/.ssh/config              # bestbox alias entry
~/.openclaw/agents/zoe/    # Zoe agent config + memory
```

---

## SSH Config (Jetson)

Add to `~/.ssh/config`:

```
Host bestbox
  HostName 192.168.1.107
  User unergy
  IdentityFile ~/.ssh/bestbox
  StrictHostKeyChecking accept-new
```

---

## Task Registry Schema

### Running task

```json
{
  "id": "feat-crm-leads",
  "tmuxSession": "agent-feat-crm-leads",
  "agent": "claude",
  "description": "Fix CRM agent: live leads not loading from ERPNext",
  "worktree": "/home/unergy/BestBox/worktrees/feat-crm-leads",
  "branch": "feat/crm-leads",
  "startedAt": 1740268800000,
  "status": "running",
  "notifyOnComplete": true
}
```

### Completed task

```json
{
  "id": "feat-crm-leads",
  "status": "done",
  "pr": 44,
  "completedAt": 1740275400000,
  "checks": {
    "prCreated": true,
    "ciPassed": true
  }
}
```

---

## Scripts

### `spawn-agent.sh`

Creates a git worktree, activates the Python venv, launches the agent in a named tmux session, and registers the task.

**Signature:** `spawn-agent.sh <task-id> <branch> <agent> <prompt-file>`

**Agent values:** `claude` | `opencode` | `copilot` | `gemini`

**Definition of done communicated in every prompt:**

- PR created via `gh pr create --fill`
- Branch synced to main (no conflicts)
- Tests passing: `./scripts/run_integration_tests.sh --fast`
- PR description includes what changed and why

### `route-agent.sh`

Picks agent based on task type and current hour. Used by Zoe before calling `spawn-agent.sh`.

**Signature:** `route-agent.sh <task-type>`
**Task types:** `complex` | `bulk` | `implement` | `research`

### `check-agents.sh`

Runs every 10 minutes via cron. For each `running` task:

1. Checks if tmux session is alive
2. If dead: checks for open PRs on the branch via `gh pr list`
3. Updates task status (`done` or `failed`) and CI check results
4. Sends Telegram notification via OpenClaw gateway

### `cleanup.sh`

Runs daily at 03:00 via cron. Removes `done` worktrees via `git worktree remove --force` and prunes them from the registry.

---

## Cron (on BestBox, `crontab -e` as `unergy`)

```cron
*/10 * * * * bash ~/BestBox/scripts/clawdbot/check-agents.sh >> ~/.clawdbot/logs/cron.log 2>&1
0 3 * * * bash ~/BestBox/scripts/clawdbot/cleanup.sh >> ~/.clawdbot/logs/cleanup.log 2>&1
```

---

## OpenClaw Notification Path

Install `openclaw` as a thin client on BestBox, pointing at the Jetson gateway:

```bash
npm i -g openclaw
openclaw config set gateway.url http://<jetson-ip>:18789
```

`check-agents.sh` then calls:

```bash
openclaw message send --to michael "PR #44 ready: feat-crm-leads. CI passing."
```

---

## Zoe Agent (on Jetson)

**Model:** `claude-opus-4-6`
**Created with:** `openclaw agent add zoe --model claude-opus-4-6`

### System prompt summary

Zoe's memory includes:

- BestBox stack: Python/FastAPI, LangGraph agents, React/Next.js frontend
- Key agent files: `crm_agent.py`, `erp_agent.py`, `pcb_agent.py`, `mold_agent.py`, `it_ops_agent.py`
- GPU: AMD ROCm — use `rocm-smi`, not `nvidia-smi`
- SSH alias: `ssh bestbox`
- Env activation: `source ~/BestBox/activate.sh`
- Agent routing rules (time-aware)
- SSH dispatch pattern: write prompt file → call `spawn-agent.sh`
- Pre-task health check: running agent count + fetch latest main

### End-to-end flow

```
You (Telegram): "Zoe, fix the CRM agent — leads not loading from ERPNext"

Zoe:
  1. task-id: fix-crm-leads-20260301
  2. route: complex task, 09:15 → claude
  3. SSH: write /tmp/fix-crm-leads-20260301.prompt on BestBox
  4. SSH: spawn-agent.sh fix-crm-leads-20260301 fix/crm-leads claude /tmp/...prompt
  5. Reply: "Spawned Claude Code on BestBox (agent-fix-crm-leads-20260301). I'll ping you when the PR is ready."

[10 min later — check-agents.sh cron]

Zoe (Telegram): "PR #45 ready: fix-crm-leads. CI passing. Ready to merge."
```

---

## Out of Scope

- Multi-model code review (Codex + Gemini reviewers on every PR) — can be added later
- Automatic merge — always requires human review
- macOS-specific tooling — this is a Linux/x86 setup
