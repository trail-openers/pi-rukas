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
- **Adversarial gate is mandatory.** After every developer dispatch, run `adversarial_loop` on the resulting diff. `ops` does not commit until `adversarial_loop` returns APPROVED.

## How dispatch works (read once)

All dispatch tools are async: they return a `{ jobId }` handle in < 100ms. The subagent's final report arrives later as a user message starting with `[ensemble:async]`. After dispatching, **end your turn with a one-line summary** unless you have other parallel work — the user can interact freely while children run. React to the `[ensemble:async]` report when it arrives. Never read transcript files under `~/.pi/agent/ensemble-runs/` — those are user-only. Before declaring the workflow done at the end, call `dispatch_status` to confirm no children are still running.

---

## Step 1 — Read the issue and project context (parallel)

```bash
gh issue view "$ARGUMENTS"
```

Simultaneously dispatch `explore` via `dispatch_specialist`:
- **Discover memory types first** (vipune types are project-defined, not fixed): `vipune list --json | jq -r '.[] | .memory_type' | sort -u` (If this command fails, skip `--memory-type` filtering and proceed with `--hybrid` searches only.) (If you've already discovered this project's memory types earlier in this session, reuse them — skip re-running discovery.)
- `vipune search "<keyword>" --hybrid --recency <0.0-1.0> --limit 8-10` — prior decisions. Derive conceptual keywords from the issue title/body and run a focused search per keyword. Use `--hybrid` for semantic + BM25 fusion. Vary `--recency` by intent: `0.0-0.3` for foundational knowledge, `0.9` for "what's happening lately". Use your judgment for what's worth searching. Avoid passing the whole issue as a single query — vipune prefers short phrases.
- `colgrep "<concept>"` — find existing code that implements something described in the issue. ColGREP is **code-only** semantic search; the query must describe something you'd expect to find in source files (e.g. `"JWT validation"`, `"retry on HTTP 5xx"`, `"users table migration"`). Do not use it for meta-questions like `"project architecture"` — those return useless matches.

On timeout (120 seconds) or incomplete explore response, apply the Reconnaissance Doctrine timeout and resilience fallback.

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

## Step 4 — Implementation

Dispatch `developer` via `dispatch_specialist` for each workstream. When the issue decomposes into N independent workstreams, use `dispatch_parallel` with one developer spec per worktree.

Required developer prompt fields:
- **Task**: one-line directive ("Implement issue #N: <brief>")
- **Context**: 1-3 sentence framing
- **Issue text**: **full issue body verbatim from `gh issue view`** (acceptance criteria, DoD, etc.) — without it the developer works to a paraphrased spec
- **Worktree path** and branch name
- **Files in scope** (when known) — discourages drive-by edits
- Explicit instruction: "list changed files and return; do not attempt git commands."

`developer` returns with uncommitted changes in the worktree. `ops` does not commit until Step 5's adversarial gate passes.

## Step 5 — Adversarial gate (MANDATORY)

When the developer(s) return, gate the diff with `adversarial_loop` before any commit:

1. Obtain the diff:
   - Worktree: `git -C .worktrees/task-A diff`
   - Main wd: `git diff`
2. Call `adversarial_loop` with `diff`, `context` (include the same issue text given to the developer — the adversarial verifies against acceptance criteria), and `workCwd`.
3. On APPROVED → Step 6.
4. On rejection after 3 internal rounds → halt and surface the verdict text to the user.

The `adversarial_loop` tool encapsulates a 3-round review-then-fix cycle: each rejection spawns a fresh developer to address the findings, then re-reviews. PM does not orchestrate the internal rounds — one tool call returns the final verdict.

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

2. **Dispatch `developer` to fix** via `dispatch_specialist`. Required prompt fields:
   - Task: "Address the six-pass review findings below against the diff currently on this worktree. Make the minimal change per finding. Run local quality gates before declaring complete. Do NOT touch unrelated code."
   - Context: "Six-pass review round N fix pass; lens findings below."
   - Findings list verbatim (severity, file:line, title, suggestion per finding) — this is the developer's checklist.
   - Worktree path (same as Step 4).

3. **Re-run the adversarial gate** (Step 5): call `adversarial_loop` with the post-fix diff and the consolidated findings as `context`. If the loop rejects after its own 3 internal rounds, halt and surface the verdict text to the user.

4. **Re-fetch diff** after the adversarial gate passes: `git -C <worktree> diff` or `gh pr diff <N>` if changes were committed.

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

Dispatch `ops` to run `gh run watch`. On failure, dispatch `developer` with the CI failure summary as the task and the same worktree, then re-run the adversarial gate (Step 5) on the resulting diff. If any code changed, loop back to Step 7 (six-pass review) before re-attempting CI.

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
- Adversarial gate is not optional — `adversarial_loop` runs after every developer dispatch, before `ops` commits.
