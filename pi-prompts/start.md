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
   colgrep init .
   ```
   **Note**: Do not run `colgrep` for project-meta queries — `colgrep init` is the only colgrep call PM makes in /start.

3. **Context sweep** — dispatch explore specialist (runs in parallel with step 4):
   - Use the `dispatch_specialist` tool with `role: explore` and prompt:
     "Run the /start intelligence sweep following your Structured Summary Contract. Return EXACTLY the eight-field structured summary: project, maturity, current_state, conventions, quality_gates, gotchas, open_work, ci_health. No raw output."

4. **Current state of work** — dispatch ops specialist for all git/PR/CI signals at once:
   - Use the `dispatch_specialist` tool with `role: ops` and prompt:
     "Run `git log --oneline -10`, `gh issue list --limit 15`, `gh pr list`, `gh run list --branch main --limit 3`, `git shortlog -sn --no-merges`, and `git for-each-ref --sort=-committerdate refs/heads --format='%(HEAD) %(refname:short) %(committerdate:relative)'`. Return raw output."

5. **Wait for both dispatches** (explore from step 3 + ops from step 4) to return, then synthesise into the one readiness line. On timeout (120 seconds) or incomplete explore response, apply the Reconnaissance Doctrine timeout and resilience fallback.

6. **Store findings**:
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
