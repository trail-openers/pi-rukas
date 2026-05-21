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
- **Adversarial gate is mandatory.** Use the `adversarial_loop` tool after developer returns; `ops` does not commit until APPROVED.

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

## Step 4 — Execute in parallel

Use `dispatch_parallel` with specs for:
- `explore` — technical context, prior decisions
- `developer` (one per worktree) — implement with TDD, run local quality gates

**Developer prompt must include:** worktree path, branch, issue number, files in scope, and the instruction "list changed files and return; do not attempt git commands."

## Step 5 — Adversarial gate (MANDATORY)

When the developer(s) return:
1. Obtain the diff:
   - Worktree: `git -C .worktrees/task-A diff`
   - Main wd: `git diff`
2. Call the `adversarial_loop` tool with `diff`, `context`, and `workCwd`.
3. On APPROVED → step 6.
4. On rejection after 3 rounds → halt and surface the failure summary to the user.

## Step 6 — Commit and PR

Dispatch `ops`:
- Single task: `git add` + `git commit` from main wd.
- Multi-task: commit from each worktree, cherry-pick into the feature branch, then `git worktree remove`.
- Push feature branch.
- `gh pr create` with `Fixes #N` in the body.

## Step 7 — Six-pass code review (MANDATORY)

**Initialise round tracking**: `review_round = 1` on first entry. Track wall-clock from now (90-min cap for the entire Step 7 loop).

**Fetch the PR diff ONCE** and reuse it for the lens review and any subsequent retry rounds:

```bash
gh pr diff "$PR_NUMBER"        # or: git diff main...feature/issue-N
```

Call the `dispatch_lens_review` tool with `diff`, optional `context` (1-3 sentence summary of the change), and optional `cwd`. The tool fans out six parallel `code-review-specialist` children — one per lens (SECURITY, ERROR_HANDLING, TYPE_SAFETY, PERFORMANCE, ARCHITECTURE, SIMPLICITY) — each pinned to its skill via `--no-skills --skill <path>`. Findings are deduped by `(path, line, title)`, precedence-merged (SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE > ARCHITECTURE > SIMPLICITY), and a verdict is computed:

- **APPROVED** (no findings, or only LOW) → proceed to Step 8.
- **ISSUES_FOUND** (any HIGH or MEDIUM) → enter the fix loop below.
- **CRITICAL_ISSUES_FOUND** (any CRITICAL) → enter the fix loop below; treat as highest priority; user override is NOT permitted for CRITICAL.

### Step 7f — Fix loop (when verdict is not APPROVED)

Run the following cycle, incrementing `review_round` after each complete pass:

1. **Consolidate findings**: take the `findings` array from the tool's `details`. Group by file. For each file, summarise what needs fixing (title, severity, suggestion).

2. **Dispatch developer to fix** via `dispatch_specialist` with role `developer`:
   - Provide the consolidated findings, the worktree path (same as Step 4), and the explicit instruction: "Address every finding listed below. Make the minimal change per finding. Run local quality gates before returning. Do NOT touch unrelated code."

3. **Re-fetch diff** after developer returns (developer may have changed line numbers): `git -C <worktree> diff` or `gh pr diff <N>` if changes were committed.

4. **Re-run the adversarial gate** (Step 5): call `adversarial_loop` with the new diff. If adversarial rejects after its own 3 internal rounds, the gate hard-fails — halt and surface to the user with the adversarial verdict text.

5. **Re-run this step** (Step 7) by calling `dispatch_lens_review` again with the new diff.

6. **Check loop caps** BEFORE starting the next round:
   - If `review_round > 3` → halt, summarise what keeps failing per lens, and ask the user for guidance.
   - If wall-clock exceeds 90 minutes → halt with timeout message.

7. **User override paths** (only when caps are exceeded, only for verdicts ≤ ISSUES_FOUND, never for CRITICAL):
   - Option A: continue to Step 8 with the lens issues unresolved. Requires explicit "yes" confirmation. Record the override in vipune: `vipune add 'override issue #N PR#M: [lens names] bypassed. Reason: [user-provided]'`.
   - Option B: user manually addresses the remaining findings and confirms ready to proceed.

Per-lens transcripts auto-save under `~/.pi/agent/ensemble-runs/` for the **user's** post-hoc inspection. Do NOT read them yourself — that bloats your context and re-imports content the lens-review tool already returned to you in summarised form.

### Step 7e — Mandatory observability output

After Step 7f resolves (APPROVED, halted, or overridden), print a status line of the form:

```
six-pass review · round <N> of 3 · verdict <APPROVED|ISSUES_FOUND|CRITICAL_ISSUES_FOUND>
transcripts: <copy the `transcripts` block from the [ensemble:async] report verbatim>
```

so the user can see exactly how many rounds ran and where to find the per-lens detail. The `[ensemble:async]` report from `dispatch_lens_review` already contains the transcript paths — surface them verbatim, do not synthesise.

## Step 8 — CI monitoring

Dispatch `ops` to run `gh run watch`. On failure, dispatch `developer` to fix, then loop back to Step 5.

On green CI + APPROVED review: merge per project merge policy.

## Step 9 — Store learnings

```bash
vipune add 'issue #N: [decision/pattern discovered]'
```

---

## Principles

- Parallel first.
- Worktrees are temporary scratch.
- One PR per issue.
- Developer hands off with uncommitted changes — `ops` commits.
- Adversarial gate is not optional.
