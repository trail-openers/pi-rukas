# Git Workflow Standards

## SSH-Only GitHub Access

- **ALWAYS use SSH protocol**: `git@github.com:user/repo.git`
- **NEVER use HTTPS**: No `https://github.com` URLs for git operations
- Use `gh` CLI exclusively for GitHub interactions

## Branch Strategy

**Branch Naming Convention:**
- Features: `feature/issue-{NUMBER}-brief-description`
- Fixes: `fix/issue-{NUMBER}-brief-description`
- Docs: `docs/issue-{NUMBER}-brief-description`

**Branch Enforcement Rules:**
- ❌ NEVER allow commits to main/master branch
- ❌ NEVER allow pushes to main/master branch
- ✅ ALL work must be on feature branches
- ✅ Auto-switch to feature branch when main branch detected

## Commit Standards

**Conventional Commits:**
- `feat`: new features
- `fix`: bug fixes
- `docs`: documentation changes
- `refactor`: code restructuring
- `test`: test additions/modifications
- `chore`: maintenance tasks
- `perf`: performance improvements
- `style`: formatting changes

**Commit Message Format:**
```
feat(#123): add user authentication

Detailed description if needed.
```

**Commit Frequency:**
- Commits every 2-3 logical changes
- Each commit must be atomic and testable
- Push to remote frequently to keep CI green
- NEVER accumulate hundreds of uncommitted changes

## Pre-Commit Requirements

- ❌ NEVER use `git commit --no-verify` or `-n`
- ❌ NEVER skip pre-commit hooks
- Fix ALL violations before committing

## Single-User Environment

This OpenCode setup uses ONE gh CLI user for all operations:
- Same user creates PRs, reviews code, and merges
- `gh pr review --approve` works normally
- `gh pr merge` works normally
- No approval "sync" delays
