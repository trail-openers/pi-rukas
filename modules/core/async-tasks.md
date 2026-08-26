# Async Task Behavior

## ⛔ CRITICAL: NEVER POLL

**Results auto-deliver.** When a task completes, the result arrives in your context automatically as an `[ensemble:async]` report. You do NOT call dispatch_status to get results.

### The Anti-Pattern (NEVER DO THIS)
```
dispatch task A, B, C, D, E
dispatch_status  ← WRONG
dispatch_status  ← WRONG
dispatch_status  ← WRONG
... repeat ...   ← VERY WRONG
```

### The Correct Pattern
```
dispatch task A, B, C, D, E
end your turn (or proceed with other parallel work)
[the [ensemble:async] report arrives when ready and resumes you]
summarize results for user
```

The correct pattern is **dispatch → end turn → resume on `[ensemble:async]`**. Ending your turn with jobs in flight loses nothing: the report resumes you automatically.

## dispatch_status: Almost Never

- **Do NOT call dispatch_status in loops** — ever, for any reason
- **Do NOT call dispatch_status "just to see"** — results auto-deliver
- **Do NOT call dispatch_status after dispatching** — just end your turn
- **The only valid use:** a single check before dispatch_kill, to confirm the job is still running (at most once, never in a loop)

## Task Lifecycle Management

When new information makes a running task obsolete:
1. `dispatch_status` once to confirm the job is still running
2. `dispatch_kill` the stale job by jobId (reports whether the job was found and signalled)
3. Re-launch with updated context in the new task prompt

Do not leave stale tasks running. Cancel and replace promptly.

## Relay Responsibility

Task results are NOT visible to the user. When a task completes:
1. **Summarize** the result for the user in your own words
2. **Act** on findings — continue with next steps or ask for decisions
3. **Surface key details** the user needs to know

Never assume the user saw the agent's output.

## Task Prompt Quality

When dispatching tasks, your prompt must:
- Contain a **highly detailed task description** with full context
- Specify **exactly what information to return**
- Include relevant file paths, issue numbers, and constraints
- State the expected output format

## session_id for Continuity

Tasks are stateless by default. Pass `session_id` when an agent needs to continue prior work within the same session context.

## Git Worktrees for Parallel Branches

**Setup (if needed):**
```bash
mkdir -p .worktrees && echo ".worktrees/" >> .gitignore
```

**Create worktrees:**
```
Issue #263 → .worktrees/issue-263
Issue #264 → .worktrees/issue-264
```

**Benefits of .worktrees/ pattern:**
- No permission dialogs (stays within project)
- Clean separation
- Independent branch management
- Easy cleanup

**Never commit worktrees:**
.worktrees/ is in .gitignore by design. Worktrees are temporary working directories.

### Collision Prevention with Worktrees

**Before parallel dispatch:**
```bash
# Check for potential conflicts
vipune search "who is working on" --limit 10  # Check project memory
oo git branch -a                               # Check active branches
oo git worktree list                           # Check existing worktrees
```

**Red Flags (use worktrees if any apply):**
- [ ] Multiple agents on same branch
- [ ] Same files being modified
- [ ] Uncommitted changes present
- [ ] Previous task incomplete

**Worktree Pattern for Collision Avoidance:**
```
Issue #263 (API) → .worktrees/issue-263
Issue #264 (UI)  → .worktrees/issue-264
Both merge independently → no collision risk
```
