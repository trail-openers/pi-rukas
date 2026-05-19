---
description: Initialise session — load project memory, check git state, report what's open
argument-hint: ""
---

# Session Initialisation

**Mission**: Build YOUR internal context so you can help the user effectively. You are preparing yourself, not reporting to the user.

**Constraint**: READ-ONLY. No commits, no issues, no branches, no pushes.

---

## Steps

1. **Branch check**
   ```bash
   git status
   git branch --show-current
   git worktree list
   ```
   If uncommitted changes exist: decide if they belong to current task. Stash or worktree-park if not.

2. **Index the codebase**
   ```bash
   colgrep init $(pwd)
   ```

3. **Search project memory** for prior context. Run a handful of focused `vipune search "<keyword>" --limit 5` calls on the categories you'd want to know about for a productive session — architecture, conventions, quality gates, recent decisions, open work, gotchas, anything else worth probing. Use your judgment for what's worth searching given what little you know about the project so far. If a category returns nothing useful, move on.

4. **Current state of work** — dispatch ops specialist for all git/PR/CI signals at once:
   - Use the `dispatch_specialist` tool with `role: ops` and prompt:
     "Run `git log --oneline -10`, `gh issue list --limit 15`, `gh pr list`, `gh run list --branch main --limit 3`, `git shortlog -sn --no-merges`, and `git for-each-ref --sort=-committerdate refs/heads --format='%(HEAD) %(refname:short) %(committerdate:relative)'`. Return raw output."

5. **Git telemetry** (run directly, read-only):
   ```bash
   git remote get-url origin
   git rev-list --all --count
   git log --graph --oneline --all --decorate -20
   git branch -vv
   git log --format=format: --name-only --since="6 months ago" | sort | uniq -c | sort -nr | head -20
   ```

6. **Read project conventions**: README.md, AGENTS.md, CONTRIBUTING.md if present.

7. **Store findings**:
   ```bash
   vipune add 'project identity, current state, conventions, gotchas'
   ```

## Output

One readiness line:
- Project (with maturity + team size from telemetry)
- Current status (active work, CI health, hotspots)
- "Ready for instructions."

This is NOT a report — you are confirming readiness.

---

## Principles

- Build on existing knowledge, don't repeat what's in memory.
- Discover, don't assume.
- Focus on what enables productivity.
