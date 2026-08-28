# CI/CD Monitoring Protocol

## Mandatory Real-Time Monitoring

**ALWAYS use `gh run watch` for live monitoring - NO polling**

Two separate bare tool calls — no variable, no command substitution:

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

## FORBIDDEN Patterns

- ❌ ANY loop calling `gh run list` or `gh run view` repeatedly
- ❌ Manual `sleep` + status check patterns
- ❌ ANY pattern with 5+ consecutive gh run commands

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

When CI fails:
1. **STOP** all investigation immediately
2. **READ** the CI error message from `gh run view`
3. **CLASSIFY** error type (test failure, lint error, type error)
4. **DELEGATE** to appropriate specialist
5. **Continue working** - fix results will auto-deliver, then retry

**Do NOT:**
- Run tests locally to "understand the error"
- Investigate test files to "debug"
- Attempt to fix code yourself
