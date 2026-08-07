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

2. **Index the codebase** (if not already indexed): `mcp({tool: "codebase_memory_index_repository", args: '{"repo_path": "."}'})`. Idempotent — safe to call every /start; the server skips re-indexing if the working tree hasn't changed.

   **Note**: For structural queries during /start (architecture overview, key entry points), use `codebase_memory_get_architecture({path: "."})` instead of running `search_code` for meta-questions.

3. **Context sweep** — dispatch explore specialist. **Do NOT wait for it before starting step 4** — explore and your own bash reads run concurrently.
   - Use the `dispatch_specialist` tool with `role: explore` and prompt:
     "Run the /start intelligence sweep following your Structured Summary Contract. Return EXACTLY the eight-field structured summary: project, maturity, current_state, conventions, quality_gates, gotchas, open_work, ci_health. No raw output."

4. **Current state of work** — run these directly IN THE SAME PM TURN as step 3's dispatch (one bash call each, all in parallel):
   - `oo git log --oneline -10`
   - `gh issue list --limit 15`
   - `gh pr list`
   - `gh run list --branch main --limit 3`
   - `oo git shortlog -sn --no-merges`
   - `oo git for-each-ref --sort=-committerdate refs/heads --format='%(HEAD) %(refname:short) %(committerdate:relative)'`

   These are read-only — no dispatch, no subagent spawn, no GLM summarisation dependency. The output is yours to synthesise in step 6.

5. **What `/work` left behind** — run these directly, one bash call each, alongside step 4:
   - `ls .pi/work-state/`
   - `cat .pi/work-state/queue-summary.json`

   This is the most actionable state in the repo and the only part of it that is invisible everywhere else. A parked cycle has no open PR and no issue comment; a group that never started has no state file at all — `queue-summary.json` is the only record it existed.

   Both commands fail harmlessly in a repo that has never run `/work`. **Absence is silent** — say nothing rather than reporting a missing file as a finding.

   From the summary, carry into step 6: each parked group's issue numbers and its `humanAction`, the groups under `notStarted`, and how long ago `at` was. A summary from last week is history, not this morning's queue — say which.

6. **Wait for the explore dispatch** (step 3) to return, then synthesise step 4's raw output + step 5's driver state + explore's summary into the one readiness line. On timeout (120 seconds) or incomplete explore response, apply the Reconnaissance Doctrine timeout and resilience fallback.

7. **Store findings**: `vipune add '<project identity, current state, conventions, gotchas>'` (single bash call; quoted argument).

## Output

One readiness line:
- Project (with maturity + team size from telemetry)
- Current status (active work, CI health, hotspots)
- **Anything `/work` parked, named with its action** — "#287 parked, needs acceptance criteria; group g4 (#301, #302) never started". This goes before the general status: it is the only part the operator cannot find any other way, and it is usually why they opened the session.
- "Ready for instructions."

This is NOT a report — you are confirming readiness.

---

## Principles

- **Parallel first** — explore dispatch (step 3) and direct reads (steps 4 and 5) run concurrently in the same PM turn.
- Build on existing knowledge, don't repeat what's in memory.
- Discover, don't assume.
- Focus on what enables productivity.
