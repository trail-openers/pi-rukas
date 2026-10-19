#!/usr/bin/env bun
/**
 * Headless /work cycles run their children with interactive trust (#1666).
 *
 * Four links, each asserted where it is decided:
 *
 *   1. The spawn plan (spawn-permission.ts): a child dispatched with
 *      `workCycleTrust` gets the trust marker, no broker and no socket; without
 *      it (non-/work headless, `pi -p`) the child stays on the strict broker
 *      path; PI_ENSEMBLE_STRICT_PERMISSIONS=1 suppresses the cycle's marker.
 *   2. The carrier (work-driver-cycle-entry.ts): a headless cycle's dispatch
 *      wrapper stamps `workCycleTrust` on every child; a caller cannot opt out
 *      and an interactive cycle stamps nothing.
 *   3. The trust child's guards (child-guards.ts, what a trust child loads):
 *      ask-class calls pass; the mode-independent refusals still refuse; the
 *      write fence still refuses a write outside the worktree.
 *   4. The protected-path develop gate still halts an ungranted protected diff.
 *
 * The capabilities answer's `permissions` field is asserted in
 * test-headless-capabilities.ts; the strict-opt-in deny in
 * test-headless-permission-policy.ts; the marker row in test-permission-guard-runtime.ts.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerChildGuards from "../src/child-guards.ts";
import { buildCapabilities, permissionsReport } from "../src/headless/capabilities.ts";
import type { DispatchHost } from "../src/async-jobs-lifecycle.ts";
import type { DispatchResult } from "../src/types.ts";
import { enterCycle } from "../src/work-driver-cycle-entry.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { applyChildPermissionEnv, planChildPermissions } from "../src/spawn-permission.ts";
import { runProtectedPathGate } from "../src/work-driver-verify-develop-protected.ts";
import { buildFenceFixture } from "./lib/write-fence-fixture.ts";
import {
  TARGET,
  assert,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";

const ENV_KEYS = [
  "PI_ENSEMBLE_TRUST_MODE",
  "PI_ENSEMBLE_STRICT_PERMISSIONS",
  "PI_ENSEMBLE_SANDBOX_MODE",
  "PI_ENSEMBLE_SUBAGENT_MODE",
  "PI_ENSEMBLE_PERM_SOCKET",
  "PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD",
  "PI_ENSEMBLE_ROLE",
  "PI_ENSEMBLE_WRITE_ROOT",
  "PI_ENSEMBLE_WRITE_REPO",
  "PI_ENSEMBLE_WRITE_SCRATCH",
  "PI_ENSEMBLE_WRITE_FENCE",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function clearEnv(): void {
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
}

// ── 1. The spawn plan.
{
  clearEnv();
  const plan = planChildPermissions({ runId: "t1", role: "developer", workCycleTrust: true });
  assert(plan.trustChild === true, "1: a /work child (workCycleTrust) is a trust child");
  assert(plan.subagentGuardEnabled === false, "1: a /work child starts no subagent guard");
  assert(plan.broker === undefined && plan.permSocketPath === undefined, "1: no broker, no socket");
  const env: NodeJS.ProcessEnv = { PI_ENSEMBLE_PERM_SOCKET: "/inherited.sock" };
  applyChildPermissionEnv(env, plan);
  assert(env.PI_ENSEMBLE_TRUST_MODE === "1", "1: the child env carries PI_ENSEMBLE_TRUST_MODE=1");
  assert(
    env.PI_ENSEMBLE_PERM_SOCKET === undefined,
    "1: an inherited PI_ENSEMBLE_PERM_SOCKET does not survive into a trust child",
  );
  assert(env.PI_ENSEMBLE_SUBAGENT_MODE === undefined, "1: no SUBAGENT_MODE in a trust child");

  clearEnv();
  process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = "1";
  const strictPlan = planChildPermissions({ runId: "t2", role: "developer", workCycleTrust: true });
  assert(
    strictPlan.trustChild === false && strictPlan.subagentGuardEnabled === true,
    "1: PI_ENSEMBLE_STRICT_PERMISSIONS=1 suppresses the cycle's trust marker",
  );
  const strictEnv: NodeJS.ProcessEnv = {};
  applyChildPermissionEnv(strictEnv, strictPlan);
  assert(
    strictEnv.PI_ENSEMBLE_TRUST_MODE === undefined && strictEnv.PI_ENSEMBLE_SUBAGENT_MODE === "1",
    "1: under strict the child is the strict shape (SUBAGENT_MODE, no TRUST marker)",
  );

  clearEnv();
  const plain = planChildPermissions({ runId: "t3", role: "developer" });
  assert(
    plain.trustChild === false && plain.subagentGuardEnabled === true,
    "1: a non-/work headless child (no workCycleTrust, no parent trust) stays strict",
  );
  const plainFalse = planChildPermissions({ runId: "t4", role: "developer", workCycleTrust: false });
  assert(plainFalse.trustChild === false, "1: workCycleTrust=false is strict");

  clearEnv();
  process.env.PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD = "1";
  const disabled = planChildPermissions({ runId: "t5", role: "developer", workCycleTrust: true });
  assert(disabled.trustChild === true, "1: the cycle trust marker survives PI_ENSEMBLE_DISABLE_SUBAGENT_GUARD=1");
}

// ── 2. The carrier: the cycle's dispatch wrapper stamps every child.
async function recordedOpts(headless: boolean | undefined, callerOpts?: object): Promise<unknown> {
  const seen: unknown[] = [];
  const core = (async (_h: unknown, _spec: unknown, opts: unknown) => {
    seen.push(opts);
    return { role: "developer", ok: true, text: "", toolUses: [], ms: 0 } as DispatchResult;
  }) as never;
  const ctx = {
    issue: 1666,
    repoRoot: "/nonexistent",
    host: { emit: () => undefined },
    headless,
  } as unknown as DriverContext;
  const cycle = enterCycle(ctx, core);
  await cycle.dispatchFn(
    {} as DispatchHost,
    { role: "developer", prompt: "x" },
    callerOpts as never,
  );
  return seen[0];
}
{
  const headless = (await recordedOpts(true)) as { workCycleTrust?: boolean };
  assert(headless.workCycleTrust === true, "2: a headless cycle's child is dispatched with workCycleTrust");
  const interactive = (await recordedOpts(false)) as { workCycleTrust?: boolean };
  assert(interactive.workCycleTrust === false, "2: an interactive cycle's child is not stamped");
  const undef = (await recordedOpts(undefined)) as { workCycleTrust?: boolean };
  assert(undef.workCycleTrust === false, "2: a cycle without a headless flag is not stamped");
  const override = (await recordedOpts(false, { workCycleTrust: true })) as {
    workCycleTrust?: boolean;
  };
  assert(override.workCycleTrust === false, "2: a caller cannot opt an interactive child in");
}

// ── 4. Capabilities: the mode a run reports is read at answer time.
{
  clearEnv();
  assert(permissionsReport().workCycles === "trust", "cap: the default run reports trust for /work cycles");
  process.env.PI_ENSEMBLE_STRICT_PERMISSIONS = "1";
  assert(permissionsReport().workCycles === "strict", "cap: STRICT_PERMISSIONS=1 reports strict");
  assert(buildCapabilities().permissions.workCycles === "strict", "cap: buildCapabilities reports the same");
  clearEnv();
}

// ── 3. What a trust child loads: the child-guards companion.
type Handler = (event: unknown, ctx: unknown) => unknown;
async function childCalls(): Promise<(tool: string, input: unknown) => Promise<string | undefined>> {
  const handlers: Handler[] = [];
  const fake = {
    on: (name: string, fn: Handler) => {
      if (name === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  registerChildGuards(fake);
  return async (toolName, input) => {
    for (const h of handlers) {
      const r = (await h({ toolName, input }, {})) as { block?: boolean; reason?: string } | undefined;
      if (r?.block) return r.reason ?? "blocked";
    }
    return undefined;
  };
}

const fx = buildFenceFixture("headless-work");
{
  clearEnv();
  process.env.PI_ENSEMBLE_TRUST_MODE = "1";
  process.env.PI_ENSEMBLE_ROLE = "developer";
  process.env.PI_ENSEMBLE_WRITE_ROOT = fx.wt;
  process.env.PI_ENSEMBLE_WRITE_REPO = fx.repo;
  process.env.PI_ENSEMBLE_WRITE_SCRATCH = fx.scratch;
  // Relative write paths resolve against the child's cwd, the worktree.
  const savedCwd = process.cwd();
  process.chdir(fx.wt);
  const call = await childCalls();

  const ask = await call("websearch", { query: "probe" });
  assert(ask === undefined, "3: an ask-class tool call is not blocked in a /work child");
  assert(
    (await call("bash", { command: "npm run typecheck" })) === undefined,
    "3: an ordinary command (the project verify) is not blocked",
  );
  assert(
    (await call("bash", { command: "ls -la" })) === undefined,
    "3: a read command is not blocked by a headless deny",
  );
  const noBroker = [
    await call("websearch", {}),
    await call("bash", { command: "npm run typecheck" }),
  ].some((r) => r?.includes("no broker socket"));
  assert(!noBroker, "3: no ask-class reason ever names 'no broker socket' in a /work child");

  const outside = await call("write", { path: "../../bin/keep", content: "x" });
  assert(
    outside !== undefined,
    `3: a developer write outside its worktree is refused (got: ${outside ?? "allowed"})`,
  );
  assert(
    (await call("write", { path: "inside.ts", content: "x" })) === undefined,
    "3: a write inside its own worktree is allowed",
  );
  process.chdir(savedCwd);

  const reset = await call("bash", { command: "git reset --hard HEAD" });
  assert(
    reset !== undefined && !reset.includes("no broker socket"),
    `3: destructive git (git reset --hard) is refused in a /work child (got: ${reset ?? "allowed"})`,
  );

  const push = await call("bash", { command: "git push origin feature/x" });
  assert(push !== undefined, "3: a developer's git push is refused in a /work child");

  const issue = await call("bash", { command: "gh issue create --title t --body b" });
  assert(issue !== undefined, "3: gh issue create is refused in a /work child");

  const vipuneUpdate = await call("bash", { command: 'vipune update 12 -t "rewritten"' });
  assert(
    vipuneUpdate !== undefined && vipuneUpdate.includes("supersedes"),
    "3: a destructive vipune write (vipune update -t) is refused in a /work child",
  );
  assert(
    (await call("bash", { command: 'true && vipune update 12 --text "x"' })) !== undefined,
    "3: a chained destructive vipune write is refused too",
  );
  assert(
    (await call("bash", { command: "vipune update 12 --status active" })) === undefined,
    "3: a vipune status change (no new content) is not refused",
  );
  clearEnv();
}

// ── 3b. The merge guard refuses a merge with no passing review ledger.
{
  await setupLedgerPath();
  const verdict = await hookDecision(`gh pr merge ${TARGET.prNumber} --squash`, []);
  assert(verdict.block === true, "3: gh pr merge without a passing review ledger is refused");
  teardownLedger();
}

// ── 4. The protected-path develop gate halts an ungranted protected diff.
{
  const failures: string[] = [];
  const notes: string[] = [];
  runProtectedPathGate({
    protectedGateOn: true,
    touchedPaths: [".github/workflows/ci.yml", path.join("src", "a.ts")],
    protectedOnlyPaths: [],
    protectedGrant: undefined,
    issues: [1666],
    failures,
    notes,
  });
  assert(failures.length === 1, "4: an ungranted protected-path develop diff halts the cycle");
  const granted: string[] = [];
  runProtectedPathGate({
    protectedGateOn: true,
    touchedPaths: [".github/workflows/ci.yml"],
    protectedOnlyPaths: [],
    protectedGrant: [".github/workflows/ci.yml"],
    issues: [1666],
    failures: granted,
    notes: [],
  });
  assert(granted.length === 0, "4: the same diff passes when the operator granted that exact path");
}

restoreEnv();
console.log(`\nexit ${exit}`);
process.exit(exit);
