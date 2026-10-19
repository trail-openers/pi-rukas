#!/usr/bin/env bun
/**
 * The single-workstream repair of omitted spec deliverable paths
 * (work-driver-plan-repair.ts). Run from the plan quality tail, so the cases
 * below go through the real gate, not a copy of it.
 *
 * The incident (#1439, run 5): one workstream, a spec deliverable naming two
 * test files, the planner omitted both twice, and the cycle parked as
 * `plan-spec-mismatch` before develop. Cases:
 *
 *   1. N=1, a missing plain path → appended to the sole workstream, no park,
 *      no corrective, and the repair is disclosed as a spec assumption;
 *   2. N=1, a missing path that is protected → nothing repaired, the gate
 *      refuses as before (the corrective is the only remaining route);
 *   3. N=1, a missing either/or slot → nothing repaired;
 *   4. N=1, a missing path fenced in the workstream's outOfScope → nothing repaired;
 *   5. N=2, a missing path → nothing repaired (which workstream owns it is a judgement);
 *   6. N=1 with a refused call → nothing repaired (a second defect);
 *   7. the gate off → nothing repaired.
 */

import type { CycleContext } from "../src/work-driver-context.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import { emptyWorkstreamReport } from "../src/work-driver-plan-calls.ts";
import {
  type PlanQualityHost,
  type PlanQualityInput,
  runPlanQualityTail,
} from "../src/work-driver-plan-quality-pass.ts";
import { repairOmittedDeliverablePaths } from "../src/work-driver-plan-repair.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state-update.ts";

// The tail's cross-group claim check writes a registry under repoRoot; this
// test is about the repair, so that side effect is switched off for the run.
// Set after the static imports above on purpose: the flag is read at CALL time
// (inside runPlanQualityTail), not at import time, so this ordering is safe.
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const T1 = "extension/smoke-tests/test-vipune.ts";
const T2 = "extension/smoke-tests/test-secret-patterns.ts";

/** The #1439 shape: one deliverable naming a source file and two tests. */
const SPEC: NormalisedSpec = {
  intent: "vipune and secret-pattern coverage",
  deliverables: [{ id: "d5", description: "tests", paths: ["src/a.ts", T1, T2] }],
  acceptanceCriteria: [],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "",
};

const WS = (id: string, paths: string[], outOfScope: string[] = []): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/** A plan host whose corrective must never resolve: a repaired plan never reaches it. */
const HOST: PlanQualityHost = {
  dispatch: async () => {
    throw new Error("corrective dispatch — expected only where the repair refuses");
  },
  prompt: "primary plan prompt",
  slow: () => undefined,
  deck: () => ({}),
};

/** Run the tail over one plan; the gate is on unless told otherwise. */
async function tail(
  workstreams: Record<string, Workstream>,
  spec: NormalisedSpec | undefined,
  grant: string[],
  planGateEnabled = true,
  withSpec = false,
) {
  const base = initialState(1439, 1);
  const next = withSpec
    ? {
        ...base,
        pipelineState: { ...base.pipelineState, normalisedSpec: SPEC },
      }
    : base;
  const input: PlanQualityInput = {
    next,
    report: {
      ...emptyWorkstreamReport(),
      accepted: Object.keys(workstreams).length,
      workstreams,
    },
    workstreams,
    firstPlanRaw: workstreams,
    findingsCount: 1,
    spec,
    planGateEnabled,
    planKill: false,
    redispatched: false,
  };
  const ctx = {
    issue: 1439,
    repoRoot: "/repo",
    protectedGrant: grant,
  } as unknown as CycleContext;
  return runPlanQualityTail(ctx, input, HOST);
}

// ------------------------------------------- 1. N=1 missing plain path: repaired

{
  const ws = { "task-1": WS("task-1", ["src/a.ts"]) };
  const r = await tail(ws, SPEC, [], true, true);
  assert(!r.halted, "N=1 omitted spec paths: the tail does not halt (no park)");
  assert(
    JSON.stringify(r.workstreams["task-1"]?.paths) === JSON.stringify(["src/a.ts", T1, T2]),
    "N=1 omitted spec paths: both missing test files are appended to the sole workstream",
  );
  assert(
    r.planQuality?.redispatched === false && r.planQuality?.reason === undefined,
    "N=1 omitted spec paths: no corrective re-dispatch and no plan-quality reason",
  );
  const assumptions = r.state.pipelineState.normalisedSpec?.assumptions.map((a) => a.text) ?? [];
  assert(
    assumptions.includes(`driver added spec deliverable paths the plan omitted: ${T1}, ${T2}`),
    "N=1 omitted spec paths: the repair is disclosed as a spec assumption (the PR body)",
  );
  const pure = repairOmittedDeliverablePaths(ws, SPEC, []);
  assert(
    pure?.added.length === 2 && pure.added.includes(T1) && pure.added.includes(T2),
    "repair: reports exactly the two omitted paths it added",
  );
  assert(
    repairOmittedDeliverablePaths(pure?.workstreams ?? {}, SPEC, []) === undefined,
    "repair is idempotent: a second pass over the repaired plan adds nothing",
  );
}

// ----------------------------------------- 2. N=1 protected missing path: parks

{
  const SPEC_P: NormalisedSpec = {
    ...SPEC,
    deliverables: [
      {
        id: "d5",
        description: "ci",
        paths: ["src/a.ts", ".github/workflows/ci.yml"],
      },
    ],
  };
  const ws = { "task-1": WS("task-1", ["src/a.ts"]) };
  // Granted, so the gate requires it (not deferred) — and the repair still refuses.
  const pure = repairOmittedDeliverablePaths(ws, SPEC_P, [".github/workflows/ci.yml"]);
  assert(pure === undefined, "protected missing path (granted): the repair refuses");
  const r = await tail(ws, SPEC_P, [".github/workflows/ci.yml"]);
  assert(r.halted, "protected missing path (granted): the gate still halts the plan");
  assert(
    JSON.stringify(r.workstreams["task-1"]?.paths) === JSON.stringify(["src/a.ts"]),
    "protected missing path: the sole workstream's paths are untouched",
  );
}

// ----------------------------------------------- 3. N=1 either/or slot: refused

{
  const SPEC_E: NormalisedSpec = {
    ...SPEC,
    deliverables: [{ id: "d5", description: "either", paths: [`${T1} or ${T2}`] }],
  };
  const ws = { "task-1": WS("task-1", ["src/a.ts"]) };
  assert(
    repairOmittedDeliverablePaths(ws, SPEC_E, []) === undefined,
    "either/or missing slot: the planner's choice is not made by the driver",
  );
}

// ------------------------------------------------ 4. N=1 fenced path: refused

{
  const ws = { "task-1": WS("task-1", ["src/a.ts"], [T1]) };
  const pure = repairOmittedDeliverablePaths(ws, SPEC, []);
  assert(
    pure === undefined,
    "fenced missing path (in outOfScope): the repair refuses, the fence is the plan's own word",
  );
}

// ------------------------- 4b. N=1 directory fence covering the path: refused

{
  const ws = {
    "task-1": WS("task-1", ["src/a.ts"], ["extension/smoke-tests"]),
  };
  assert(
    repairOmittedDeliverablePaths(ws, SPEC, []) === undefined,
    "directory-fenced missing path: the repair refuses, as the gate's prefix fence does",
  );
}

// ------------------------------ 4c. N=1 template slot: never written literally

{
  const SPEC_T: NormalisedSpec = {
    ...SPEC,
    deliverables: [
      {
        id: "d5",
        description: "tmpl",
        paths: ["extension/src/work-driver-<name>.ts"],
      },
    ],
  };
  const ws = { "task-1": WS("task-1", ["src/a.ts"]) };
  assert(
    repairOmittedDeliverablePaths(ws, SPEC_T, []) === undefined,
    "template missing slot: the repair refuses rather than appending the literal template",
  );
}

// ----------------------- 4d. N=1 plan wholly unrelated to the spec: not repaired

{
  const ws = { "task-1": WS("task-1", ["src/unrelated.ts"]) };
  assert(
    repairOmittedDeliverablePaths(ws, SPEC, []) === undefined,
    "unrelated N=1 plan: nothing covered, so the repair refuses (a wrong plan is not an omitted one)",
  );
}

// ------------------------- 4e. wrong target / no spec / unsafe spellings: refused, traced

{
  const reasons: string[] = [];
  const refuse = (r: string) => reasons.push(r);
  const ws = { "task-1": WS("task-1", ["src/unrelated.ts"]) };
  repairOmittedDeliverablePaths(ws, SPEC, [], refuse);
  assert(
    reasons.length === 1 && reasons[0]?.includes("wrong plan"),
    "wrong-target decline: the refusal reason is handed to the caller",
  );
  const none = repairOmittedDeliverablePaths(
    { "task-1": WS("task-1", ["src/a.ts"]) },
    undefined,
    [],
  );
  assert(none === undefined, "no normalised spec: the repair does not run (fail closed)");
  for (const unsafe of [".GitHub/workflows/ci.yml", ".PI/verify-cmd", ".pi"]) {
    const SPEC_U: NormalisedSpec = {
      ...SPEC,
      deliverables: [{ id: "d5", description: "unsafe", paths: ["src/a.ts", unsafe] }],
    };
    const seen: string[] = [];
    const pure = repairOmittedDeliverablePaths(
      { "task-1": WS("task-1", ["src/a.ts"]) },
      SPEC_U,
      [unsafe],
      (r) => seen.push(r),
    );
    assert(
      pure === undefined && seen.some((r) => r.includes("protected path")),
      `unsafe spelling ${unsafe}: the repair refuses it as a protected path`,
    );
  }
  const SPEC_N: NormalisedSpec = {
    ...SPEC,
    deliverables: [
      {
        id: "d5",
        description: "norm",
        paths: ["src/a.ts", "src/new.ts (new)"],
      },
    ],
  };
  const normalised = repairOmittedDeliverablePaths(
    { "task-1": WS("task-1", ["src/a.ts"]) },
    SPEC_N,
    [],
  );
  assert(
    JSON.stringify(normalised?.added) === JSON.stringify(["src/new.ts"]),
    "normalise once: the appended entry is the normalised path, not the annotated one",
  );
}

// ----------------------- 4f. planKill: the killed primary is not repaired, halts as before

{
  const ws = { "task-1": WS("task-1", ["src/a.ts"]) };
  const base = initialState(1439, 1);
  const r = await runPlanQualityTail(
    {
      issue: 1439,
      repoRoot: "/repo",
      protectedGrant: [],
    } as unknown as CycleContext,
    {
      next: base,
      report: { ...emptyWorkstreamReport(), accepted: 1, workstreams: ws },
      workstreams: ws,
      firstPlanRaw: ws,
      findingsCount: 1,
      spec: SPEC,
      planGateEnabled: true,
      planKill: true,
      redispatched: false,
    },
    HOST,
  );
  assert(r.halted, "planKill with an omitted spec path: the step halts as before");
  assert(
    JSON.stringify(r.workstreams["task-1"]?.paths) === JSON.stringify(["src/a.ts"]),
    "planKill: the killed primary's paths are not repaired",
  );
}

// ------------------------------------------------------------ 5. N=2: unchanged

{
  const ws = {
    "task-a": WS("task-a", ["src/a.ts"]),
    "task-b": WS("task-b", ["src/b.ts"]),
  };
  assert(
    repairOmittedDeliverablePaths(ws, SPEC, []) === undefined,
    "N=2: nothing is repaired, whichever workstream would own the missing paths",
  );
  const r = await tail(ws, SPEC, []);
  assert(r.halted, "N=2 omitted spec paths: the gate still halts as before");
  assert(
    JSON.stringify(r.workstreams["task-a"]?.paths) === JSON.stringify(["src/a.ts"]),
    "N=2: no workstream's paths are changed",
  );
}

// ------------------------------- 6. N=1 with a refused call: a second defect, stands down

{
  const ws = { "task-1": WS("task-1", ["src/a.ts"]) };
  const next = initialState(1439, 1);
  const report = {
    ...emptyWorkstreamReport(),
    accepted: 1,
    workstreams: ws,
    refused: [{ id: "task-1", reason: "duplicate id" }],
  };
  const ctx = {
    issue: 1439,
    repoRoot: "/repo",
    protectedGrant: [],
  } as unknown as CycleContext;
  const r = await runPlanQualityTail(
    ctx,
    {
      next,
      report,
      workstreams: ws,
      firstPlanRaw: ws,
      findingsCount: 1,
      spec: SPEC,
      planGateEnabled: true,
      planKill: false,
      redispatched: false,
    },
    HOST,
  );
  assert(
    JSON.stringify(r.workstreams["task-1"]?.paths) === JSON.stringify(["src/a.ts"]),
    "N=1 with a refused call: the repair does not run (the refusal is the other defect)",
  );
}

// -------------------------------------------------------- 7. gate off: unchanged

{
  const ws = { "task-1": WS("task-1", ["src/a.ts"]) };
  const r = await tail(ws, SPEC, [], false);
  assert(
    JSON.stringify(r.workstreams["task-1"]?.paths) === JSON.stringify(["src/a.ts"]),
    "plan gate off: the repair does not run and the paths are untouched",
  );
}

process.exit(exit);
