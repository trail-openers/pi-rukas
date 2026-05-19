# oo: Context-Efficient Command Runner

## Mandatory Usage

All git and gh commands MUST be prefixed with `oo`. This compresses output to save context tokens.

**Examples:**
- `oo git status` instead of `git status`
- `oo git log --oneline -10` instead of `git log --oneline -10`
- `oo gh issue list --limit 10` instead of `gh issue list --limit 10`

## Output Behavior

oo classifies command output into 4 tiers:
1. **Passthrough** — Small output (≤4 KB) passes through unchanged
2. **Success** — Known commands get compressed: `✓ git log (10 commits)`
3. **Failure** — Failed commands show filtered error output: `✗ command (error details)`
4. **Large** — Unrecognized large output is indexed for later retrieval

## Searching Indexed Output

When oo indexes large output, use `oo recall` to search it:
```
oo recall "search terms"
```

This performs full-text search over all indexed output from the current session.

## Command Reference

Use `oo help` instead of `--help` for token-efficient command documentation:
```
oo help git-rebase
oo help gh-pr-create
```

## Additional Commands

### oo patterns

Lists all learned output compression patterns. Shows each pattern's command_match regex and whether it has success/failure handling. Use to verify what patterns exist before running `oo learn`.

### oo learn

```
oo learn cmd args...
```

Runs a command and spawns a background LLM call to auto-generate an output compression pattern. Use when encountering a new command type whose output isn't being compressed. Pattern saved to `~/.config/oo/patterns/`. Shows provider being used: `learning pattern for "X" (cerebras)`. Confirms on next oo invocation: `oo: learned pattern for X → path`.

### oo forget

```
oo forget
```

Clears all indexed output for the current session. Use at session start for a clean slate, or when indexed data is stale.

### oo init

```
oo init
```

Generates hook configuration and prints AGENTS.md snippet. Run once per project. Use `--format generic` for non-Claude-Code frameworks (prints instructions only, no files created). Default is `--format claude`.

### oo version

```
oo version
```

Shows oo version. Use to verify installation.

## Commands NOT Using oo

These tools are already context-efficient and run without the `oo` prefix:
- `vipune` — project memory (search/store)
- `colgrep` — semantic code search
- `jq`, `echo`, `head`, `tail`, `wc`, `sort`, `uniq`, `tee` — text utilities

## GitHub Issue Reading Fallback

Use this fallback only when `oo gh issue view` fails with `repository.issue.projectCards` deprecation errors. Do NOT fallback for auth/network/rate limit errors.

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

## Piping `oo gh api` to `jq`

`oo` indexes responses larger than 4 KB instead of passing them through. When `oo gh api` output is piped to `jq`, large responses produce a summary line (e.g. `● gh (indexed 144 KiB → use 'oo recall' to query)`) instead of JSON, breaking the pipeline.

**Solutions:**

1. **Use pagination** to keep responses under 4 KB:
   ```bash
   oo gh api repos/{owner}/{repo}/issues --method GET -f per_page=10 -f state=open | jq -r '.[].title'
   ```

2. **Use `oo recall`** to search already-indexed output:
   ```bash
   oo gh api repos/{owner}/{repo}/issues --method GET
   oo recall "open issues title"
   ```

3. **Prefer native tools** (`issue`, `pr`, `ci`) which handle pagination automatically.

Note: `--method GET` is required when passing `-f` query params — without it, `gh api` sends them as POST body fields instead.
