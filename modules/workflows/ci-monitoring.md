# CI/CD Monitoring Protocol

CI monitoring is forge-specific. Determine the forge first (env `PI_ENSEMBLE_FORGE`, `.pi/forge`, or the git remote host) and use the matching CLI: `gh` on GitHub, `glab` on GitLab.

## GitHub: `gh run watch` (ALWAYS — NO polling)

`gh run watch` does the polling for you. Two separate bare tool calls — no variable, no command substitution:

```bash
# Step 1: find the newest run on the current branch (note the run ID from the output)
gh run list --limit 1 --branch main --json databaseId

# Step 2: watch it (use the run ID from step 1)
gh run watch <run-id>
```

For failure details:

```bash
gh run view <run-id> --log-failed
```

## GitLab: bounded 30s pipeline poll (the CLI does NOT watch)

Unlike GitHub, GitLab has **no non-interactive watch command** (`glab ci status` is not non-interactive-safe). The sanctioned pattern is a bounded poll of the pipeline, matching the driver's `ciWatch` implementation: poll every 30s, stop at a terminal status or the 30-minute cap.

```bash
# Step 1: find the newest pipeline (note the pipeline ID from the output)
glab api "/projects/:id/pipelines?per_page=1" --output json

# Step 2: one poll iteration (repeat every 30s with the same command)
glab api /projects/:id/pipelines/<pipeline-id> --output json
```

- **Terminal statuses** (stop polling once `status` is one of these): `success`, `failed`, `canceled`, `skipped`, `manual`
- **30-minute cap** — stop after ~30 minutes of polling and report a timeout, do not loop indefinitely
- This is the ONE sanctioned polling pattern: it is bounded (30s interval, 30-minute cap, terminal set) and matches what the driver itself does. It is NOT the forbidden ad-hoc pattern below.

## FORBIDDEN Patterns

- ❌ ANY **unbounded** loop calling CI list/view commands repeatedly with no terminal check or cap (e.g. `while true; do ... done` without the 30-minute cap)
- ❌ Manual `sleep` + status check patterns that improvise their own interval/cap instead of using the GitLab recipe above
- ❌ ANY pattern with 5+ consecutive **ad-hoc** CI list/view commands (the GitLab 30s poll loop above, with its terminal set and cap, is the exception)

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

When CI fails (run or pipeline):
1. **STOP** all investigation immediately
2. **READ** the CI error message (`gh run view <run-id> --log-failed`, or the failed job's trace via the GitLab pipeline API)
3. **CLASSIFY** error type (test failure, lint error, type error)
4. **DELEGATE** to appropriate specialist
5. **Continue working** - fix results will auto-deliver, then retry

**Do NOT:**
- Run tests locally to "understand the error"
- Investigate test files to "debug"
- Attempt to fix code yourself
