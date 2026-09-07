# GitHub Issue Workflow

## Issue Requirement

**CRITICAL: NO WORK WITHOUT GITHUB ISSUES**
- EVERY development task must be linked to a GitHub issue
- Use issue numbers in branch names and commit messages
- REFUSE any work without proper issue tracking

**Research/analysis tasks**: Skip issue creation (no code changes)

### Who creates issues

Issue creation is **compiled**. This module is composed into both the project-manager and developer prompts, so act by role:

- **Project manager (PM)**: the sole owner of issue creation, exercised through the `start_plan_driver` tool (the compiled /plan driver). Call it with `dryRun: true` first, show the spec + gap dispositions to the operator, and on confirmation re-call without `dryRun`. Direct `gh issue create` is structurally refused for every role in every mode — the mode-independent guard's refusal names the tool to use instead. **Mid-cycle `gh issue edit` of an existing issue body stays ungated** — refinements and corrections go in the body, not a new ticket.
- **Developer (and every specialist)**: you do NOT create or edit GitHub issues. Before starting work, **verify a GitHub issue exists** for the task. If none does, **report the missing issue in your final message** — PM files it via `start_plan_driver`. Do not open a ticket yourself; the guard will refuse, and a specialist filing its own ticket is scope-creep even if it did not.

PM runs `gh` directly for the read/lifecycle verbs — the `start_plan_driver` tool (not a hypothetical `ticket` tool) owns creation now; see [#98](https://github.com/randomm/pi-ensemble/issues/98) for the original RFC.

## Issue Creation Template

```markdown
### Task Description
[Brief description of work to be done]

### Quality Gates (Non-Negotiable)
- [ ] **TDD**: Write tests before implementation
- [ ] **Coverage**: 80%+ test coverage for new code
- [ ] **Linting**: All code passes project linting rules
- [ ] **Documentation**: Update README.md and relevant docs as needed
- [ ] **Local Verification**: All tests pass locally before completion

### Acceptance Criteria
[Specific functional requirements and success criteria]
```

## Issue Creation (PM only, compiled)

PM creates issues exclusively via the `start_plan_driver` tool. It runs the five-phase pipeline (classify → mechanical inventory → type-specialised investigation → draft → adversarial gap gate) and files through its own child-process exec (the driver's own `gh issue` create run in a child process, which is exempt from the mode-independent guard by construction). `dryRun: true` returns the structured spec without filing; the operator's confirmation is the seam between the two calls.

**Specialists (developer, ops, explore, reviewers)**: do NOT run issue-creation commands (the mode-independent guard refuses them in every mode, for every role). Verify the issue exists, then report a missing one to PM in your final message.

## GitHub Issue Command Reference (bare `gh`)

All issue mutations run as bare `gh` commands (run `gh`, not `oo gh` — `oo` compresses or indexes output >4 KB, which loses the raw issue body PM needs to decide). Mutation verbs (`create`, `edit`, `close`, `reopen`) are **PM-only** per the role split above; read verbs (`view`, `list`, `comment`) are shared.

**Comment on an issue:**

```bash
gh issue comment <issue-number> --body "your comment text"
```

**Close an issue (PM only):**

```bash
gh issue close <issue-number>
```

**Reopen an issue (PM only):**

```bash
gh issue reopen <issue-number>
```

**View an issue:**

```bash
gh issue view <issue-number>
```

**List issues:**

```bash
gh issue list --limit 15
gh issue list --state closed --limit 5
```

**Create an issue (PM only):** See the "Issue Creation Command (PM only)" section above.

## Task Type Classification

**Development Tasks** (require issue + branch):
- Keywords: implement, build, create, deploy, setup, fix, add, modify, configure, install

**Research Tasks** (skip issue creation):
- Keywords: research, investigate, analyze, compare, evaluate, find, assess, study, pricing, alternatives, feasibility

## PR Linking

- Link PR to issue: `Closes #123` in the PR body (the `Fixes #123` / `Resolves #123` keywords also work)
- Commit subjects use an alphabetic subsystem scope (`feat(work): description`); NEVER put the issue number in the scope position — linkage flows through the PR body and the branch slug

## Issue Reading Fallback

Use `oo gh issue view` for reading issue content. If it fails with `repository.issue.projectCards` deprecation errors, fall back to REST API. Do NOT fallback for auth/network/rate limit errors.

### Single Issue Fallback

Two separate bare tool calls — no command substitution, no pipe. Pipelines and `$(…)` shapes break the `oo` runner (its indexing path replaces JSON with a recall-hint line) and can prompt the permission matcher, which cannot wildcard chained shapes — the two-step shape keeps every call clean and the raw output readable.

1. Derive `{owner}` and `{repo}` from the remote URL (read the URL, then extract the owner and repo segments yourself):

   ```bash
   git remote get-url origin
   ```

2. Fetch the issue with the REST endpoint (run bare, not `oo gh api` — bare returns the full JSON, which you then read directly):

   ```bash
   gh api repos/{owner}/{repo}/issues/{number}
   ```

REST endpoint `/repos/{owner}/{repo}/issues/{number}` avoids GraphQL `projectCards` deprecation. The issue body is the `body` field in the JSON response. Note: this endpoint may return PR data—validate `pull_request` is absent/null when strict issue-only scope is required.

### Multiple Issues Pattern

For multiple issues, two separate bare tool calls:

1. Derive `{owner}` and `{repo}` from `git remote get-url origin` (same as above).
2. List open issues:

   ```bash
   gh api repos/{owner}/{repo}/issues -f state=open -f per_page=100
   ```

Read the JSON response and extract `number` + `title` per entry from the tool result — no `jq` pipe needed. Use for listing issues when `gh issue list` encounters `projectCards` deprecation errors.
