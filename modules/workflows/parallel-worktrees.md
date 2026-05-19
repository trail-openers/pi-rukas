# Parallel Worktrees

## When to Use Parallel Execution

You have up to 10 async tasks running simultaneously. Use this for parallelism when:
- Multiple independent implementation tasks exist for the same issue
- One task is blocked (waiting for review) and another can start
- Research and implementation can proceed simultaneously

## Worktrees as Scratch Space — NOT Separate PRs

When parallelising implementation, create git worktrees as **isolated scratch space**. Each developer works in their own worktree without interfering with others.

**Critical**: Worktrees are NOT independent feature branches destined for separate PRs. They are temporary parallel workspaces that feed into ONE branch and ONE PR.

**Why one PR:**
- One CI run instead of N
- No downstream merge conflicts between parallel tasks
- Cleaner review surface

## The Parallel Worktree Workflow

```
1. @ops creates worktrees:
   git worktree add .worktrees/task-A -b scratch/task-A
   git worktree add .worktrees/task-B -b scratch/task-B

2. Dispatch @developer tasks in parallel:
   @developer: "Work in .worktrees/task-A ..."
   @developer: "Work in .worktrees/task-B ..."

3. Both developers return with changed files listed (uncommitted)

4. @ops cherry-picks all changes into ONE feature branch:
   git checkout feature/issue-N
   git -C .worktrees/task-A add <files> && git -C .worktrees/task-A commit -m "..."
   git cherry-pick scratch/task-A
   git cherry-pick scratch/task-B

5. @ops removes worktrees:
   git worktree remove .worktrees/task-A
   git worktree remove .worktrees/task-B

6. ONE PR created from feature/issue-N → ONE CI run
```

## Worktree Safety Rules

**⛔ NEVER dispatch @ops to reset, clean, checkout, or modify files in a worktree that contains uncommitted developer work.**

Developer changes are intentionally uncommitted when they return. The correct state is:
- Developer returns → changes sitting uncommitted in worktree ✅
- @ops commits from that worktree ✅

The dangerous failure pattern:
- Developer returns → @ops task times out → PM dispatches @ops again with "check status" → second @ops sees conflict and resets → **work is lost** ❌

**When an @ops commit task times out:** Re-dispatch @ops with explicit instructions to commit the pending changes. Do NOT dispatch any cleanup, reset, or status-check tasks in parallel with a pending commit.

## Git -C Syntax for Worktrees

When dispatching @ops to operate on a worktree, always use `git -C` syntax:

```bash
oo git -C .worktrees/issue-N add src/path/to/file.rs
oo git -C .worktrees/issue-N commit -m "feat(#N): description"
oo git -C .worktrees/issue-N push origin feature/issue-N
```

Do NOT use `cd .worktrees/issue-N && git ...` — this is fragile and error-prone.
