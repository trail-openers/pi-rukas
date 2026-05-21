---
description: On-demand six-pass code review (SECURITY, ERROR_HANDLING, TYPE_SAFETY, PERFORMANCE, ARCHITECTURE, SIMPLICITY)
argument-hint: "[#PR | path | latest N | (empty = full codebase)]"
---

# Code Review Mission

**Scope**: $ARGUMENTS

If no scope was provided above, this command defaults to a full-codebase review (Mode 2) after confirming with the user.

---

## Role

You are running an on-demand six-pass code review. Your job:
1. Determine the scope (one PR, a path, the latest N PRs, or the whole codebase).
2. Gather the code under review as a single `diff` payload.
3. Call the `dispatch_lens_review` tool ONCE.
4. Present the verdict + structured findings to the user.

This is **not** the `/work` review loop — this is a standalone review service. No automatic developer dispatch, no adversarial gate, no fix iterations. The user decides what to do with findings.

---

## Step 1 — Parse the scope

### Mode 1 — Scoped review (any `$ARGUMENTS` provided)

Match strictly:

- **`#NUMBER`** (e.g. `#456`) → PR by number:
  ```bash
  gh pr diff "$NUMBER"
  ```
  Use the output as the `diff` payload.

- **Path with `/` or a file extension** (e.g. `src/auth/` or `src/auth.ts`) → directory or file:
  ```bash
  git diff main -- "$PATH"
  ```
  If the diff is empty (no changes vs main), fall back to reading the file(s) and prefacing the payload with `--- FILE: <path> ---\n` blocks so the lenses know they're reviewing static code, not a diff.

- **`latest N` or `latest N PRs`** (e.g. `latest 2`, `latest 3 PRs`) → N most recent PRs:
  ```bash
  gh pr list --limit "$N" --state all --json number,title
  ```
  Then `gh pr diff <number>` for each. Concatenate the diffs with `=== PR #X — <title> ===\n` separators.

- **Anything else** (ambiguous text, bare numbers, etc.) → ask the user once to clarify, with these examples:
  > Could you specify the scope? Use `#NUMBER` for a PR, a path like `src/auth/` for a directory/file, or `latest 2 PRs` for recent ones.

  If still ambiguous after one clarification, abort: "Unable to determine review scope."

### Mode 2 — Full codebase review (empty `$ARGUMENTS`)

1. Confirm with the user: "Run a full-codebase review across all six lenses? This will take several minutes and a few cents on token spend. (y/n)"
2. If declined: ask what scope to use instead and restart at Mode 1.
3. If confirmed:
   - Partition by top-level directory (`src/`, `lib/`, `packages/`, etc.).
   - Collect the contents of recently-changed and high-traffic files first (see hotspots from `/start` if available).
   - **Token budget**: aim for ≤ 50K total chars per `diff` payload. If the codebase is larger, prioritise: (a) files changed in the last 30 days, (b) modules in critical paths (auth, payments, data), (c) recently-touched complex modules.
   - Format as `=== FILE: <path> ===\n<contents>\n\n=== FILE: ...`
   - If still over budget, run multiple reviews and prefix the report with "PARTIAL REVIEW: covering <modules>".

---

## Step 2 — Dispatch the lens review

Call the `dispatch_lens_review` tool with:

- `diff`: the payload from Step 1.
- `context`: 1-2 sentences explaining what was assembled (e.g., "PR #456 — refactor auth handler" or "Static review of src/auth/").
- `cwd`: only set if the review should run in a non-default working directory.

The tool fans out the six parallel `code-review-specialist` children, each pinned to its skill, dedupes findings by `(path, line, title)` and precedence-merges them (SECURITY > ERROR_HANDLING > TYPE_SAFETY > PERFORMANCE > ARCHITECTURE > SIMPLICITY), and returns a verdict.

---

## Step 3 — Present the report to the user

Format the response as:

```
## Code Review Results

**Verdict**: <APPROVED | ISSUES_FOUND | CRITICAL_ISSUES_FOUND>
**Scope**: <what was reviewed>
**Findings**: <N total>  (CRITICAL=<n>  HIGH=<n>  MEDIUM=<n>  LOW=<n>)

### Critical Issues (must fix before merge)
<CRITICAL findings, grouped by file>

### High-Priority Issues
<HIGH findings>

### Medium-Priority Issues
<MEDIUM findings>

### Low-Priority Observations
<LOW findings>

### Summary by Lens
<one-line summary per lens that contributed findings>

### Transcripts
<bullet list of transcriptPath values from the tool result — paths only, for the user's post-hoc inspection>
```

Each lens's transcript path is in the `[ensemble:async]` tool report. Copy the paths verbatim into the Transcripts section so the user can navigate to them. **Do NOT read the transcripts yourself** — they re-import content the tool already returned to you in deduped form.

---

## Principles

- **Parallel-first** — the tool does this automatically; do not loop the lenses serially.
- **One dispatch only** — `/review` runs once and reports. No fix loops. If the user wants iterative fixing, point them at `/work`.
- **Lens discipline** — each lens stays in its lane; cross-lens overlap is intentional and deduped.
- **Transparency** — always list the per-lens transcript paths so the user can verify each lens's reasoning.
