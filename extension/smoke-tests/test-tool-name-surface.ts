#!/usr/bin/env bun
/**
 * Tool-name surface gate — issue #995.
 *
 * One bidirectional offline gate for the tool-name surface of the doctrine:
 *
 *   A backticked tool-shaped token in agents-base/ or modules/ must name a
 *   tool that actually exists — either a Pi 1.0.0 builtin, a tool the
 *   extension registers (`pi.registerTool`), an `mcp__*` tool, or a name in
 *   the explicit commented ALLOWLIST below.
 *
 *   Conversely, the gate is proven to FAIL: a tmpdir fixture naming a tool
 *   that is in no part of the roster must be reported, and the real repo
 *   must be clean. (test-file-size-limit.ts precedent: a gate never observed
 *   to fail is worthless.)
 *
 * **Why this gate.** Issue #995: `agents-base/developer.md` told developers
 * to load skills via an `mcp_skill` tool, and `agents-base/code-review-
 * specialist.md` / `adversarial-developer.md` named a `skill` tool — neither
 * of which Pi 1.0.0 registers (its tools are bash, edit, find, grep, ls,
 * read, write, powershell). Skills are advertised in <available_skills> and
 * loaded with the `read` tool. No existing gate checked that a doctrine
 * sentence names only real tools: test-skill-name-surface.ts checks SKILL
 * NAMES (and deliberately excludes the backticked `skill` token), and
 * test-pm-tool-permissions.ts checks the reverse direction (registered tools
 * are granted), never that doctrine names only registered tools.
 *
 * **Token shape.** A candidate is a backticked token matching
 * `^[a-z0-9]+([_-][a-z0-9]+)*$` — the same shape test-skill-name-surface.ts
 * uses for skill names, extended to include underscores (so `mcp_skill`,
 * `dispatch_specialist`, and other extension/MCP tool names are caught).
 * Backticked tokens with a space, path, dot, slash, colon, `*`, or `<…>`
 * are not tool names and are skipped entirely. This is what keeps `git
 * status`, `git -C <path>`, `agents.json`, `.pi/decisions.json`,
 * `gh issue view*`, `--output json` out of the scan.
 *
 * **Scan roots.** `agents-base/` and `modules/` only — the sources composed
 * into `dist/prompts/standard/*.md`. `pi-prompts/` is OUT of scope per the
 * #995 operator resolution; if it names phantom tools, that is a follow-up.
 *
 * **The roster.** The known-tool set is the union of:
 *   - PI_BUILTINS — the Pi 1.0.0 builtin tools (data: the `allToolNames` set
 *     in @earendil-works/pi-coding-agent's dist/core/tools/index.d.ts).
 *   - every `pi.registerTool({ name: "…" })` across extension/src (scanned
 *     exactly as test-pm-tool-permissions.ts does), covering both the
 *     main-session dispatch tools and the child companion reporter tools.
 *   - any `mcp__*`-prefixed token (MCP tools, always allowed).
 *   - the ALLOWLIST below.
 *
 * **The allowlist.** An explicit, commented record of every backticked token
 * in agents-base/ or modules/ that is NOT a Pi/extension tool but legitimately
 * appears in the doctrine. Every entry is a decision, not an oversight.
 * Categories: role keys, memory types, forge/CI status & field values, git
 * verbs & commit types & branch names, CLI binaries & subcommand nouns, prose
 * nouns & generic words, MCP method shorthands, legit aliases (rg, ctx7,
 * parallel-cli, …), extension/MCP bare names, workflow/finding value tokens,
 * skill names that look like tool tokens, and other non-tool tokens.
 *
 * **Phantom-tool doctrine.** A backticked token in agents-base/ or modules/
 * that is in no part of the roster is a phantom-tool reference and fails the
 * gate. `mcp_skill` is the canonical case. PI_BUILTINS is version-pinned;
 * a Pi bump that renames a tool must update it here (same doctrine as the
 * "Last verified against" line in docs/pi-compatibility.md).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.resolve(import.meta.dirname, "..", "src");
const SCAN_ROOTS = ["agents-base", "modules"];

/**
 * Pi 1.0.0 builtin tools — the `allToolNames` set (type `ToolName`) in
 * @earendil-works/pi-coding-agent's dist/core/tools/index.d.ts.
 * Data-driven: do not hand-list a different set. A Pi bump that renames a
 * builtin must update this (same doctrine as the version line in
 * docs/pi-compatibility.md).
 */
const PI_BUILTINS = new Set<string>(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

/**
 * Explicit commented allowlist of backticked tokens in agents-base/ or
 * modules/ that are NOT Pi/extension tools but legitimately appear in the
 * doctrine. Every entry is a decision.
 */
const ALLOWLIST = new Set<string>([
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
  "list",
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
  "read",
  "write",
  "edit",
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
  "question",
  "label",
  "ask",
  "restart",
  "skill",
  "allow",
  "deny",
  "ticket",
  "timeout",
  // --- MCP method shorthands (codebase-memory-mcp.md: "search_code,
  //     trace_path, detect_changes, etc. refer to the full tool names
  //     mcp__codebase_memory__search_code, …")
  "search_code",
  "trace_path",
  "detect_changes",
  "repo_path",
  "files_only",
  // --- Legit aliases called out by the #995 allow-set (available at runtime)
  "rg",
  "ctx7",
  "parallel-cli",
  "ruff",
  "pytest",
  "mypy",
  "vipune",
  "multiedit",
  "webfetch",
  "websearch",
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
  "nessie",
  "awaiting-human-merge",
  "fuzu-production-db_query",
  "barona-production-db_query",
]);

const TOKEN = /^[a-z0-9]+([_-][a-z0-9]+)*$/;

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listMarkdownFiles(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Every `pi.registerTool({ name: "…" })` across extension/src — the same
 *  scan test-pm-tool-permissions.ts uses. Covers main-session dispatch tools
 *  AND child companion reporter tools (report_finding, report_policy, …). */
export function registeredToolNames(srcDir: string): Set<string> {
  const registered = new Set<string>();
  let files: string[] = [];
  try {
    files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  } catch {
    return registered;
  }
  for (const f of files) {
    const text = readFileSync(path.join(srcDir, f), "utf8");
    for (const m of text.matchAll(/registerTool\(\{\s*\n?\s*name:\s*"([^"]+)"/g)) {
      registered.add(m[1]);
    }
  }
  return registered;
}

/** The known-tool roster for a tree: Pi builtins + registered tools + allowlist. */
export function knownRoster(srcDir: string): Set<string> {
  const roster = new Set<string>(PI_BUILTINS);
  for (const t of registeredToolNames(srcDir)) roster.add(t);
  for (const t of ALLOWLIST) roster.add(t);
  return roster;
}

export interface ToolNameFailure {
  kind: "phantom";
  token: string;
  file: string;
  line: number;
}

/**
 * Scan one tree for backticked tool-shaped tokens and report any that are in
 * no part of the roster. `mcp__*` tokens are always allowed (MCP tools).
 * The allowlist is the authoritative decision record; a token in no part of
 * the roster is a phantom-tool reference.
 */
export function findPhantomTools(root: string, srcDir: string): ToolNameFailure[] {
  const roster = knownRoster(srcDir);
  const failures: ToolNameFailure[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listMarkdownFiles(path.join(root, scanRoot))) {
      const rel = path.relative(root, file);
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const token of line.matchAll(/`([^`]+)`/g)) {
          const t = token[1];
          if (!TOKEN.test(t)) continue; // not a tool-shaped token
          if (t.startsWith("mcp__")) continue; // MCP tool, always allowed
          if (roster.has(t)) continue; // in the known roster
          failures.push({ kind: "phantom", token: t, file: rel, line: i + 1 });
        }
      }
    }
  }
  // De-dupe (a token may repeat across lines); keep first occurrence.
  const seen = new Set<string>();
  const unique: ToolNameFailure[] = [];
  for (const f of failures) {
    const key = `${f.file}:${f.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  return unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- the gate CAN fail

{
  // A fixture tree naming a tool in no part of the roster must be reported,
  // and a clean tree must not be. This proves the gate is not vacuous.
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-toolname-"));
  const srcDir = mkdtempSync(path.join(tmpdir(), "pi-ens-toolname-src-"));
  try {
    mkdirSync(path.join(fixtureRoot, "agents-base"));
    mkdirSync(path.join(fixtureRoot, "modules"));
    // A src dir with one registered tool so the roster includes it. The name
    // uses an underscore to match the real-world pattern (agents_md_run, etc.).
    writeFileSync(path.join(srcDir, "reg.ts"), 'pi.registerTool({\n  name: "real_tool"\n});\n');
    // A clean file: Pi builtin + a registered tool + an mcp__ tool + an allowlisted alias.
    writeFileSync(
      path.join(fixtureRoot, "agents-base", "clean.md"),
      [
        "Use the `read` tool to load skills.",
        "Call the `real_tool` tool to dispatch.",
        "Search via `mcp__codebase_memory__search_code`.",
        "Find code with the `rg` tool.",
        "Memory types are a closed enum: `fact`, `guard`, `observation`.",
        "The pipeline is `success` or `failed`.",
        "",
      ].join("\n"),
    );
    // A phantom file: names tools that exist in no part of the roster.
    writeFileSync(
      path.join(fixtureRoot, "modules", "phantom.md"),
      [
        "Load domain-specific skills via `mcp_skill` tool.",
        "Use the `totally_bogus_tool` here.",
        "Invoke `weirdphantom` to list skills.",
        "",
      ].join("\n"),
    );
    const failures = findPhantomTools(fixtureRoot, srcDir);
    const tokens = failures.map((f) => f.token).sort();
    assert(failures.some((f) => f.token === "mcp_skill"), `canary: phantom \`mcp_skill\` IS reported (got [${tokens.join(", ")}])`);
    assert(failures.some((f) => f.token === "totally_bogus_tool"), "canary: phantom `totally_bogus_tool` IS reported");
    assert(failures.some((f) => f.token === "weirdphantom"), "canary: phantom `weirdphantom` IS reported");
    assert(!failures.some((f) => f.token === "read"), "canary: Pi builtin `read` is NOT reported");
    assert(!failures.some((f) => f.token === "real_tool"), "canary: registered `real_tool` is NOT reported");
    assert(!failures.some((f) => f.token === "rg"), "canary: allowlisted alias `rg` is NOT reported");
    assert(!failures.some((f) => f.token === "fact"), "canary: memory-type `fact` is NOT reported (allowlisted)");
    assert(!failures.some((f) => f.token === "success"), "canary: status value `success` is NOT reported (allowlisted)");
    assert(!tokens.includes("mcp__codebase_memory__search_code"), "canary: mcp__* token is not tool-shaped (skipped)");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- and the repo is clean

const repoPhantoms = findPhantomTools(REPO_ROOT, SRC);
const roster = knownRoster(SRC);
const registered = [...registeredToolNames(SRC)].sort();
console.log(`  roster: ${roster.size} known tools (${PI_BUILTINS.size} Pi builtins, ${registered.length} registered, ${ALLOWLIST.size} allowlisted)`);
console.log(`  registered tools: ${registered.join(", ")}`);

if (repoPhantoms.length === 0) {
  assert(true, "every backticked tool-shaped token in agents-base/ + modules/ resolves against the roster (no phantom tools)");
} else {
  for (const f of repoPhantoms) {
    assert(false, `phantom tool \`${f.token}\` in ${f.file}:${f.line} — not in the known roster`);
  }
}

console.log(exit === 0 ? "\nAll tool-name-surface checks passed." : "\nFAILED");
process.exit(exit);
