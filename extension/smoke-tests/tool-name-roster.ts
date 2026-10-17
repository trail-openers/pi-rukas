/**
 * tool-name-roster — the known-tool roster and the phantom-tool scanner behind
 * `test-tool-name-surface.ts` (issue #995). Split out because the gate plus its
 * commented allowlist outruns the 500-line file cap; the test file keeps the
 * assertions and the anti-vacuity fixture.
 *
 * The question this answers is narrow: **does a backticked tool-shaped token in
 * the doctrine name a tool that exists anywhere in the harness?** It is not a
 * question about whether a *role* may call it — `agents.json` answers that, and
 * `test-pm-tool-permissions.ts` / `test-interactive-permissions-agents.ts` own
 * the grant direction.
 *
 * Four sources make a name "known":
 *
 *   1. `PI_BUILTINS` — the 8 tools Pi registers (`allToolNames`).
 *   2. `registeredToolNames` — every `pi.registerTool({ name })` in
 *      extension/src, the main-session dispatch tools and the child companion
 *      reporters alike.
 *   3. `grantedToolNames` — every tool KEY any role's permission map names.
 *      #1434 grounded the role prompts in "what the runtime grants", which
 *      means naming tools — including ones a role must never call, named so the
 *      prompt can forbid them. A gate blind to the permission map would call
 *      that doctrine a phantom.
 *   4. `mcpToolNames` — the bare server and tool names behind every
 *      `mcp__<server>__<tool>` key. The doctrine names one MCP tool at a time
 *      by its short name (`search_code`, `trace_path`), which is accurate and
 *      would otherwise fail.
 *
 * `ALLOWLIST` is the residue: backticked tokens that are not tools at all —
 * role keys, enum values, git verbs, CLI binaries, prose nouns. Every entry is
 * a decision with a category comment, not an oversight.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWLIST } from "./tool-name-allowlist.ts";

/** Re-exported so a caller reads one surface for the gate's decision record. */
export { ALLOWLIST };

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.resolve(import.meta.dirname, "..", "src");
const MCP_JSON = path.resolve(REPO_ROOT, ".pi", "mcp.json");

/** Where the tool keys that make a name "granted" live. */
export const AGENTS_JSON = path.resolve(REPO_ROOT, "agents.json");

/** Candidate locations for Pi's MCP config, tried in order. A clone keeps its
 *  own at `.pi/mcp.json`; the shared per-user one lives under
 *  `$PI_AGENT_DIR` / `~/.pi/agent` — the same lookup `spawn-extension-forward.ts`
 *  and `spawn-support.ts` use for installed extensions, so the gate reads what
 *  the child actually spawns with. */
export function mcpConfigCandidates(): string[] {
  const piAgentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return [MCP_JSON, path.join(piAgentDir, "mcp.json")];
}

/** The prompt sources the gate scans — the inputs to `dist/prompts/standard/*.md`.
 * `pi-prompts/` is OUT of scope per the #995 operator resolution. */
export const SCAN_ROOTS = ["agents-base", "modules"];

/**
 * Pi's builtin tools — the `allToolNames` set (type `ToolName`) in
 * @earendil-works/pi-coding-agent's dist/core/tools/index.d.ts.
 * Data: read the pinned package rather than hand-listing a different set. A Pi
 * bump that renames a builtin must update this (same doctrine as the "Last
 * verified against" line in docs/pi-compatibility.md).
 */
export const PI_BUILTINS = new Set<string>([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/** A backticked token only competes as a tool name when it looks like one:
 * lowercase words joined by single `_` / `-`. Anything with a space, path, dot,
 * slash, colon, `*` or `<…>` is skipped — which is what keeps `git status`,
 * `git -C <path>`, `agents.json`, `.pi/decisions.json`, `gh issue view*` and
 * `--output json` out of the scan entirely. */
export const TOKEN = /^[a-z0-9]+([_-][a-z0-9]+)*$/;

/** Markdown files under `dir`, recursively. A missing dir is no files, not an error. */
export function listMarkdownFiles(dir: string): string[] {
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

/** Every `pi.registerTool({ name: "…" })` across extension/src — the same scan
 *  `test-pm-tool-permissions.ts` uses. Covers the main-session dispatch tools
 *  AND the child companion reporters (report_finding, report_policy, …). */
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
      registered.add(m[1] as string);
    }
  }
  return registered;
}

/** Every tool KEY any role's permission map in agents.json names.
 *
 *  A name in a permission map is a tool the harness resolves at runtime — the
 *  existence question this gate asks. `mcp__*` keys are skipped (handled by
 *  `mcpToolNames`), and so is anything that is not a single token: a bash
 *  subcommand allowlist entry (`"gh issue create*"`, `"vipune search *"`) is a
 *  command pattern, never a tool name.
 *
 *  Unreadable or malformed JSON yields the empty set, exactly as the fixture
 *  shape needs — a missing roster source must not read as "nothing is known". */
export function grantedToolNames(agentsPath: string = AGENTS_JSON): Set<string> {
  const granted = new Set<string>();
  const agent = parseAgentPermissions(agentsPath);
  if (!agent) return granted;
  for (const role of Object.values(agent)) {
    const perm = role?.permission;
    if (!perm || typeof perm !== "object") continue;
    for (const key of Object.keys(perm as Record<string, unknown>)) {
      if (key === "*" || key.startsWith("mcp__")) continue;
      if (!TOKEN.test(key)) continue; // bash subcommand pattern, not a tool
      granted.add(key);
    }
  }
  return granted;
}

/** The server and bare tool names behind every `mcp__<server>__<tool>` name
 *  known to the harness: the keys of the permission maps, and the servers
 *  declared in an in-tree `.pi/mcp.json` when the clone keeps one there.
 *
 *  The doctrine names one MCP tool at a time by its SHORT name — `search_code`,
 *  `get_architecture`, `trace_path` — which is how
 *  `modules/core/codebase-memory-mcp.md` documents the shorthand. Requiring the
 *  full `mcp__…__…` spelling in prose would make accurate doctrine fail. So a
 *  bare `<tool>` / `<server>` is known once a server actually publishes it; the
 *  claim is checked against the server, not waved through by an allowlist entry. */
export function mcpToolNames(
  agentsPath: string = AGENTS_JSON,
  mcpConfigPaths: string[] = mcpConfigCandidates(),
): Set<string> {
  const names = new Set<string>();
  const servers = new Set<string>();
  const addKey = (key: string): void => {
    if (!key.startsWith("mcp__")) return;
    const parts = key.split("__");
    if (parts.length < 3) return;
    const server = parts[1];
    const toolName = parts.slice(2).join("__");
    if (server) servers.add(server);
    if (toolName) names.add(toolName);
  };
  const agent = parseAgentPermissions(agentsPath);
  for (const role of Object.values(agent ?? {})) {
    for (const key of Object.keys(role?.permission ?? {})) addKey(key);
  }
  for (const mcpConfigPath of mcpConfigPaths) {
    try {
      const parsed = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      for (const server of Object.keys(parsed?.mcpServers ?? {})) servers.add(server);
    } catch {
      /* no mcp.json at this location — the permission-map keys still carried what they carry */
    }
  }
  for (const s of servers) names.add(s);
  return names;
}

/** Shared read of the permission maps; undefined when the file is absent or
 *  malformed — every caller treats a missing roster source as silence, not failure. */
function parseAgentPermissions(
  agentsPath: string,
): Record<string, { permission?: Record<string, unknown> }> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(agentsPath, "utf8")) as {
      agent?: Record<string, { permission?: Record<string, unknown> }>;
    };
    return parsed?.agent;
  } catch {
    return undefined;
  }
}

/** The known-tool roster: Pi builtins + registered tools + agents.json tool
 *  keys + MCP server/tool names + the commented allowlist. */
export function knownRoster(
  srcDir: string = SRC,
  agentsPath: string = AGENTS_JSON,
  mcpConfigPaths: string[] = mcpConfigCandidates(),
): Set<string> {
  const roster = new Set<string>(PI_BUILTINS);
  for (const t of registeredToolNames(srcDir)) roster.add(t);
  for (const t of grantedToolNames(agentsPath)) roster.add(t);
  for (const t of mcpToolNames(agentsPath, mcpConfigPaths)) roster.add(t);
  for (const t of ALLOWLIST) roster.add(t);
  return roster;
}

export interface ToolNameFailure {
  kind: "phantom";
  token: string;
  file: string;
  line: number;
}

/** Scan one tree for backticked tool-shaped tokens naming a tool that is in no
 *  part of the roster. De-duped per file+token, sorted by file then line. */
export function findPhantomTools(
  root: string,
  srcDir: string = SRC,
  agentsPath: string = AGENTS_JSON,
  mcpConfigPaths: string[] = mcpConfigCandidates(),
): ToolNameFailure[] {
  const roster = knownRoster(srcDir, agentsPath, mcpConfigPaths);
  const failures: ToolNameFailure[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listMarkdownFiles(path.join(root, scanRoot))) {
      const rel = path.relative(root, file);
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const token of (lines[i] ?? "").matchAll(/`([^`]+)`/g)) {
          const t = token[1] as string;
          if (!TOKEN.test(t)) continue; // not a tool-shaped token
          if (t.startsWith("mcp__")) continue; // MCP tool, always allowed
          if (roster.has(t)) continue; // in the known roster
          failures.push({ kind: "phantom", token: t, file: rel, line: i + 1 });
        }
      }
    }
  }
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

/** The defaults the test's repo-wide scan runs against. */
export const GATE_PATHS = { REPO_ROOT, SRC, AGENTS_JSON, MCP_JSON } as const;
