#!/usr/bin/env bun
/**
 * #1030 — codemode activation in subagent children (epic #1026, sub-issue 1):
 * the `session_start` append that turns the `codemode` builtin into an active
 * tool in BOTH registration paths, and the `PI_ENSEMBLE_CHILD_CODEMODE=0`
 * no-op.
 *
 * The invariant: activation APPENDS `codemode` to the current active tool
 * set — never replaces it. A replace would drop the `mcp__codebase_memory__*
 * tools (measured: `--tools …,codemode` activates codemode but removes ALL
 * 14 codebase-memory MCP tools). The shared seam is enableChildCodemode
 * (child-codemode.ts); the two call sites are child-guards.ts's
 * `session_start` (trust-mode children) and permission-subagent-guard.ts's
 * `registerSubagentGuard` (strict/headless children — the companion no-ops
 * under PI_ENSEMBLE_SUBAGENT_MODE=1, so the strict path owns it there).
 *
 * Driven with a mock ExtensionAPI whose `getActiveTools()` returns a set
 * that INCLUDES `mcp__codebase_memory__*` tools (the exact shape of a
 * real child roster), then the registered `session_start` handler is
 * fired with the mock (mirroring how Pi's emit() invokes handlers at
 * session start) and the `setActiveTools` call is asserted.
 *
 *   1. registerChildGuards (trust mode — no SUBAGENT_MODE): session_start
 *      records `setActiveTools(original + "codemode")` — append, set intact
 *      (all 14 mcp tools present, in their original relative order).
 *   2. registerChildGuards under PI_ENSEMBLE_CHILD_CODEMODE=0: NO
 *      `setActiveTools` call is recorded at all (flag off → no-op).
 *   3. PI_ENSEMBLE_SUBAGENT_MODE=1: the companion registers NO
 *      session_start handler at all — a test that fired the companion's
 *      handler there would falsely pass; under SUBAGENT_MODE=1 the strict
 *      path owns activation.
 *   4. registerSubagentGuard (strict path, no SUBAGENT_MODE at import —
 *      registerSubagentGuard does not gate on it; it IS the strict path):
 *      same append assertion; the strict path's handler fires and the set
 *      comes out intact + codemode.
 *   5. registerSubagentGuard under PI_ENSEMBLE_CHILD_CODEMODE=0: no
 *      `setActiveTools` call recorded.
 *   6. Idempotence: a session that already has codemode active (restored
 *      transcript) triggers NO `setActiveTools` call (no-op append).
 *   7. A failing getActiveTools (defensive) does not throw out of
 *      session_start — the child continues without codemode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { registerSubagentGuard } from "../src/permission-subagent-guard.ts";
import { enableChildCodemode } from "../src/child-codemode.ts";

// The roster shape of a real child: the built-in MCP tools (codebase-memory,
// 14 tools in the reference environment — the exact list in BASE_ROSTER
// below) plus the core tools. This is the exact set a replace-variant
// would drop — so the assert below must see it intact.
const BASE_ROSTER = [
  "bash",
  "read",
  "edit",
  "write",
  "mcp__codebase_memory__search_code",
  "mcp__codebase_memory__trace_path",
  "mcp__codebase_memory__detect_changes",
  "mcp__codebase_memory__get_architecture",
  "mcp__codebase_memory__get_code_snippet",
  "mcp__codebase_memory__query_graph",
  "mcp__codebase_memory__search_graph",
  "mcp__codebase_memory__index_repository",
  "mcp__codebase_memory__list_projects",
  "mcp__codebase_memory__delete_project",
  "mcp__codebase_memory__index_status",
  "mcp__codebase_memory__check_index_coverage",
  "mcp__codebase_memory__compare_graphs",
  "mcp__codebase_memory__manage_adr",
];

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

interface MockPi {
  handlers: Record<string, Handler[]>;
  setActiveCalls: string[][];
  activeTools: string[];
  throwOnGet: boolean;
}

function makeMockPi(activeTools: string[], throwOnGet = false): MockPi {
  const handlers: Record<string, Handler[]> = {};
  const mock: MockPi = {
    handlers,
    setActiveCalls: [],
    activeTools: [...activeTools],
    throwOnGet,
  };
  (mock as unknown as Record<string, unknown>).on = (name: string, fn: Handler) => {
    (handlers[name] ??= []).push(fn);
  };
  (mock as unknown as Record<string, unknown>).getActiveTools = () => {
    if (mock.throwOnGet) throw new Error("mock: getActiveTools unavailable");
    return [...mock.activeTools];
  };
  (mock as unknown as Record<string, unknown>).setActiveTools = (names: string[]) => {
    mock.setActiveCalls.push([...names]);
  };
  // The strict path (registerSubagentGuard) also reads the role env and
  // short-circuits on sandbox/trust; neither is set here, so it reaches the
  // full registration. We don't need the tool_call handler to do anything —
  // we only exercise the session_start activation, which runs before any
  // bypass.
  return mock;
}

async function fireSessionStart(mock: MockPi): Promise<void> {
  const hs = mock.handlers["session_start"] ?? [];
  for (const h of hs) await h({ type: "session_start", reason: "startup" }, {});
}

// Clean the env between scenarios — the flag is read at session_start time,
// not at import, so mutating process.env between scenarios is safe.
delete process.env.PI_ENSEMBLE_CHILD_CODEMODE;
delete process.env.PI_ENSEMBLE_SUBAGENT_MODE;
delete process.env.PI_ENSEMBLE_ROLE;
delete process.env.PI_ENSEMBLE_SANDBOX_MODE;
delete process.env.PI_ENSEMBLE_TRUST_MODE;
delete process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE;
delete process.env.PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE;
delete process.env.PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT;

// ============================================================
// 1. Companion (trust mode — no SUBAGENT_MODE): session_start appends
//    codemode to the roster; all mcp tools survive.
// ============================================================
{
  const mock = makeMockPi(BASE_ROSTER);
  childGuards(mock as unknown as ExtensionAPI);
  assert(
    (mock.handlers["session_start"] ?? []).length === 1,
    "companion registers exactly one session_start handler in trust mode",
  );
  await fireSessionStart(mock);
  assert(mock.setActiveCalls.length === 1, "companion session_start records exactly one setActiveTools call");
  const call = mock.setActiveCalls[0];
  assert(call !== undefined, "companion setActiveTools call exists");
  // APPEND, not replace: the original set is a prefix of the new set, in
  // the original order, plus codemode at the end.
  assert(
    call && call.length === BASE_ROSTER.length + 1,
    `companion: new set is original length + 1 (got ${call?.length} for base ${BASE_ROSTER.length})`,
  );
  for (let i = 0; i < BASE_ROSTER.length; i++) {
    assert(
      call?.[i] === BASE_ROSTER[i],
      `companion: position ${i} is still ${BASE_ROSTER[i]} (got ${call?.[i]})`,
    );
  }
  assert(call?.[BASE_ROSTER.length] === "codemode", "companion: position last is `codemode` (appended)");
  const mcpCount = (call ?? []).filter((t) => t.startsWith("mcp__codebase_memory__")).length;
  assert(mcpCount === 14, `companion: all 14 mcp__codebase_memory__* tools survive the append (got ${mcpCount})`);
}

// ============================================================
// 2. Companion under PI_ENSEMBLE_CHILD_CODEMODE=0: no setActiveTools call.
// ============================================================
{
  process.env.PI_ENSEMBLE_CHILD_CODEMODE = "0";
  const mock = makeMockPi(BASE_ROSTER);
  childGuards(mock as unknown as ExtensionAPI);
  await fireSessionStart(mock);
  assert(mock.setActiveCalls.length === 0, "companion under =0: no setActiveTools call (flag off → no-op)");
  delete process.env.PI_ENSEMBLE_CHILD_CODEMODE;
}

// ============================================================
// 3. Companion under PI_ENSEMBLE_SUBAGENT_MODE=1: registers NO
//    session_start handler (the strict path owns activation there).
//    A handler here would double-fire with the strict path.
// ============================================================
{
  process.env.PI_ENSEMBLE_SUBAGENT_MODE = "1";
  const mock = makeMockPi(BASE_ROSTER);
  childGuards(mock as unknown as ExtensionAPI);
  assert(
    (mock.handlers["session_start"] ?? []).length === 0,
    "companion under SUBAGENT_MODE=1: no session_start handler (strict path owns activation)",
  );
  // And even if the handler were fired, no setActiveTools would be recorded
  // because there is no handler to fire. (This is the false-pass trap the
  // issue names: a test that fired a handler the companion shouldn't have
  // registered would falsely pass.)
  delete process.env.PI_ENSEMBLE_SUBAGENT_MODE;
}

// ============================================================
// 4. Strict path (registerSubagentGuard): session_start appends codemode;
//    roster intact.
// ============================================================
{
  const mock = makeMockPi(BASE_ROSTER);
  registerSubagentGuard(mock as unknown as ExtensionAPI);
  const n = (mock.handlers["session_start"] ?? []).length;
  assert(n >= 1, `strict path registers a session_start handler (got ${n})`);
  await fireSessionStart(mock);
  const calls = mock.setActiveCalls;
  assert(calls.length === 1, `strict path: exactly one setActiveTools call recorded (got ${calls.length})`);
  const call = calls[0];
  assert(call !== undefined, "strict path setActiveTools call exists");
  assert(
    call && call.length === BASE_ROSTER.length + 1,
    `strict path: new set is original + 1 (got ${call?.length})`,
  );
  for (let i = 0; i < BASE_ROSTER.length; i++) {
    assert(
      call?.[i] === BASE_ROSTER[i],
      `strict path: position ${i} is still ${BASE_ROSTER[i]} (got ${call?.[i]})`,
    );
  }
  assert(call?.[BASE_ROSTER.length] === "codemode", "strict path: position last is `codemode` (appended)");
}

// ============================================================
// 5. Strict path under PI_ENSEMBLE_CHILD_CODEMODE=0: no call recorded.
// ============================================================
{
  process.env.PI_ENSEMBLE_CHILD_CODEMODE = "0";
  const mock = makeMockPi(BASE_ROSTER);
  registerSubagentGuard(mock as unknown as ExtensionAPI);
  await fireSessionStart(mock);
  assert(mock.setActiveCalls.length === 0, "strict path under =0: no setActiveTools call (flag off → no-op)");
  delete process.env.PI_ENSEMBLE_CHILD_CODEMODE;
}

// ============================================================
// 6. Idempotence — already-active: a session restored with codemode active
//    must not re-call setActiveTools (the append is a no-op).
// ============================================================
{
  const already = [...BASE_ROSTER, "codemode"];
  const mock = makeMockPi(already);
  childGuards(mock as unknown as ExtensionAPI);
  await fireSessionStart(mock);
  assert(
    mock.setActiveCalls.length === 0,
    "already-active: no setActiveTools call when codemode is already in the set (idempotent no-op)",
  );
}

// ============================================================
// 7. Defensive: getActiveTools throwing must not throw out of session_start
//    — the child continues without codemode (the seam catches and traces).
// ============================================================
{
  const mock = makeMockPi(BASE_ROSTER, true);
  childGuards(mock as unknown as ExtensionAPI);
  let threw = false;
  try {
    await fireSessionStart(mock);
  } catch {
    threw = true;
  }
  assert(!threw, "defensive: a throwing getActiveTools does not propagate out of session_start");
  assert(mock.setActiveCalls.length === 0, "defensive: no setActiveTools call recorded when getActiveTools threw");
}

// ============================================================
// 8. The shared seam is the single source — both call sites reference the
//    same function (child-codemode.ts). A canary that the flag is read via
//    the seam (process.env.PI_ENSEMBLE_CHILD_CODEMODE appears only in
//    child-codemode.ts in src/, not duplicated in the two call sites).
// ============================================================
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const SRC = join(import.meta.dirname, "..", "src");
  const seam = readFileSync(join(SRC, "child-codemode.ts"), "utf8");
  const companion = readFileSync(join(SRC, "child-guards.ts"), "utf8");
  const strict = readFileSync(join(SRC, "permission-subagent-guard.ts"), "utf8");
  const spawnSupport = readFileSync(join(SRC, "spawn-support.ts"), "utf8");
  assert(
    /PI_ENSEMBLE_CHILD_CODEMODE/.test(seam),
    "canary: the flag is read in child-codemode.ts (the single seam)",
  );
  assert(
    /export function enableChildCodemode/.test(seam),
    "canary: child-codemode.ts exports enableChildCodemode",
  );
  assert(
    /export function childCodemodeEnabled/.test(seam),
    "canary: child-codemode.ts exports childCodemodeEnabled",
  );
  // The companion calls the seam, not its own copy.
  assert(
    /enableChildCodemode\s*\(\s*pi\s*\)/.test(companion),
    "canary: the companion calls enableChildCodemode(pi) (no inline duplicate)",
  );
  assert(
    !/PI_ENSEMBLE_CHILD_CODEMODE/.test(companion),
    "canary: the companion does NOT read PI_ENSEMBLE_CHILD_CODEMODE itself (single seam)",
  );
  // The strict path calls the seam, not its own copy.
  assert(
    /enableChildCodemode\s*\(\s*pi\s*\)/.test(strict),
    "canary: the strict path calls enableChildCodemode(pi) (no inline duplicate)",
  );
  assert(
    !/PI_ENSEMBLE_CHILD_CODEMODE/.test(strict),
    "canary: the strict path does NOT read PI_ENSEMBLE_CHILD_CODEMODE itself (single seam)",
  );
  // The argv side (spawn-support.ts) also reads the flag through the seam —
  // a local copy there (one that treated "false" differently from "0") would
  // make PI_ENSEMBLE_CHILD_CODEMODE=false argv-off but activation-on. The
  // canary forbids a *local reader*: a declaration plus an env read in the
  // same file (a comment naming the flag is not a reader — the doc block
  // documents the escape hatch, and that documentation is the contract).
  assert(
    /childCodemodeEnabled\s*\(\s*\)/.test(spawnSupport),
    "canary: spawn-support.ts calls childCodemodeEnabled() (the single seam, no local copy)",
  );
  assert(
    !(/function\s+childCodemodeEnabled/.test(spawnSupport) &&
      /PI_ENSEMBLE_CHILD_CODEMODE\s*[\]=]/.test(spawnSupport)),
    "canary: spawn-support.ts has no local childCodemodeEnabled that reads the flag itself (single seam)",
  );
  // The seam does an APPEND, not a replace — the call is [..active, "codemode"].
  assert(
    /\[\s*\.\.\.\s*active\s*,\s*"codemode"\s*\]/.test(seam),
    "canary: the seam appends ( [...active, \"codemode\"] ), never replaces",
  );
  // The seam guards against re-appending when already active.
  assert(
    /active\.includes\("codemode"\)/.test(seam),
    "canary: the seam no-ops when codemode is already in the active set (idempotent)",
  );
}

// Direct call through the seam (round-trip sanity — the seam is the unit
// under test; the two call sites are integration points verified above).
{
  const mock = makeMockPi(BASE_ROSTER);
  enableChildCodemode(mock as unknown as ExtensionAPI);
  assert(mock.setActiveCalls.length === 1, "seam: direct call records one setActiveTools");
  assert(
    mock.setActiveCalls[0]?.[mock.setActiveCalls[0].length - 1] === "codemode",
    "seam: direct call appends codemode at the end",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
