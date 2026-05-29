---
description: Initialise session — load project memory, check git state, report what's open
argument-hint: ""
---

# Session Initialisation

**Mission**: Build YOUR internal context so you can help the user effectively. You are preparing yourself, not reporting to the user.

**Constraint**: READ-ONLY. No commits, no issues, no branches, no pushes.

---

## Steps

**Bash rule for every step below**: run each command as a **separate** bash tool call. Do NOT chain with `&&` / `||` / `;` / `|` / `>` / `` ` `` / `$(…)` — `permission-guard` refuses any command containing those characters (anti-injection invariant) and the combined form falls through to deny. Do NOT prefix with `cd <path>` either — Pi's bash tool already runs in the project cwd.

1. **Branch check** — run each as its own bash call:
   - `git status`
   - `git branch --show-current`
   - `git worktree list`

   If uncommitted changes exist: decide if they belong to current task. Stash or worktree-park if not.

2. **Index the codebase**: `colgrep init .` (single bash call).

   **Note**: Do not run `colgrep` for project-meta queries — `colgrep init` is the only colgrep call PM makes in /start.

3. **Context sweep** — dispatch explore specialist (runs in parallel with step 4's direct reads):
   - Use the `dispatch_specialist` tool with `role: explore` and prompt:
     "Run the /start intelligence sweep following your Structured Summary Contract. Return EXACTLY the eight-field structured summary: project, maturity, current_state, conventions, quality_gates, gotchas, open_work, ci_health. No raw output."

4. **Current state of work** — run these directly (one bash call each, in parallel with step 3's dispatched explore):
   - `oo git log --oneline -10`
   - `gh issue list --limit 15`
   - `gh pr list`
   - `gh run list --branch main --limit 3`
   - `oo git shortlog -sn --no-merges`
   - `oo git for-each-ref --sort=-committerdate refs/heads --format='%(HEAD) %(refname:short) %(committerdate:relative)'`

   These are read-only — no dispatch, no subagent spawn, no GLM summarisation dependency. The output is yours to synthesise in step 5.

5. **Wait for the explore dispatch** (step 3) to return, then synthesise step 4's raw output + explore's summary into the one readiness line. On timeout (120 seconds) or incomplete explore response, apply the Reconnaissance Doctrine timeout and resilience fallback.

6. **Store findings**: `vipune add '<project identity, current state, conventions, gotchas>'` (single bash call; quoted argument).

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
