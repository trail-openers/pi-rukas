# oo: Context-Efficient Command Runner

## Mandatory `oo` prefix for verbose runners

These commands ALWAYS use `oo` — no judgment call, no exceptions:

- `oo cargo test`, `oo cargo clippy`, `oo cargo build`, `oo cargo fmt`, `oo cargo check`
- `oo bun test`, `oo bun run build`, `oo bun run typecheck`, `oo bun run lint`
- `oo npm test`, `oo npm run build`, `oo pnpm test`, `oo yarn test` (and equivalents)
- `oo pytest`, `oo uv run pytest`
- `oo ruff`, `oo go test`, `oo cargo nextest`

They produce 50+ lines of output that bloat your context and the dispatch report PM ultimately reads. Bare is wasteful even when allowlisted — `oo` compresses to `✓ cargo test (47 passed)` while preserving failures verbatim. Bare commands that start a line with one of the 12 runners above are silently rewritten to `oo <cmd>` for developer/ops subagents in trust/sandbox mode by the pi-rukas extension (`oo-rewrite-guard`); if you run with `PI_ENSEMBLE_DISABLE_EXTENSION_FORWARD=1` the extension is not forwarded to subagents and that rewrite does not exist — the prefix remains doctrine-only there.

The nuanced "Wrap with oo / Run bare" doctrine below covers everything ELSE — `git status`, `gh issue view`, `glab issue view`, `jq` pipes, single-line reads.

## When to use `oo` (other commands)

`oo` exists to compress *verbose* command output (e.g., `cargo test` printing 50 test names) into a one-line signal. Use it when context-saving is a no-brainer. Do **not** wrap commands whose raw output you actually need to read — that just adds friction without saving tokens.

**Wrap with `oo` (verbose, summarisable, AND you only need the verdict):**
- `oo git log --oneline -10` — multi-line history, summary-friendly
- `oo git diff` / `oo git show` / `oo git shortlog` — multi-line diffs / commit metadata
- `oo git rev-list` / `oo git for-each-ref` — list output
- Verbose test runners and build tools — see the **Mandatory** list above

**Run bare (short OR you need the raw content):**
- `git status` — small change-summary the agent needs to act on
- `git branch --show-current` / `git worktree list` / `git rev-parse HEAD` — one line each
- `git remote -v` / `git tag` / `git config --get user.email` — short reads
- `gh issue view <N>` / `gh issue list --limit N` / `gh search issues …` — the agent needs the *content* (titles, body, URLs); not a "8 issues" summary
- `glab issue view <N>` / `glab issue list --limit N` — same rule on GitLab; the content is the decision input
- `gh api repos/.../issues/N` — when piped to `jq`, oo's indexing path breaks the pipeline (oo replaces the JSON with a recall-hint summary line). Always bare for `gh api | jq` and `glab api | jq` patterns.
- `vipune`, `jq`, `head`, `tail`, `wc` — already context-efficient by design (codebase-memory-mcp tools are MCP, not bash; same principle)

**Why `oo` is wrong for `gh issue …` / `glab issue …`**: oo's "passthrough" tier (≤4 KB) does nothing useful for already-bounded issue queries (either forge). For larger queries (e.g. unlimited `gh issue list` / `glab issue list`), oo's "indexed" tier replaces the output with `(indexed 8 KiB → use 'oo recall')`, forcing a follow-up `oo recall <query>` round-trip that may not surface what the agent needs. PM reads issue bodies and lists to make decisions; substituting a compression summary loses the information the agent's deciding from.

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
- `mcp__codebase_memory__*` MCP tools — indexed code search / structural queries (not bash; see `modules/core/codebase-memory-mcp.md`)
- `jq`, `echo`, `head`, `tail`, `wc`, `sort`, `uniq`, `tee` — text utilities

## No shell chaining — STOPS YOUR WORK

> **Every** chained command interrupts the user with a permission prompt. Each prompt is a context-switch they have to deal with. A chain like `cd /path && cargo build` will **always** prompt — even if `cd *` and `cargo build *` are individually allow-listed — because the matcher can't safely wildcard chained shapes. They burn the user's time and your turn budget. **Don't chain.**

Run each command as a **separate** bash tool call. Do NOT combine multiple commands into one invocation using:

- `&&` / `||` — sequential conditional chains
- `;` — sequential unconditional chains
- `|` — pipes
- `>` / `<` / `>>` — redirects
- `` ` ` `` / `$(…)` — command substitution
- `&` — background / chain
- newline — multi-line scripts

`permission-guard.ts` refuses to wildcard any command containing those characters (anti-injection invariant). The catch-all for unknown bash is `*: ask` — so chained commands open a permission prompt with the full command text visible. The user can approve, but each unique chain shape re-prompts (the cache stores only an exact hash, never a wildcard). **Three unique chains = three prompts.** That's why this rule exists.

### `cd <path> && <cmd>` — the #1 reason agents get prompted

**You are already in the right working directory.** When PM dispatched you, it set your cwd to the worktree (or the project root). You do not need to `cd` before running commands. Calling `cd /Users/janni/projects/foo && cargo build` triggers a prompt the user has to deal with. Calling `cargo build` directly does not. Same outcome, zero friction.

If you genuinely need to operate against a different directory (rare), use the tool's native flag instead of `cd`:

- `git -C /path status` — `git`'s built-in dir flag (bare, no chain)
- `cargo build --manifest-path /path/Cargo.toml` — cargo's manifest flag
- `npm --prefix /path run build` — npm's prefix flag

### Pipelines — split into steps, not chains

If you need to process output, do it in separate steps: run the producer first (output appears in the tool result), then run a follow-up with the value(s) you extracted. The agent layer is the pipeline.

```
# WRONG — `|` triggers a prompt every time
gh pr list --json number,title | jq -r '.[].number'

# RIGHT — bare `gh` returns JSON in the tool result; read it directly
gh pr list --json number,title
```

## Prefer `oo`-wrapped commands

Your allowlist heavily uses `oo` as the canonical wrapper for git / gh / glab / npm / cargo. **Bare `git commit`, `gh pr view`, `glab mr view`, `npm install` are NOT in your allowlist — they will prompt the user.** `oo git commit`, `oo gh pr view`, `oo glab mr view`, `oo npm install` ARE allow-listed and pass through silently. The wrapper does nothing semantically different (oo just compresses verbose output) — the user is the one who allow-listed `oo X` patterns specifically.

Quick reference for the commands most often confused:

| You want to run    | Use this (allow-listed) | Not this (prompts) |
|--------------------|-------------------------|--------------------|
| `git commit -m …`  | `oo git commit -m …`    | `git commit -m …`  |
| `git push origin …`| `oo git push origin …`  | `git push origin …`|
| `git diff HEAD~1`  | `oo git diff HEAD~1`    | `git diff HEAD~1`  |
| `gh pr view 123`   | `oo gh pr view 123` *or* the native `pr` tool if your role has it | `gh pr view 123` |
| `glab mr view 123` | `oo glab mr view 123` *or* the native `pr` tool if your role has it | `glab mr view 123` |
| `gh pr create …`   | `oo gh pr create …`     | `gh pr create …`   |
| `glab mr create …` | `oo glab mr create …`   | `glab mr create …`   |
| `cargo build`      | `oo cargo build`        | `cargo build`      |
| `npm test`         | `oo npm test`           | `npm test`         |

The bare commands that ARE allow-listed (and don't need `oo`): `git status`, `git branch`, `git log --oneline`, `vipune *`, `jq`, `echo`, `head`, `tail`, `wc`, `sort`, `uniq`, `which`, `grep`. Everything else: prefer `oo`.

## Pi's bash tool already captures stderr

There is no reason to add `2>&1` or any stderr redirect to your commands. Pi's bash tool returns both stdout and stderr — the tool result contains everything the command emitted. Adding `2>&1` does nothing useful and will be denied by the anti-injection rule (the `>` character). Just run the command:

```
# WRONG — will be denied
gh issue list --state open 2>&1

# RIGHT — Pi already shows both streams
gh issue list --state open
```

If the command failed and you want to see the error, just look at the tool result you already got. No flag adjustments needed.

## `(no output)` usually means "no matches", not "failure"

When a search / list command (`gh issue list`, `git log`, `grep`, `rg`, `mcp__codebase_memory__search_code`, etc.) returns `(no output)` or an empty result set, the most common cause is that the command succeeded and found nothing matching the query — **not** that the command broke. Don't retry with different flags or invent new query variations to "fix" it. Treat empty output as a legitimate answer:

- `gh issue list --state open` → `(no output)` → there are zero open issues. Done.
- `grep "foo" src/` → `(no output)` → the string "foo" doesn't appear in `src/`. Done.

If you need a deterministic shape for empty results (e.g., to programmatically distinguish "no matches" from "command failed"), prefer the JSON variant where available: `gh issue list --state open --json number,title` returns `[]` for zero matches, which is unambiguously distinct from a failure.

Retrying a command 4 times with permutations to get past `(no output)` is wasted tokens; the first run already told you the answer.

## GitHub Issue Reading Fallback

Use this fallback only when `oo gh issue view` fails with `repository.issue.projectCards` deprecation errors. Do NOT fallback for auth/network/rate limit errors. (GitHub-only — `glab issue view` has no such deprecation failure mode.)

### Single Issue Fallback

To use the fallback command, derive values:
- `{owner}` and `{repo}`: from `git remote get-url origin` (works for both `git@github.com:…` and `git@gitlab.com:…` remote shapes)
- `{number}`: the actual issue number (GitHub) / iid (GitLab) in the error context

```bash
oo gh api repos/{owner}/{repo}/issues/{number} | jq -r '.body'
```

REST endpoint `/repos/{owner}/{repo}/issues/{number}` avoids GraphQL `projectCards` deprecation. Note: This endpoint may return PR data—validate `.pull_request` is absent/null when strict issue-only scope is required. Use `jq -r '.body'` to extract issue body text.

### Multiple Issues Pattern

For multiple issues, use the list endpoint with filtering:

```bash
OWNER_REPO=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/|git@gitlab.com:|https://gitlab.com/)##; s#\.git$##')
oog gh api repos/$OWNER_REPO/issues -f state=open -f per_page=100 | jq -r '.[] | "\(.number): \(.title)"'
```

This avoids `&&` chaining and for-loop+jq pitfalls. Use for listing issues when `oo gh issue list` encounters `projectCards` deprecation errors. The same `OWNER_REPO` derivation feeds `glab` via `glab -R $OWNER_REPO` on GitLab. Note: Glab has no `projectCards` failure mode — on GitLab, `glab issue list --state opened --output json` is the direct equivalent (state values differ: `opened`/`closed`, not `open`/`closed`).

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
