---
description: Execute a GitHub issue end-to-end — branch → implement → adversarial → PR → review → CI → merge
argument-hint: "<issue-number>"
---

# Work: Execute GitHub Issue(s)

**Issue**: $ARGUMENTS

If no issue number provided, ask.

---

## Capabilities

- Up to **10 async parallel slots** via `dispatch_parallel`. Never serialise independent work.
- **Worktrees are cheap scratch space.** Multiple developers run in parallel worktrees; cherry-pick into ONE feature branch → ONE PR → ONE CI run.
- **Developer never commits.** Returns with uncommitted changes in the worktree. `ops` commits.
- **Adversarial gate is mandatory.** Implementation goes through `pair_watch` (developer + live adversarial observer in one call). `ops` does not commit until pair_watch returns APPROVED.

## How dispatch works (read once)

All dispatch tools are async: they return a `{ jobId }` handle in < 100ms. The subagent's final report arrives later as a user message starting with `[ensemble:async]`. After dispatching, **end your turn with a one-line summary** unless you have other parallel work — the user can interact freely while children run. React to the `[ensemble:async]` report when it arrives. Never read transcript files under `~/.pi/agent/ensemble-runs/` — those are user-only. Before declaring the workflow done at the end, call `dispatch_status` to confirm no children are still running.

---

## Step 1 — Read the issue and project context (parallel)

```bash
gh issue view "$ARGUMENTS"
```

Simultaneously dispatch `explore` via `dispatch_specialist`:
- `vipune search "<keyword>" --limit 5` — prior decisions. Derive conceptual keywords from the issue title/body and run a focused search per keyword. Use your judgment for what's worth searching. Avoid passing the whole issue as a single query — vipune prefers short phrases.
- `colgrep "<concept>"` — find existing code that implements something described in the issue. ColGREP is **code-only** semantic search; the query must describe something you'd expect to find in source files (e.g. `"JWT validation"`, `"retry on HTTP 5xx"`, `"users table migration"`). Do not use it for meta-questions like `"project architecture"` — those return useless matches.

## Step 2 — Decompose and plan

Identify parallel workstreams. Decide worktree strategy:
- Single task → single feature branch, no worktrees.
- Multiple independent tasks → worktrees as scratch, cherry-pick into one branch.

## Step 3 — Setup

Delegate to `ops` via `dispatch_specialist`. The ops prompt MUST explicitly require these preconditions before creating the feature branch:

1. **Identify the mainline branch.** Default `main`; if the repo uses a different convention (`master`, `develop`, `trunk`, etc.) detect via `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`.
2. **Verify clean working tree.** `git status --porcelain` must be empty. If dirty, ABORT and surface to PM — do NOT branch off uncommitted work.
3. **Fetch and fast-forward the mainline.** `git fetch origin && git checkout <mainline> && git pull --ff-only origin <mainline>`. If `--ff-only` fails (mainline diverged), ABORT and surface to PM.
4. **Create feature branch** `feature/issue-{N}-brief-description` from that fresh mainline tip.
5. **Create worktrees if parallelising** (`.worktrees/task-A`, `.worktrees/task-B`). Ensure `.worktrees/` is in `.gitignore`.

Never silently branch off stale or dirty state. If any precondition fails, ops surfaces the failure verbatim and PM stops the workflow to ask the user.

## Step 4 — Implementation + adversarial verification (`pair_watch`)

Call `pair_watch` ONCE per workstream. The tool spawns developer + adversarial-developer concurrently — developer implements, adversarial observes the live stream and intervenes via `interrupt_developer` when needed, then issues the verdict via `approve_developer` / `escalate_to_user`. **The pair_watch verdict IS the adversarial gate.** Do NOT call `adversarial_loop` separately afterwards — that's redundant.

Required params:
- `task` — one-line directive ("Implement issue #N: <brief>")
- `context` — 1-3 sentence framing for the adversarial watcher
- `issueText` — **full issue body verbatim from `gh issue view`** (acceptance criteria, DoD, etc.). Mandatory: without it, adversarial has no criteria to verify against and tends to rubber-stamp.
- `cwd` — working directory (worktree path or repo root)

Optional:
- `wallClockMin` — bump from default 10min for complex tasks (max 30)
- `developerModel` / `adversarialModel` — per-spawn model overrides

Multi-task parallel work: when the issue decomposes into N independent workstreams, fire N `pair_watch` calls (one per worktree). Each is async and runs concurrently. PM gets N separate `[ensemble:async]` reports.

### Verdict handling

| pair_watch verdict | What you do |
|---|---|
| `APPROVED` | Proceed to Step 5 (commit). Do NOT re-fetch the diff to "verify" — pair_watch already verified it. |
| `ESCALATED` | Surface the adversarial's reason verbatim to the user. Do NOT auto-retry. |
| `TIMEOUT` / `CAP_HIT` / `DEV_FINISHED_NO_VERDICT` | **Terminal — do NOT retry pair_watch.** Fall back: take the dev's current diff and run `adversarial_loop` on it as the gate, OR surface to the user. |

## Step 5 — Commit and PR

Dispatch `ops`:
- Single task: `git add` + `git commit` from main wd.
- Multi-task: commit from each worktree, cherry-pick into the feature branch, then `git worktree remove`.
- Push feature branch.
- `gh pr create` with `Fixes #N` in the body.

## Step 6 — Six-pass code review (MANDATORY)

**Initialise round tracking**: `review_round = 1` on first entry. Track wall-clock from now (90-min cap for the entire Step 6 loop).

**Fetch the PR diff ONCE** and reuse it for the lens review and any subsequent retry rounds:

```bash
gh pr diff "$PR_NUMBER"        # or: git diff main...feature/issue-N
```

Call the `dispatch_lens_review` tool with `diff`, optional `context` (1-3 sentence summary of the change), and optional `cwd`. The tool fans out six parallel `code-review-specialist` children — one per lens (SECURITY, ERROR_HANDLING, TYPE_SAFETY, PERFORMANCE, ARCHITECTURE, SIMPLICITY) — each pinned to its skill via `--no-skills --skill <path>`. Findings are deduped by `(path, line, title)`, precedence-merged (SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE > ARCHITECTURE > SIMPLICITY), and a verdict is computed:

- **APPROVED** (no findings, or only LOW) → proceed to Step 7.
- **ISSUES_FOUND** (any HIGH or MEDIUM) → enter the fix loop below.
- **CRITICAL_ISSUES_FOUND** (any CRITICAL) → enter the fix loop below; treat as highest priority; user override is NOT permitted for CRITICAL.

### Step 6f — Fix loop (when verdict is not APPROVED)

Run the following cycle, incrementing `review_round` after each complete pass:

1. **Consolidate findings**: take the `findings` array from the tool's `details`. Group by file. For each file, summarise what needs fixing (title, severity, suggestion).

2. **Dispatch `pair_watch` to fix** with the consolidated findings as the task. Use the same primary path as Step 4 — fixing a lens-review finding is implementation work and benefits from live adversarial observation just as much as the original implementation does. Required params:
   - `task`: "Address the following six-pass review findings against the diff currently on this worktree. Make the minimal change per finding. Run local quality gates before declaring complete. Do NOT touch unrelated code."
   - `context`: 1-2 sentence framing for the adversarial watcher (e.g., "Six-pass review round N fix pass; lens findings below")
   - `issueText`: the consolidated findings list verbatim (severity, file:line, title, suggestion per finding) — this is the adversarial's checklist for verifying each fix
   - `cwd`: same worktree as Step 4
   - The pair_watch verdict closes this fix round: APPROVED → continue to step 3; ESCALATED / TIMEOUT / CAP_HIT / DEV_FINISHED_NO_VERDICT → halt and surface to the user.

3. **Re-fetch diff** after pair_watch APPROVED: `git -C <worktree> diff` or `gh pr diff <N>` if changes were committed.

4. **Re-run this step** (Step 6) by calling `dispatch_lens_review` again with the new diff.

5. **Check loop caps** BEFORE starting the next round:
   - If `review_round > 3` → halt, summarise what keeps failing per lens, and ask the user for guidance.
   - If wall-clock exceeds 90 minutes → halt with timeout message.

6. **User override paths** (only when caps are exceeded, only for verdicts ≤ ISSUES_FOUND, never for CRITICAL):
   - Option A: continue to Step 7 with the lens issues unresolved. Requires explicit "yes" confirmation. Record the override in vipune: `vipune add 'override issue #N PR#M: [lens names] bypassed. Reason: [user-provided]'`.
   - Option B: user manually addresses the remaining findings and confirms ready to proceed.

Per-lens transcripts auto-save under `~/.pi/agent/ensemble-runs/` for the **user's** post-hoc inspection. Do NOT read them yourself — that bloats your context and re-imports content the lens-review tool already returned to you in summarised form.

### Step 6e — Mandatory observability output

After Step 6f resolves (APPROVED, halted, or overridden), print a status line of the form:

```
six-pass review · round <N> of 3 · verdict <APPROVED|ISSUES_FOUND|CRITICAL_ISSUES_FOUND>
transcripts: <copy the `transcripts` block from the [ensemble:async] report verbatim>
```

so the user can see exactly how many rounds ran and where to find the per-lens detail. The `[ensemble:async]` report from `dispatch_lens_review` already contains the transcript paths — surface them verbatim, do not synthesise.

## Step 7 — CI monitoring

Dispatch `ops` to run `gh run watch`. On failure, fix via `pair_watch` using the same shape as Step 6f's fix loop (CI failure summary becomes the `task` + `issueText`), then loop back to Step 6 if any code changed.

On green CI + APPROVED review: merge per project merge policy.

## Step 8 — Store learnings

```bash
vipune add 'issue #N: [decision/pattern discovered]'
```

---

## Principles

- Parallel first.
- Worktrees are temporary scratch.
- One PR per issue.
- Developer hands off with uncommitted changes — `ops` commits.
- Adversarial gate is not optional — `pair_watch` is the gate.
