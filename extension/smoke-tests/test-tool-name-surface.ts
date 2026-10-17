#!/usr/bin/env bun
/**
 * Tool-name surface gate — issue #995.
 *
 * One bidirectional offline gate for the tool-name surface of the doctrine:
 *
 *   A backticked tool-shaped token in agents-base/ or modules/ must name a
 *   tool that actually exists — a Pi builtin, a tool the extension registers
 *   (`pi.registerTool`), a tool key any role's `agents.json` permission map
 *   names, an `mcp__*` tool, or a name in the commented ALLOWLIST. The roster
 *   itself and the scanner live in `tool-name-roster.ts` (the 500-line cap);
 *   this file is the assertions and the anti-vacuity fixture.
 *
 *   Conversely, the gate is proven to FAIL: a tmpdir fixture naming a tool
 *   that is in no part of the roster must be reported, and the real repo must
 *   be clean. (test-file-size-limit.ts precedent: a gate never observed to
 *   fail is worthless.)
 *
 * **Why this gate.** Issue #995: `agents-base/developer.md` told developers to
 * load skills via an `mcp_skill` tool, and `agents-base/code-review-specialist.md`
 * / `adversarial-developer.md` named a `skill` tool — neither of which Pi
 * registers (its tools are bash, edit, find, grep, ls, read, write, powershell).
 * Skills are advertised in <available_skills> and loaded with the `read` tool.
 * No existing gate checked that a doctrine sentence names only real tools:
 * test-skill-name-surface.ts checks SKILL NAMES (and deliberately excluded the
 * backticked `skill` token), and test-pm-tool-permissions.ts checks the reverse
 * direction (registered tools are granted), never that doctrine names only
 * registered tools.
 *
 * **Token shape.** A candidate is a backticked token matching
 * `^[a-z0-9]+([_-][a-z0-9]+)*$` — the shape test-skill-name-surface.ts uses for
 * skill names, extended with underscores so `mcp_skill`, `dispatch_specialist`
 * and other extension/MCP tool names are caught. Tokens with a space, path,
 * dot, slash, colon, `*` or `<…>` are not tool names and are skipped, which is
 * what keeps `git status`, `git -C <path>`, `agents.json`, `.pi/decisions.json`,
 * `gh issue view*` and `--output json` out of the scan.
 *
 * **Scan roots.** `agents-base/` and `modules/` only — the sources composed
 * into `dist/prompts/standard/*.md`. `pi-prompts/` is OUT of scope per the #995
 * operator resolution; if it names phantom tools, that is a follow-up.
 *
 * **Phantom-tool doctrine.** A backticked token in agents-base/ or modules/ in
 * no part of the roster is a phantom-tool reference and fails the gate.
 * `mcp_skill` is the canonical case. PI_BUILTINS is version-pinned; a Pi bump
 * that renames a tool must update it (same doctrine as the "Last verified
 * against" line in docs/pi-compatibility.md).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENTS_JSON,
  ALLOWLIST,
  GATE_PATHS,
  PI_BUILTINS,
  findPhantomTools,
  grantedToolNames,
  knownRoster,
  mcpToolNames,
  registeredToolNames,
} from "./tool-name-roster.ts";

const { REPO_ROOT, SRC } = GATE_PATHS;

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
  const agentsDir = mkdtempSync(path.join(tmpdir(), "pi-ens-toolname-agents-"));
  const agentsFile = path.join(agentsDir, "agents.json");
  try {
    mkdirSync(path.join(fixtureRoot, "agents-base"));
    mkdirSync(path.join(fixtureRoot, "modules"));
    // A src dir with one registered tool so the roster includes it. The name
    // uses an underscore to match the real-world pattern (agents_md_run, etc.).
    writeFileSync(path.join(srcDir, "reg.ts"), 'pi.registerTool({\n  name: "real_tool"\n});\n');
    // A permission map with one granted tool that NO registerTool call declares —
    // the shape of the codebase-memory names #1434 grounds the developer prompt
    // in. `mcp__srv__short_tool` makes BOTH `srv` and `short_tool` known, which is
    // how the doctrine names one MCP tool at a time. A bash subcommand key must
    // NOT become a tool name.
    writeFileSync(
      agentsFile,
      JSON.stringify({
        agent: {
          developer: {
            permission: {
              "*": "ask",
              granted_tool: "allow",
              mcp__some__call: "allow",
              mcp__srv__short_tool: "allow",
              "gh issue create*": "deny",
            },
          },
        },
      }),
    );
    // A clean file: Pi builtin + registered tool + granted key + MCP shorthand +
    // an allowlisted alias + allowlisted enum/status values.
    writeFileSync(
      path.join(fixtureRoot, "agents-base", "clean.md"),
      [
        "Use the `read` tool to load skills.",
        "Call the `real_tool` tool to dispatch.",
        "Search via `mcp__codebase_memory__search_code`.",
        "Find code with the `rg` tool.",
        "Call `granted_tool` — a name the runtime map grants.",
        "Call the `short_tool` tool on the `srv` server by its bare names.",
        "Memory types are a closed enum: `fact`, `guard`, `observation`.",
        "The pipeline is `success` or `failed`.",
        "",
      ].join("\n"),
    );
    // A phantom file: names tools that exist in no part of the roster.
    // `no_such_index_tool` is the sharp one — a codebase-memory-SHAPED name that
    // no server publishes and no role grants. Naming a tool nobody grants must
    // not pass, which is what keeps the granted roster from being a rubber stamp.
    writeFileSync(
      path.join(fixtureRoot, "modules", "phantom.md"),
      [
        "Load domain-specific skills via `mcp_skill` tool.",
        "Use the `totally_bogus_tool` here.",
        "Invoke `weirdphantom` to list skills.",
        "Never call `no_such_index_tool`.",
        "",
      ].join("\n"),
    );
    const failures = findPhantomTools(fixtureRoot, srcDir, agentsFile, []);
    const tokens = failures.map((f) => f.token).sort();
    const has = (t: string): boolean => failures.some((f) => f.token === t);
    assert(
      has("mcp_skill"),
      `canary: phantom \`mcp_skill\` IS reported (got [${tokens.join(", ")}])`,
    );
    assert(has("totally_bogus_tool"), "canary: phantom `totally_bogus_tool` IS reported");
    assert(has("weirdphantom"), "canary: phantom `weirdphantom` IS reported");
    assert(!has("read"), "canary: Pi builtin `read` is NOT reported");
    assert(!has("real_tool"), "canary: registered `real_tool` is NOT reported");
    assert(!has("rg"), "canary: allowlisted alias `rg` is NOT reported");
    assert(!has("fact"), "canary: memory-type `fact` is NOT reported (allowlisted)");
    assert(
      !has("granted_tool"),
      "canary: a tool key granted in agents.json is NOT reported (roster source #1434)",
    );
    assert(
      !has("short_tool") && !has("srv"),
      "canary: an MCP tool's bare tool name and server name are known from the mcp__<server>__<tool> key",
    );
    assert(
      has("no_such_index_tool"),
      "canary: an MCP-shaped name granted to NO role and published by NO server IS reported — the granted roster is per-key, not a rubber stamp",
    );
    assert(
      !failures.some((f) => f.token === "gh" && f.file.includes("create")),
      "canary: a bash subcommand key `gh issue create*` does not leak into the tool roster",
    );
    assert(!has("success"), "canary: status value `success` is NOT reported (allowlisted)");
    assert(
      !tokens.includes("mcp__codebase_memory__search_code"),
      "canary: mcp__* token is not tool-shaped (skipped)",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(agentsDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- and the repo is clean

const repoPhantoms = findPhantomTools(REPO_ROOT, SRC);
const roster = knownRoster(SRC);
const registered = [...registeredToolNames(SRC)].sort();
const granted = [...grantedToolNames(AGENTS_JSON)].sort();
const mcpNames = [...mcpToolNames()].sort();
console.log(
  `  roster: ${roster.size} known tools (${PI_BUILTINS.size} Pi builtins, ${registered.length} registered, ${granted.length} granted in agents.json, ${mcpNames.length} MCP, ${ALLOWLIST.size} allowlisted)`,
);
console.log(`  registered tools: ${registered.join(", ")}`);
console.log(`  agents.json tool keys: ${granted.join(", ")}`);
console.log(`  mcp server/tool names: ${mcpNames.join(", ")}`);

if (repoPhantoms.length === 0) {
  assert(
    true,
    "every backticked tool-shaped token in agents-base/ + modules/ resolves against the roster (no phantom tools)",
  );
} else {
  for (const f of repoPhantoms) {
    assert(false, `phantom tool \`${f.token}\` in ${f.file}:${f.line} — not in the known roster`);
  }
}

console.log(exit === 0 ? "\nAll tool-name-surface checks passed." : "\nFAILED");
process.exit(exit);
