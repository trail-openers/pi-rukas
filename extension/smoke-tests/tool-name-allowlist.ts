/**
 * tool-name-allowlist — the commented residue for the #995 tool-name gate.
 *
 * Backticked tokens in `agents-base/` or `modules/` that are NOT Pi or
 * extension tools but legitimately appear in the doctrine. Every entry is a
 * decision with a category comment, not an oversight — the gate's roster
 * (`tool-name-roster.ts`) covers everything that IS a tool, and this file is
 * what is left over.
 *
 * Separated from the roster module because the gate plus its decision record
 * outruns the 500-line file cap.
 *
 * **The admission test is "is this a tool?" — not "does the gate go red?".**
 * A name that any roster source supplies (a Pi builtin, a `pi.registerTool`
 * call, an `agents.json` tool key, an MCP server/tool in the committed doctrine
 * registry) must NOT be listed here: it belongs in the roster, and listing it
 * here also makes this file's own heading false. `allowlistEntriesThatAreRealTools`
 * in `tool-name-roster.ts` returns the overlap and `test-tool-name-surface.ts`
 * asserts it is empty, so the two cannot drift back into disagreement.
 *
 * Adding an entry: name the category, and say which doctrine file names the
 * token and why it is not a tool. An entry with no sentence behind it is the
 * gate being quietly turned off.
 */
export const ALLOWLIST = new Set<string>([
  // --- Role keys from agents.json (named throughout the doctrine)
  "project-manager",
  "developer",
  "ops",
  "explore",
  "code-review-specialist",
  "adversarial-developer",
  // --- Memory types (vipune's closed enum; explore.md + vipune modules)
  "fact",
  "preference",
  "procedure",
  "guard",
  "observation",
  "candidate",
  "active",
  // --- Forge / CI status and field values (ops.md, ci-monitoring.md,
  //     issue-workflow.md, project-manager.md)
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "ci",
  "status",
  "state",
  "opened",
  "closed",
  "number",
  "body",
  "iid",
  "title",
  "description",
  "url",
  "web_url",
  "source_branch",
  "pull_request",
  "created_at",
  "per_page",
  // --- Git verbs, conventional-commit types, and branch names
  //     (git-workflow.md, ops.md, explore.md)
  "main",
  "master",
  "trunk",
  "develop",
  "feat",
  "fix",
  "docs",
  "chore",
  "refactor",
  "test",
  "perf",
  "style",
  "checkout",
  "commit",
  "push",
  "pull",
  "branch",
  "reset",
  "log",
  "tag",
  "show",
  "diff",
  "worktree",
  "stash",
  "config",
  "remote",
  "rev-parse",
  "shortlog",
  "for-each-ref",
  "if",
  // --- CLI binaries and bash subcommand nouns (oo-command-runner.md,
  //     issue-workflow.md, ops.md)
  "gh",
  "glab",
  "git",
  "pr",
  "issue",
  "view",
  "comment",
  "create",
  "close",
  "reopen",
  "update",
  "merge",
  "cd",
  "oo",
  "jq",
  "head",
  "tail",
  "wc",
  "echo",
  "cp",
  "cat",
  "sort",
  "uniq",
  "tee",
  "sed",
  "awk",
  "perl",
  "which",
  "sleep",
  "curl",
  "check",
  "open",
  // --- Prose nouns and generic words (not tools)
  //     (#995 adversarial round: `read`, `write`, `edit`, `list`, `rg`,
  //     `multiedit`, `webfetch`, `websearch`, `question`, `search_code`,
  //     `trace_path`, `detect_changes` were removed from this block — all twelve
  //     are real tools already supplied by a roster source, so keeping them here
  //     was both redundant and a false label on the block.)
  "cwd",
  "base",
  "context",
  "type",
  "file",
  "path",
  "pattern",
  "options",
  "empty",
  "quick",
  "standard",
  "deep",
  "adoption",
  "tier",
  "topic",
  "audit",
  "review",
  "plan",
  "start",
  "do",
  "research",
  "label",
  "ask",
  "restart",
  "skill",
  "allow",
  "deny",
  "ticket",
  "timeout",
  // --- MCP parameter names (NOT tool names): the shape of a codebase-memory
  //     call, named in the doctrine to show which arguments a call takes. The
  //     tool names themselves are in the committed registry,
  //     `tool-name-doctrine-mcp.json`, not here.
  "repo_path",
  "files_only",
  // --- CLI binaries called out by the #995 allow-set (available at runtime).
  //     The tool-shaped aliases `rg`, `multiedit`, `webfetch`, `websearch` are
  //     gone from this block — they are real tools, granted in `agents.json`.
  "ctx7",
  "parallel-cli",
  "ruff",
  "pytest",
  "mypy",
  "vipune",
  // --- Extension / MCP tool names (not `mcp__`-prefixed but the bare name)
  "codebase-memory-mcp",
  "permission-guard",
  "sandbox-fs-guard",
  "oo-rewrite-guard",
  "eslint-disable",
  // --- Workflow / finding value tokens
  "category",
  "finding",
  "recommended-change",
  "blocking",
  "needs-human-attention",
  "include",
  "session_id",
  "session_shutdown",
  "model_change",
  "read_file",
  "blocked_by_challenge",
  "empty-result",
  "credit-exhausted",
  "auth-missing",
  "network-failed",
  "unparseable",
  // --- Skill names that look like tool tokens (gated by
  //     test-skill-name-surface.ts for existence; listed here so the
  //     tool-name gate does not double-report them)
  "shell-scripting",
  "rust-systems",
  "react-web",
  "react-native-mobile",
  "rails-conventions",
  "go-idiomatic",
  "devops-infrastructure",
  "postgres-database",
  "python-tdd",
  "api-design",
  // --- Other legitimate non-tool tokens
  "lantern",
  "awaiting-human-merge",
  "example_db_query",
  "other_db_query",
  // --- codebase-memory MCP tools named by the doctrine but NOT granted to any
  //     role in agents.json. These moved to the committed registry
  //     `tool-name-doctrine-mcp.json` (#995 adversarial round) where each carries
  //     its server and a per-entry reason: they are real tools on the
  //     `codebase_memory` server, and several are named in
  //     `agents-base/developer.md` §Your actual tool surface precisely to FORBID
  //     the call (#1434's "six of them are named in no role prompt anywhere"
  //     row). A gate that called an accurate prohibition a phantom would punish
  //     accurate doctrine — which is the failure #995 is about.
  // --- git sub-verbs the doctrine names as bare tokens (the git-verbs block
  //     above covers the common ones; this is `blame`, named individually in
  //     #1434's tool-surface table as a granted read)
  "blame",
  // --- CLI binaries. "bats" and "shellcheck" are granted bare-runner forms in
  //     `agents-base/developer.md` §Your actual tool surface; "bunx" and "node"
  //     appear there and in project-manager.md to say what the allowlist does
  //     NOT grant — naming an unavailable binary is the point of the sentence,
  //     not a claim that it is a tool.
  "bats",
  "shellcheck",
  "bunx",
  "node",
  // --- Prose nouns introduced by #1434's tool-surface grounding: words the
  //     table and the PM dispatch section set in backticks as a field or a
  //     concept, not as a callable ("the exact `project` name", "`permission` is
  //     a verdict layer, not a roster filter", "a silent `continue`").
  "project",
  "permission",
  "continue",
  // --- vipune CLI subcommands and JSON field names. The #995 allow-set already
  //     admits `vipune` as a CLI binary; these are its verbs and its output
  //     columns, named in the memory modules to state the operator-write
  //     boundary ("never run `vipune update`, `delete`, `prune`, `promote` or
  //     `mcp`") and the /audit panel's columns (vipune-heavy.md).
  "delete",
  "prune",
  "promote",
  "mcp",
  "prune_count",
  "prune_age_days",
  "retrieval_count",
  "last_retrieved_at",
  "memory_type",
  "importance",
]);
