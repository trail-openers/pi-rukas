# Quality Gates

## Coverage Requirements

| Risk Level | Coverage Required | Examples |
|------------|-------------------|----------|
| Critical | 95%+ | Auth, payments, data deletion, encryption |
| High | 85%+ | User data, APIs, database writes |
| Medium | 80%+ | Internal APIs, services, utilities |
| Low | 70%+ | Documentation, config, formatting |

## Pre-Commit Verification

Before EVERY commit:
- [ ] Linting commands run and ALL passing
- [ ] Pre-commit hooks will pass
- [ ] NOT using --no-verify or bypass flags

**IF ANY CHECK FAILS**: Delegate to fix violations, NEVER bypass

## Adversarial Review Gate

**@developer**: This gate is NOT your responsibility. Return to PM when local checks pass. Do NOT spawn @adversarial-developer.

**@PM** (after developer returns — mandatory):
- Obtain diff via `git diff HEAD` (covers staged and unstaged vs last commit; for pre-push committed work use `git diff main..HEAD`; for parallel worktrees use `git -C worktree-path diff HEAD`)
- Dispatch @adversarial-developer with: diff output, issue number, list of changed files, one-sentence description of what changed
- Wait for APPROVED verdict before dispatching @ops to commit or merge
- If ISSUES_FOUND or CRITICAL_ISSUES_FOUND: send back to @developer to fix, then re-dispatch adversarial (re-dispatch up to 3 times total; if still not APPROVED after 3 re-dispatches, escalate to user)
- @ops does NOT commit or merge/push until adversarial returns APPROVED
- If adversarial task fails (timeout/error): re-dispatch once; if still unavailable, escalate to user before proceeding
- **This gate also applies after any post-code-review developer fixes** — re-dispatch adversarial; @ops does NOT merge until APPROVED

**This gate is MANDATORY** — PM enforces it. Developer returning is the trigger, not the executor.

## Quality Standards

- All tests passing (80%+ coverage for new code)
- All linting passing (no suppressions allowed)
- Type checking passing
- Security scans passing

## Boy Scout Rule

**Every PR must not degrade module quality:**
- Type error count: stable or improved
- Linting violations: stable or improved
- Coverage: stable or improved
- No new suppressions (#noqa, type:ignore, @ts-ignore)

## Forbidden Bypasses

- ❌ `# noqa` - Fix the actual issue
- ❌ `# type: ignore` - Fix the type error
- ❌ `@ts-ignore` - Fix the TypeScript error
- ❌ `eslint-disable` without justification
