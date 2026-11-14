# GitHub Issue Workflow

## Issue Requirement

**CRITICAL: NO WORK WITHOUT GITHUB ISSUES**
- EVERY development task must be linked to a GitHub issue
- Use issue numbers in branch names and commit messages
- REFUSE any work without proper issue tracking

**Research/analysis tasks**: Skip issue creation (no code changes)

### Who creates issues

Issue creation is **compiled**. This module is composed into both the project-manager and developer prompts, so act by role:

- **Project manager (PM)**: the sole owner of issue creation, exercised through the `start_plan_driver` tool (the compiled /plan driver). Call it with `dryRun: true` first, show the spec + gap dispositions to the operator, and on confirmation re-call without `dryRun`, passing the `reviewedDigest` the dry run's report carried. Both calls return immediately with a `jobId` — the spec arrives on the `[ensemble:async]` steer, so end your turn between them rather than polling. Direct `gh issue create` is structurally refused for every role in every mode — the mode-independent guard's refusal names the tool to use instead. **Mid-cycle `gh issue edit` of an existing issue body stays ungated** — refinements and corrections go in the body, not a new ticket.
- **Developer (and every specialist)**: you do NOT create or edit GitHub issues. Before starting work, **verify a GitHub issue exists** for the task. If none does, **report the missing issue in your final message** — PM files it via `start_plan_driver`. Do not open a ticket yourself; the guard will refuse, and a specialist filing its own ticket is scope-creep even if it did not.

PM runs `gh` directly for the read/lifecycle verbs — the `start_plan_driver` tool (not a hypothetical `ticket` tool) owns creation now; see [#98](https://github.com/trail-openers/pi-rukas/issues/98) for the original RFC.

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

PM creates issues exclusively via the `start_plan_driver` tool. It runs the five-phase pipeline (classify → mechanical inventory → type-specialised investigation → draft → adversarial gap gate) and files through its own child-process exec (the driver's own `gh issue` create run in a child process, which is exempt from the mode-independent guard by construction). `dryRun: true` is the read-only variant — it never files, and its spec + digest arrive on the delivered report. The confirming call carries the `reviewedDigest` from that report, so it cannot be made before the dry run's steer has arrived.

**Both `/plan` and `/research` run in the background (#1044).** The tool call returns a launch notice with a `jobId` and asserts nothing about the outcome; the rendered result — the spec and digest for a dry run, the filed ticket or the artifact paths for a real run, or a FAILED / HALTED / CANCELLED report — arrives later as a user message starting with `[ensemble:async]`. So: launch it, then **end your turn**. Do not poll, do not re-call to check progress, and quote no verdict, digest or path before that steer arrives. A `dryRun` call and its confirming call are TWO launches; the confirm must wait for the dry run's own report, because that report is the only place its `reviewedDigest` exists.

**Specialists (developer, ops, explore, reviewers)**: do NOT run issue-creation commands (the mode-independent guard refuses them in every mode, for every role). Verify the issue exists, then report a missing one to PM in your final message.

## Reading and writing an issue

**A helper child holds no forge login** — the spawn layer deleted the five token
variables and redirected both CLI config roots — so a `gh`/`glab` read it runs
itself is unauthenticated: rate-limited, and refused outright on a private repo.
Read issue content with `forge_read`, which the parent runs with its own
credential and answers with the forge's own bytes; the PM and ops keep their
login and their CLI: `forge_read` for a helper, `gh issue view` and `gh issue list` for them.

`forge_read` has no write verb. The mutations below are the PM's, and a helper
asked to perform one reports it instead of improvising a CLI call it cannot
authenticate.

### Read an issue

Read issue content with `forge_read` (verb `issue_view`, the issue's `number`) —
one call shape for either forge, and the read a helper role uses. For the
discussion the `issue_comments` verb; for a search the `issue_search` verb with
its search text (the parent bounds that text, so a search is a search rather than
a dump); for a listing `issue_list`, which may take its `state` filter. The CLI
equivalents below need a login, so they are the PM's and ops's.

### Writes and reads by the PM (bare `gh`)

All issue mutations run as bare `gh` commands (raw output — a compressed or
indexed summary loses the issue body PM needs to decide). Mutation verbs
(`create`, `edit`, `close`, `reopen`) are **PM-only** per the role split above,
and the CLI reads below are PM and ops — a helper reads with `forge_read`.

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

**View an issue (PM and ops; a helper reads with `forge_read`):**

```bash
# PM and ops only — a helper reads issue content with `forge_read`.
gh issue view <issue-number>
```

**List issues (PM and ops; a helper uses `forge_read`'s `issue_list`):**

```bash
# PM and ops only — the same listing is `forge_read` with the `issue_list` verb.
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

## Issue Reading Fallback (PM and ops)

A helper has no fallback to make: its read path is `forge_read` and there is
nothing below it. The two patterns below belong to a role that holds a login, and
are what PM and ops reach for when the subcommand's own output is not readable
enough. Read issue content with `forge_read` (PM and ops: the CLI and REST forms
below).

Use `gh issue view` for reading issue content, or `forge_read` for the same bytes
without a login. If it fails with `repository.issue.projectCards` deprecation errors, fall back to REST API. Do NOT fallback for auth/network/rate limit errors.

### Single Issue Fallback

Two separate bare tool calls — no command substitution, no pipe. Pipelines and `$(…)` shapes can prompt the permission matcher, which cannot wildcard chained shapes — the two-step shape keeps every call clean and the raw output readable.

1. Derive `{owner}` and `{repo}` from the remote URL (read the URL, then extract the owner and repo segments yourself):

   ```bash
   git remote get-url origin
   ```

2. Fetch the issue with the REST endpoint (run bare — it returns the full JSON, which you then read directly). PM and ops only: a helper reads the same body with `forge_read`.

   ```bash
   # PM and ops only — a helper reads this body with `forge_read` (`issue_view`).
   gh api repos/{owner}/{repo}/issues/{number}
   ```

REST endpoint `/repos/{owner}/{repo}/issues/{number}` avoids GraphQL `projectCards` deprecation. The issue body is the `body` field in the JSON response. Note: this endpoint may return PR data—validate `pull_request` is absent/null when strict issue-only scope is required.

### Multiple Issues Pattern

For multiple issues, two separate bare tool calls:

1. Derive `{owner}` and `{repo}` from `git remote get-url origin` (same as above).
2. List open issues. PM and ops only — a helper lists with `forge_read` (`issue_list`).

   ```bash
   # PM and ops only — the helper's listing is `forge_read` (`issue_list`).
   gh api repos/{owner}/{repo}/issues -f state=open -f per_page=100
   ```

Read the JSON response and extract `number` + `title` per entry from the tool result — no `jq` pipe needed. Use for listing issues when `gh issue list` encounters `projectCards` deprecation errors; a helper lists the same rows with `forge_read`.
