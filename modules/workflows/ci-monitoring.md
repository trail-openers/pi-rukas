# CI/CD Monitoring Protocol

CI monitoring is forge-specific. Determine the forge first (env `PI_ENSEMBLE_FORGE`, `.pi/forge`, or the git remote host) and use the matching CLI: `gh` on GitHub, `glab` on GitLab — **PM and ops only**: a helper child holds no forge login and reads the same rows through the `forge_read` tool (`ci_run` for a run or pipeline, `pr_checks` for a PR's check rows).

## The wait is a bounded sleep-poll — on BOTH forges

Every forge CI wait below is the same recipe, and it is the recipe the driver itself
runs (`ciWatch` in `extension/src/forge-ci.ts`, `checksRedReason` in
`extension/src/lean/ci-tier.ts`): **`sleep 60`, then one read, repeated, until the
status is terminal or 30 minutes of waiting have passed.**

- Each iteration is **two separate tool calls** — `sleep 60`, then the read. Never
  combine them: no while-loop, no command substitution, no `;`, no `&&`, no pipes. A
  chained command is refused by the permission layer and never runs.
- **Where the permission layer gates each part.** Under the default trust mode (how
  `/work` children run) every call below runs unasked. Under the strict opt-in, or in
  a headless cycle where an `ask` verdict is a hard deny, a command the role is not
  allowlisted for is refused or stalls — and that refusal is not the CI failing and is
  not a reason to end the turn. Reach instead for a read your role's grants do cover
  (`gh run view <id> --json status,conclusion` and `gh run list` on GitHub, `glab
  pipeline view` / `glab pipeline list` on GitLab) and keep the cadence with a bounded
  wait you can run. Where every read is refused, report the refused commands — never a
  CI verdict you did not read.
- **A non-zero exit is data, not a failed command.** `gh pr checks` exits 8 while
  checks are pending; rows still print. Read the rows and poll again — do not abandon
  the wait because the exit code was non-zero.
- **A pending check is never a reason to end the dispatch.** Keep polling until the
  status is terminal or the cap fires; only then write your final message. If you end
  your turn while a check is still pending, the work you were waiting on is left
  undone — a merge brief that stops mid-wait has not completed.
- A slow-run notice during a CI wait is not a reason to stop either — finish the wait
  or reach the cap, then report.

## GitHub: bounded poll of the PR checks

<!-- forge-cli-scope: PM and ops — a helper child reads the check rows through the
`pr_checks` verb of `forge_read` instead; the two commands below need a forge login
a helper does not hold. -->

```bash
# Step 1: one read — the same rows a helper reads with `forge_read` (`pr_checks`);
# note the check rows from the output
gh pr checks <pr-number> --repo <owner/repo>

# Step 2: one wait — its own tool call, then repeat Step 1
sleep 60
```

Terminal when every required row reads pass, or any row reads fail, cancel or
timed_out — then report. The states pending, queued, in_progress and waiting are
not terminal: they mean keep going.

For failure details:

```bash
gh run view <run-id> --log-failed
```

## GitLab: bounded poll of the pipeline (the CLI does NOT watch)

<!-- forge-cli-scope: PM and ops — a helper child reads the pipeline through the
`ci_run` verb instead; the two commands below need a forge login a helper does not hold. -->

GitLab has **no non-interactive watch command** (`glab ci status` is not non-interactive-safe), so the poll is the only shape here.

```bash
# Step 1: find the newest pipeline (note the pipeline ID from the output); a helper
# reads the same rows with `forge_read` (`ci_run`)
glab api "/projects/:id/pipelines?per_page=1" --output json

# Step 2: one poll iteration (the same command, re-run after each `sleep 60`); a
# helper reads the run's status with `forge_read` (`ci_run`)
glab api /projects/:id/pipelines/<pipeline-id> --output json
```

- **Terminal statuses** (stop polling once `status` is one of these): `success`, `failed`, `canceled`, `skipped`, `manual`
- **30-minute cap per CI wait** — after ~30 minutes of polling with no terminal status, stop and report the wait as a failure with the reason "CI still pending at the cap". A new push restarts the cap.

## FORBIDDEN Patterns

- ❌ ANY **unbounded** loop calling CI list/view commands repeatedly with no terminal check or cap (e.g. `while true; do ... done`)
- ❌ A shell loop, command substitution or chained command standing in for the two-call poll — the permission layer refuses it, so the wait silently never happens
- ❌ Ending your turn while a check is still pending
- ❌ Ad-hoc CI list/view commands improvised as a substitute for the poll above (the bounded `sleep 60` + read recipe, with its terminal set and cap, is the sanctioned pattern, not this)

## Required Reporting

**FORBIDDEN Responses:**
- ❌ "CI should pass"
- ❌ "CI will likely pass"
- ❌ "Everything looks good for CI"

**REQUIRED Responses:**
- ✅ "CI run #123 started - monitoring..."
- ✅ "CI run #123 PASSED ✅ (took 3m 45s)"
- ✅ "CI run #123 FAILED ❌ - [specific error]"

## CI Failure Protocol

When CI fails (run or pipeline) — only once a status has actually reached a terminal
state; a pending row is not a failure and not a reason to report:
1. **STOP** all investigation immediately
2. **READ** the CI error message (`gh run view <run-id> --log-failed`, or the failed job's trace via the GitLab pipeline API)
3. **CLASSIFY** error type (test failure, lint error, type error)
4. **DELEGATE** to appropriate specialist
5. **Continue working** - fix results will auto-deliver, then retry

**Do NOT:**
- Run tests locally to "understand the error"
- Investigate test files to "debug"
- Attempt to fix code yourself
