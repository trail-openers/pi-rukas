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
 *      `mcp__<server>__<tool>` key, plus the committed in-tree registry
 *      `tool-name-doctrine-mcp.json`. The doctrine names one MCP tool at a time
 *      by its short name (`search_code`, `trace_path`), which is accurate and
 *      would otherwise fail.
 *
 * **The roster is host-independent — this is load-bearing, not incidental.**
 * An earlier revision read `$PI_AGENT_DIR/mcp.json` (falling back to
 * `~/.pi/agent/mcp.json`) as a fifth source, so CI with no user Pi config and a
 * laptop with one produced different verdicts on identical doctrine. Every input
 * now lives in the repo: `extension/src`, `agents.json`, in-tree `.pi/mcp.json`,
 * and the committed doctrine MCP registry. `knownRoster` reads nothing under
 * HOME; `test-tool-name-surface.ts` asserts it by pointing `PI_AGENT_DIR` at an
 * empty temp dir and requiring a byte-identical roster. A new roster source
 * outside the checkout has to be refused by that assertion before it is added.
 *
 * `ALLOWLIST` is the residue: backticked tokens that are not tools at all —
 * role keys, enum values, git verbs, CLI binaries, prose nouns. Every entry is
 * a decision with a category comment, not an oversight. A name that IS a real
 * tool belongs in a roster source, never here — the gate reports the overlap
 * (`allowlistEntriesThatAreRealTools`) rather than letting the two drift apart.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ALLOWLIST } from "./tool-name-allowlist.ts";

/** Re-exported so a caller reads one surface for the gate's decision record. */
export { ALLOWLIST };

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.resolve(import.meta.dirname, "..", "src");
const MCP_JSON = path.resolve(REPO_ROOT, ".pi", "mcp.json");

/** Committed in-tree registry of the MCP tools the doctrine relies on. See the
 *  `_comment` in the file itself for why this replaces the per-user mcp.json leg. */
export const DOCTRINE_MCP_JSON = path.resolve(import.meta.dirname, "tool-name-doctrine-mcp.json");

/** Where the tool keys that make a name "granted" live. */
export const AGENTS_JSON = path.resolve(REPO_ROOT, "agents.json");

/** The MCP configs the gate reads — both inside the checkout.
 *
 *  There is deliberately NO `$PI_AGENT_DIR` / `~/.pi/agent/mcp.json` leg here.
 *  Production resolves the child's MCP config that way (`spawn-support.ts`), but
 *  a *gate* may not: the per-user file differs between CI and a laptop, so the
 *  same doctrine would pass on one machine and fail on the other. Anything the
 *  doctrine names goes in `DOCTRINE_MCP_JSON` instead, where a reviewer sees it. */
export function mcpConfigCandidates(): string[] {
  return [MCP_JSON, DOCTRINE_MCP_JSON];
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

/** A roster source that could not be read or parsed. Surfaced rather than
 *  swallowed: `grantedToolNames` used to return an empty set on malformed
 *  `agents.json`, which the gate read as "nothing is granted" — every doctrine
 *  sentence naming a real tool then went red as a phantom, or (worse, on a
 *  partially-broken map) silently went green. A broken roster is a broken gate,
 *  and a gate that cannot tell the difference is not a gate. */
export class RosterSourceError extends Error {
  public readonly source: string;
  public readonly cause_: string;

  constructor(source: string, reason: string) {
    super(`tool-name gate: roster source ${source} is unusable (${reason})`);
    this.name = "RosterSourceError";
    this.source = source;
    this.cause_ = reason;
  }
}

/** Shared read of the permission maps. Absent file → undefined (a caller that
 *  passes an explicit path with no file is exercising the fixture shape and is
 *  allowed silence). Unreadable-but-present, or present-and-malformed → throws
 *  `RosterSourceError`, because that is a repo in a state the gate cannot read. */
function parseAgentPermissions(
  agentsPath: string,
): Record<string, { permission?: Record<string, unknown> }> | undefined {
  let raw: string;
  try {
    raw = readFileSync(agentsPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new RosterSourceError(agentsPath, `unreadable: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RosterSourceError(agentsPath, `malformed JSON: ${(err as Error).message}`);
  }
  const agent = (parsed as { agent?: unknown })?.agent;
  if (agent === undefined) {
    throw new RosterSourceError(agentsPath, 'parsed but has no "agent" object');
  }
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) {
    throw new RosterSourceError(agentsPath, '"agent" is not an object');
  }
  return agent as Record<string, { permission?: Record<string, unknown> }>;
}

/** Every tool KEY any role's permission map in agents.json names.
 *
 *  A name in a permission map is a tool the harness resolves at runtime — the
 *  existence question this gate asks. `mcp__*` keys are skipped (handled by
 *  `mcpToolNames`), and so is anything that is not a single token: a bash
 *  subcommand allowlist entry (`"gh issue create*"`, `"vipune search *"`) is a
 *  command pattern, never a tool name.
 *
 *  An unreadable or malformed file throws `RosterSourceError` — see there. */
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
 *  known to the harness: the keys of the permission maps, the servers declared
 *  in an in-tree `.pi/mcp.json` when the clone keeps one there, and every entry
 *  of the committed `tool-name-doctrine-mcp.json`.
 *
 *  The doctrine names one MCP tool at a time by its SHORT name — `search_code`,
 *  `get_architecture`, `trace_path` — which is how
 *  `modules/core/codebase-memory-mcp.md` documents the shorthand. Requiring the
 *  full `mcp__…__…` spelling in prose would make accurate doctrine fail. So a
 *  bare `<tool>` / `<server>` is known once a server actually publishes it; the
 *  claim is checked against the server, not waved through by an allowlist entry.
 *
 *  A doctrine registry that is present but malformed or badly shaped throws —
 *  a truncated registry silently shrinks the roster and produces phantom
 *  failures nobody can attribute. A missing path in `mcpConfigPaths` is silence:
 *  in-tree `.pi/mcp.json` is optional by design. */
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
    let raw: string;
    try {
      raw = readFileSync(mcpConfigPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // optional source
      throw new RosterSourceError(mcpConfigPath, `unreadable: ${(err as Error).message}`);
    }
    let parsed: { mcpServers?: unknown; servers?: unknown };
    try {
      parsed = JSON.parse(raw) as { mcpServers?: unknown; servers?: unknown };
    } catch (err) {
      throw new RosterSourceError(mcpConfigPath, `malformed JSON: ${(err as Error).message}`);
    }
    const declared = parsed?.mcpServers;
    if (declared !== undefined && declared !== null) {
      if (typeof declared !== "object" || Array.isArray(declared)) {
        throw new RosterSourceError(mcpConfigPath, '"mcpServers" is not an object');
      }
      for (const server of Object.keys(declared as Record<string, unknown>)) servers.add(server);
    }
    // The doctrine registry shape: { servers: [{ server, tools: [{ name, reason }] }] }
    const registry = parsed?.servers;
    if (registry !== undefined) {
      if (!Array.isArray(registry)) {
        throw new RosterSourceError(mcpConfigPath, '"servers" is not an array');
      }
      for (const entry of registry as Array<{ server?: unknown; tools?: unknown }>) {
        const server = entry?.server;
        if (typeof server !== "string" || !server) {
          throw new RosterSourceError(mcpConfigPath, 'a servers[] entry has no "server" string');
        }
        servers.add(server);
        const tools = entry?.tools;
        if (!Array.isArray(tools)) {
          throw new RosterSourceError(mcpConfigPath, `server "${server}" has no tools[] array`);
        }
        for (const tool of tools as Array<{ name?: unknown; reason?: unknown }>) {
          const name = tool?.name;
          if (typeof name !== "string" || !name) {
            throw new RosterSourceError(
              mcpConfigPath,
              `server "${server}" has a tools[] entry with no "name" string`,
            );
          }
          if (typeof tool?.reason !== "string" || !tool.reason.trim()) {
            throw new RosterSourceError(
              mcpConfigPath,
              `server "${server}" tool "${name}" has no reason — an entry with no sentence behind it is the gate being quietly turned off`,
            );
          }
          names.add(name);
        }
      }
    }
  }
  for (const s of servers) names.add(s);
  return names;
}

/** The known-tool roster: Pi builtins + registered tools + agents.json tool
 *  keys + MCP server/tool names + the commented allowlist. Every input is inside
 *  the checkout — see the module header for why that is load-bearing. */
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

/** Names sitting in `ALLOWLIST` that a roster source already supplies.
 *
 *  The allowlist block is labelled "not tools"; when an entry there is also a
 *  real tool the label is a lie and the roster is no longer the single record of
 *  what exists. `test-tool-name-surface.ts` asserts this set is empty so the two
 *  cannot drift back into disagreement. */
export function allowlistEntriesThatAreRealTools(
  srcDir: string = SRC,
  agentsPath: string = AGENTS_JSON,
  mcpConfigPaths: string[] = mcpConfigCandidates(),
): string[] {
  const realTools = new Set<string>(PI_BUILTINS);
  for (const t of registeredToolNames(srcDir)) realTools.add(t);
  for (const t of grantedToolNames(agentsPath)) realTools.add(t);
  for (const t of mcpToolNames(agentsPath, mcpConfigPaths)) realTools.add(t);
  return [...ALLOWLIST].filter((t) => realTools.has(t)).sort();
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
export const GATE_PATHS = {
  REPO_ROOT,
  SRC,
  AGENTS_JSON,
  MCP_JSON,
  DOCTRINE_MCP_JSON,
} as const;
