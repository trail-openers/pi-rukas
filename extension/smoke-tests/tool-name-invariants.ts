/**
 * tool-name-invariants — the three host/roster integrity assertions behind
 * `test-tool-name-surface.ts` (issue #995 adversarial round).
 *
 * Split out on the same seam as `tool-name-roster.ts` / `tool-name-allowlist.ts`:
 * the 500-line file cap (AGENTS.md §12). The test file keeps the canary fixture
 * and the repo-wide scan; this module keeps the assertions about the ROSTER
 * ITSELF — where it reads from, what it refuses to contain, and what it does
 * when a source is broken.
 *
 * Each block is a regression an earlier revision of this gate actually had:
 *
 *   1. **Host independence.** The first revision read `$PI_AGENT_DIR/mcp.json`
 *      (falling back to `~/.pi/agent/mcp.json`), so CI with no user Pi config
 *      and a laptop with one disagreed about which MCP names were real. A gate
 *      whose verdict depends on whose machine ran it is not a gate.
 *   2. **No real tools filed as nouns.** Twelve real tools (`read`, `write`,
 *      `edit`, `list`, `rg`, `multiedit`, `webfetch`, `websearch`, `question`,
 *      `search_code`, `trace_path`, `detect_changes`) sat in the allowlist block
 *      labelled "Prose nouns and generic words (not tools)". The label was false
 *      and the roster stopped being the single record of what exists.
 *   3. **No silent fallback on a bad roster source.** `grantedToolNames` returned
 *      an empty set on malformed `agents.json`, so a broken repo either stamped
 *      every granted-tool sentence as a phantom or — on a partial break — quietly
 *      green-lit names it should not have.
 *
 * Every assertion here is mutation-checked: each has a "canary" that fails when
 * the mechanism it guards is broken, so a block cannot pass by being vacuous.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENTS_JSON,
  ALLOWLIST,
  DOCTRINE_MCP_JSON,
  RosterSourceError,
  allowlistEntriesThatAreRealTools,
  findPhantomTools,
  grantedToolNames,
  knownRoster,
  mcpConfigCandidates,
  mcpToolNames,
} from "./tool-name-roster.ts";

type Assert = (cond: boolean, msg: string) => void;

/**
 * Unsets an environment variable for real.
 *
 * Assigning undefined to an env key (e.g. `process.env["HOME"]`) does NOT unset it — the assignment stringifies,
 * leaving the literal string "undefined", and the next roster read resolves `~`
 * against a directory named "undefined". A restoration helper that assigned
 * undefined would leave the probe testing a state no real process is ever in.
 * Biome's recommended `noDelete` rule offers exactly that assignment as its fix,
 * so the unset is centralised here (with a computed key, which also keeps this
 * single site clear of the rule) rather than repeated and "fixed" at four calls.
 */
function unsetEnv(name: string): void {
  delete process.env[name];
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) unsetEnv(name);
  else process.env[name] = value;
}

/** The roster must be the same on a CI box with no user Pi config as on a
 *  developer laptop with one. Asserts three ways: identical with `PI_AGENT_DIR`
 *  emptied, identical with `HOME` redirected at a decoy config, and no candidate
 *  path resolving outside the checkout. */
export function assertHostIndependence(assert: Assert, srcDir: string, repoRoot: string): void {
  const emptyPiAgentDir = mkdtempSync(path.join(tmpdir(), "pi-ens-empty-agent-"));
  const savedPiAgentDir = process.env.PI_AGENT_DIR;
  const savedHome = process.env.HOME;
  try {
    const baseline = [...knownRoster(srcDir)].sort();

    unsetEnv("PI_AGENT_DIR");
    process.env.PI_AGENT_DIR = emptyPiAgentDir;
    const withEmptyAgentDir = [...knownRoster(srcDir)].sort();
    const extra = withEmptyAgentDir.filter((t) => !baseline.includes(t));
    const missing = baseline.filter((t) => !withEmptyAgentDir.includes(t));
    assert(
      extra.length === 0 && missing.length === 0,
      `roster is IDENTICAL with PI_AGENT_DIR pointed at an empty temp dir (extra [${extra.join(", ")}], missing [${missing.join(", ")}])`,
    );

    // The equality above must not be two empty rosters agreeing: a name only the
    // committed registry supplies has to be present in BOTH environments.
    assert(
      baseline.includes("search_code") && withEmptyAgentDir.includes("search_code"),
      "canary: the committed doctrine MCP registry supplies `search_code` in BOTH environments — the equality above is not two empty rosters agreeing",
    );

    const outsideCheckout = mcpConfigCandidates().filter((p) => !p.startsWith(repoRoot + path.sep));
    assert(
      outsideCheckout.length === 0,
      `every MCP roster source is inside the checkout (outside: [${outsideCheckout.join(", ")}])`,
    );

    // A POSITIVE test, not only an equality: seed a host config with a server
    // name nothing else knows. Comparing the ambient roster against itself would
    // pass while the gate still read the user's config — both sides polluted the
    // same way.
    const HOST_ONLY_SERVER = "hostonly_server_must_not_leak";
    const decoyHome = mkdtempSync(path.join(tmpdir(), "pi-ens-decoy-home-"));
    mkdirSync(path.join(decoyHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      path.join(decoyHome, ".pi", "agent", "mcp.json"),
      JSON.stringify({ mcpServers: { [HOST_ONLY_SERVER]: { command: "true" } } }),
    );
    try {
      unsetEnv("HOME");
      process.env.HOME = decoyHome;
      const withHostHome = [...knownRoster(srcDir)].sort();
      const homeExtra = withHostHome.filter((t) => !baseline.includes(t));
      const homeMissing = baseline.filter((t) => !withHostHome.includes(t));
      assert(
        homeExtra.length === 0 && homeMissing.length === 0,
        `roster is IDENTICAL with HOME pointed at a temp dir holding a decoy mcp.json (extra [${homeExtra.join(", ")}], missing [${homeMissing.join(", ")}])`,
      );
      assert(
        !withHostHome.includes(HOST_ONLY_SERVER),
        "canary: a server declared only in a user-level mcp.json does NOT enter the roster — proves the HOME probe could have detected a leak",
      );
      assert(
        mcpToolNames(AGENTS_JSON, [path.join(decoyHome, ".pi", "agent", "mcp.json")]).has(
          HOST_ONLY_SERVER,
        ),
        "canary: the decoy file IS readable and WOULD contribute if read — so the refusal above is real, not an unreadable fixture",
      );
    } finally {
      restoreEnv("HOME", savedHome);
      rmSync(decoyHome, { recursive: true, force: true });
    }
  } finally {
    restoreEnv("PI_AGENT_DIR", savedPiAgentDir);
    restoreEnv("HOME", savedHome);
    rmSync(emptyPiAgentDir, { recursive: true, force: true });
  }

  // The committed registry replaces the per-user file, so it must be wired into
  // the default candidate list and must itself satisfy the reason requirement.
  assert(
    mcpConfigCandidates().includes(DOCTRINE_MCP_JSON),
    "the committed doctrine MCP registry is one of the default MCP roster sources",
  );
  try {
    const registry = JSON.parse(readFileSync(DOCTRINE_MCP_JSON, "utf8")) as {
      servers?: Array<{ server?: string; tools?: Array<{ name?: string; reason?: string }> }>;
    };
    const entries = (registry.servers ?? []).flatMap((s) => s.tools ?? []);
    assert(
      entries.length > 0 && entries.every((t) => t.name && (t.reason ?? "").trim().length > 0),
      `every entry in the committed doctrine MCP registry names a server, a tool and a reason (${entries.length} entries)`,
    );
  } catch (err) {
    assert(false, `committed doctrine MCP registry parses: ${(err as Error).message}`);
  }
}

/** Nothing the "not tools" allowlist claims is a tool. */
export function assertNoRealToolsFiledAsNouns(assert: Assert, srcDir: string): void {
  const overlap = allowlistEntriesThatAreRealTools(srcDir);
  assert(
    overlap.length === 0,
    `no ALLOWLIST entry is a tool some roster source already supplies (overlap: [${overlap.join(", ")}]) — the "not tools" label has to be true`,
  );

  // The twelve names this round removed from the nouns block must each still
  // resolve as a real tool. If a roster source ever stops supplying one, this
  // names which — rather than the repo-wide scan failing with no explanation.
  const removedRealTools = [
    "read",
    "write",
    "edit",
    "list",
    "rg",
    "multiedit",
    "webfetch",
    "websearch",
    "question",
    "search_code",
    "trace_path",
    "detect_changes",
  ];
  const roster = knownRoster(srcDir);
  const lost = removedRealTools.filter((t) => !roster.has(t));
  assert(
    lost.length === 0,
    `all twelve tools removed from the nouns block still resolve through a roster source (lost: [${lost.join(", ")}])`,
  );
  const stillAllowlisted = removedRealTools.filter((t) => ALLOWLIST.has(t));
  assert(
    stillAllowlisted.length === 0,
    `none of the twelve is still in the ALLOWLIST (still present: [${stillAllowlisted.join(", ")}])`,
  );

  // Anti-vacuity: the overlap check must be reading a populated allowlist, not an
  // empty set that trivially has no overlap.
  assert(
    ALLOWLIST.size > 100 && ALLOWLIST.has("fact") && !roster.has("totally_bogus_tool"),
    "canary: the overlap check reads a populated ALLOWLIST (a vacuous empty set would pass it)",
  );
}

/** A broken roster source is a FAILED gate, never an empty roster. */
export function assertNoSilentFallbackOnBadRoster(assert: Assert, srcDir: string): void {
  const badDir = mkdtempSync(path.join(tmpdir(), "pi-ens-toolname-bad-"));
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-toolname-bad-root-"));
  try {
    mkdirSync(path.join(fixtureRoot, "agents-base"));
    mkdirSync(path.join(fixtureRoot, "modules"));
    writeFileSync(
      path.join(fixtureRoot, "agents-base", "naming-a-granted-tool.md"),
      "Call the `granted_tool` tool.\n",
    );
    const cases: Array<{ label: string; content: string; expect: string; isDir?: boolean }> = [
      {
        label: "malformed JSON (truncated)",
        content: '{"agent":{"developer":{"permission":{"granted_tool":"allow"}}',
        expect: "malformed JSON",
      },
      {
        label: "unreadable file at a present path (a directory, not a file)",
        content: "",
        expect: "unreadable",
        isDir: true,
      },
      {
        label: 'valid JSON with no "agent" object',
        content: '{"roles":{"developer":{}}}',
        expect: 'no "agent" object',
      },
      {
        label: '"agent" is an array, not an object',
        content: '{"agent":[]}',
        expect: "not an object",
      },
    ];
    for (const [i, c] of cases.entries()) {
      const badFile = path.join(badDir, `agents-${i}.json`);
      if (c.isDir) mkdirSync(badFile, { recursive: true });
      else writeFileSync(badFile, c.content);
      let thrown: unknown;
      try {
        findPhantomTools(fixtureRoot, srcDir, badFile, []);
      } catch (err) {
        thrown = err;
      }
      assert(
        thrown instanceof RosterSourceError,
        `fixture: a broken agents.json (${c.label}) throws RosterSourceError instead of falling back to an empty roster`,
      );
      assert(
        thrown instanceof RosterSourceError &&
          thrown.message.includes(c.expect) &&
          thrown.message.includes(badFile),
        `fixture: the error names the source path and the reason for "${c.label}"`,
      );
    }

    // A truncated doctrine registry would otherwise shrink the roster and
    // produce phantom failures nobody can attribute.
    const brokenRegistry = path.join(badDir, "registry.json");
    writeFileSync(brokenRegistry, '{"servers":[{"server":"codebase_memory","tools":[');
    let registryThrew: unknown;
    try {
      mcpToolNames(AGENTS_JSON, [brokenRegistry]);
    } catch (err) {
      registryThrew = err;
    }
    assert(
      registryThrew instanceof RosterSourceError && registryThrew.message.includes(brokenRegistry),
      "fixture: a malformed doctrine MCP registry throws RosterSourceError naming the file",
    );

    // An entry with no reason is the gate being quietly turned off.
    const noReason = path.join(badDir, "no-reason.json");
    writeFileSync(
      noReason,
      JSON.stringify({ servers: [{ server: "srv", tools: [{ name: "some_tool" }] }] }),
    );
    let reasonThrew: unknown;
    try {
      mcpToolNames(AGENTS_JSON, [noReason]);
    } catch (err) {
      reasonThrew = err;
    }
    assert(
      reasonThrew instanceof RosterSourceError && /reason/.test(reasonThrew.message ?? ""),
      "fixture: a registry entry with no reason throws RosterSourceError — every entry must justify itself",
    );

    // The good shape still parses, so the failures above are specific and not the
    // reader being broken for everything.
    const goodRegistry = path.join(badDir, "good.json");
    writeFileSync(
      goodRegistry,
      JSON.stringify({
        servers: [{ server: "srv", tools: [{ name: "some_tool", reason: "named by x.md" }] }],
      }),
    );
    const good = mcpToolNames(AGENTS_JSON, [goodRegistry]);
    assert(
      good.has("some_tool") && good.has("srv"),
      "canary: a well-formed registry still resolves its server and tool names — the failures above are specific, not blanket",
    );

    // Absence stays silence — these checks are about breakage, not missing files.
    let absentThrew: unknown;
    try {
      grantedToolNames(path.join(badDir, "does-not-exist.json"));
    } catch (err) {
      absentThrew = err;
    }
    assert(
      absentThrew === undefined,
      "an absent agents.json is still silence, not an error — the gate distinguishes missing from broken",
    );
  } finally {
    rmSync(badDir, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
