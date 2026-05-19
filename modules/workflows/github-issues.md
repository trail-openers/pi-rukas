# GitHub Issue Workflow

## Issue Requirement

**CRITICAL: NO WORK WITHOUT GITHUB ISSUES**
- EVERY development task must be linked to a GitHub issue
- Create issues BEFORE any code work begins
- Use issue numbers in branch names and commit messages
- REFUSE any work without proper issue tracking

**Research/analysis tasks**: Skip issue creation (no code changes)

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

## Issue Creation Command

**Use the `issue` tool — backend-agnostic (works with gh, jira, glab, az):**

Use the `mcp_issue` tool with:
- `command`: `create`
- `args`: `["--title", "fix: description", "--body", "### Task Description\n..."]`

**Why the tool, not bash**: The `issue` tool routes through `ISSUE_BACKEND` (default: gh) so the same agent prompt works across GitHub, Jira, GitLab, and Azure DevOps projects.

**Quoting note**: When constructing args, pass `--title` and `--body` as separate array elements. Single quotes and backticks in body text are safe since they're passed as array elements, not shell-interpolated.

## Issue Tool Command Reference

**Comment on an issue** — args format depends on backend:
- `command`: `comment`
- `args` (gh backend, default): `["<issue-number>", "--body", "your comment text"]`
- `args` (jira/glab/az backends): `["<issue-number>", "your comment text"]`

> **Why the difference**: The `gh` CLI requires a `--body` flag; Jira, GitLab, and Azure backends use the second positional argument as the comment text directly.

**Close an issue:**
- `command`: `close`
- `args`: `["<issue-number>"]`

**Reopen an issue:**
- `command`: `reopen`
- `args`: `["<issue-number>"]`

**View an issue:**
- `command`: `view`
- `args`: `["<issue-number>"]`

**List issues:**
- `command`: `list`
- `args`: `["--limit", "15"]` or `["--state", "closed", "--limit", "5"]`

**Create an issue:** See "Issue Creation Command" section above for the full create example.

## Task Type Classification

**Development Tasks** (require issue + branch):
- Keywords: implement, build, create, deploy, setup, fix, add, modify, configure, install

**Research Tasks** (skip issue creation):
- Keywords: research, investigate, analyze, compare, evaluate, find, assess, study, pricing, alternatives, feasibility

## PR Linking

- Link PR to issue: `Fixes #123` in PR description
- Include issue number in all commits: `feat(#123): description`

## Issue Reading Fallback

Use `oo gh issue view` for reading issue content. If it fails with `repository.issue.projectCards` deprecation errors, fall back to REST API. Do NOT fallback for auth/network/rate limit errors.

### Single Issue Fallback

To use the fallback command, derive values:
- `{owner}` and `{repo}`: from `oo git remote get-url origin`
- `{number}`: the actual issue number in the error context

```bash
oo gh api repos/{owner}/{repo}/issues/{number} | jq -r '.body'
```

REST endpoint `/repos/{owner}/{repo}/issues/{number}` avoids GraphQL `projectCards` deprecation. Note: This endpoint may return PR data—validate `.pull_request` is absent/null when strict issue-only scope is required. Use `jq -r '.body'` to extract issue body text.

### Multiple Issues Pattern

For multiple issues, use the list endpoint with filtering:

```bash
OWNER_REPO=$(oo git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
oo gh api repos/$OWNER_REPO/issues -f state=open -f per_page=100 | jq -r '.[] | "\(.number): \(.title)"'
```

This avoids `&&` chaining and for-loop+jq pitfalls. Use for listing issues when `oo gh issue list` encounters `projectCards` deprecation errors.
