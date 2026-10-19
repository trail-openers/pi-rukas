#!/usr/bin/env bun
/**
 * #1676 — a protected path the plan deferred is fenced in every workstream.
 *
 * The plan-to-spec gate (#1642) does not require a deliverable's protected,
 * ungranted path, so the plan can leave it out of every workstream. Without a
 * fence the developer edits it and the protected-path halt parks the cycle.
 * These cases pin the fix:
 *
 *   1. the #1435 shape (deliverable [.pi/verify-cmd, extension/src/b.ts], one
 *      workstream with b.ts, no grant): .pi/verify-cmd is appended to that
 *      workstream's outOfScope as the BARE path, and the develop prompt names it
 *      with the protected annotation beside the fence;
 *   2. a path the --allow-protected grant covers is never appended;
 *   3. a re-run of the tail does not duplicate the entry;
 *   4. a workstream that declares the path in its own `paths` still gets the
 *      fence (the protected-path halt is the backstop, not an exemption);
 *   5. every workstream gets it, and the corrective-round prompt shows the same
 *      fence as the first develop prompt;
 *   6. with the plan gate off nothing is deferred, so nothing is appended.
 */

import type { CycleContext } from "../src/work-driver-context.ts";
import { correctiveDevelopPrompt } from "../src/work-driver-corrective-prompt.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import { emptyWorkstreamReport } from "../src/work-driver-plan-calls.ts";
import {
  deferredProtectedPaths,
  withDeferredProtectedFence,
} from "../src/work-driver-plan-fence.ts";
import {
  type PlanQualityHost,
  type PlanQualityInput,
  runPlanQualityTail,
} from "../src/work-driver-plan-quality-pass.ts";
import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state-update.ts";

// The tail's cross-group claim check writes a registry under repoRoot; this
// test is about the fence, so that side effect is switched off for the run.
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FENCE = ".pi/verify-cmd";

/** The #1435 spec: one mixed deliverable — a protected gate file and a source file. */
const SPEC: NormalisedSpec = {
  intent: "gate the verify command",
  deliverables: [
    {
      id: "d6",
      description: "gate config and the source file",
      paths: [FENCE, "extension/src/b.ts"],
    },
  ],
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

/** A plan host whose corrective must never run: every case here is judged on the first plan. */
const HOST: PlanQualityHost = {
  dispatch: async () => {
    throw new Error("no corrective dispatch expected in this test");
  },
  prompt: "primary plan prompt",
  slow: () => undefined,
  deck: () => ({}),
};

/** The fields the tail reads from the cycle context. */
function ctxWith(grant: string[]): CycleContext {
  return {
    issue: 1676,
    repoRoot: "/repo",
    protectedGrant: grant,
  } as unknown as CycleContext;
}

/** Run the plan quality tail over a one-report plan; the gate is on unless told otherwise. */
async function tail(
  workstreams: Record<string, Workstream>,
  grant: string[],
  planGateEnabled = true,
  spec: NormalisedSpec = SPEC,
) {
  const next = initialState(1676, 1);
  const input: PlanQualityInput = {
    next,
    report: { ...emptyWorkstreamReport(), accepted: Object.keys(workstreams).length, workstreams },
    workstreams,
    firstPlanRaw: workstreams,
    findingsCount: 1,
    spec,
    planGateEnabled,
    planKill: false,
    redispatched: false,
  };
  return runPlanQualityTail(ctxWith(grant), input, HOST);
}

// ------------------------------------------ 1. the #1435 shape, end to end

const deferred = deferredProtectedPaths(SPEC, []);
assert(
  JSON.stringify(deferred) === JSON.stringify([FENCE]),
  "the deferred list is the bare protected path, nothing else",
);

const first = await tail({ default: WS("default", ["extension/src/b.ts"]) }, []);
assert(!first.halted, "the #1435 shape: the plan gate passes (the unprotected half is covered)");
const fenced = first.workstreams.default;
assert(
  fenced?.outOfScope.includes(FENCE) === true,
  "the #1435 shape: .pi/verify-cmd is appended to the workstream's outOfScope",
);
assert(
  fenced?.outOfScope.join("|") === FENCE,
  "the appended entry is the bare normalised path, with no annotation inside it",
);
assert(
  fenced?.paths.join() === "extension/src/b.ts",
  "the workstream's own paths are untouched by the fence",
);

// The develop prompt names the path as off-limits and annotates it beside the fence.
const devPrompt = inlineDevelopPrompt(
  [1676],
  "/tmp/pi-rukas-dev/scratch",
  fenced,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  deferredProtectedPaths(SPEC, []),
);
assert(
  devPrompt.includes("OUT OF SCOPE — do NOT touch") && devPrompt.includes(`"${FENCE}"`),
  "the develop prompt names .pi/verify-cmd in its OUT OF SCOPE fence",
);
assert(
  devPrompt.includes("**Protected, no --allow-protected grant**") &&
    devPrompt.includes(`"${FENCE}" is a protected path`),
  "the develop prompt annotates the fenced entry as protected with no grant, beside the fence",
);

// ------------------------------------------ 2. a granted path is never appended

// A grant makes the deliverable required again, so the plan must cover the path itself.
const granted = await tail({ default: WS("default", ["extension/src/b.ts", FENCE]) }, [FENCE]);
assert(
  !granted.halted && granted.workstreams.default?.outOfScope.includes(FENCE) === false,
  "a path the --allow-protected grant covers is not appended to outOfScope",
);
const grantedPrompt = inlineDevelopPrompt(
  [1676],
  "/tmp/pi-rukas-dev/scratch",
  granted.workstreams.default,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  deferredProtectedPaths(SPEC, [FENCE]),
);
assert(
  !grantedPrompt.includes("Protected, no --allow-protected grant"),
  "a granted path gets no protected annotation in the develop prompt",
);

// ------------------------------------------ 3. a re-run does not duplicate

const again = await tail(first.workstreams, []);
assert(
  again.workstreams.default?.outOfScope.filter((e) => e === FENCE).length === 1,
  "re-running the tail over its own output does not duplicate the fence entry",
);
const pre = WS("default", ["extension/src/b.ts"], [FENCE]);
const preRun = withDeferredProtectedFence({ default: pre }, SPEC, []);
assert(
  preRun.default?.outOfScope.length === 1,
  "a fence the planner already wrote is not appended a second time",
);

// ------------------------------------------ 4. a self-declared path is still fenced

const selfDeclared = await tail({ default: WS("default", ["extension/src/b.ts", FENCE]) }, []);
assert(
  selfDeclared.workstreams.default?.outOfScope.includes(FENCE) === true,
  "a workstream that declares the deferred path in its own paths still gets the fence",
);

// ------------------------------------------ 5. every workstream, and the corrective

const two = await tail(
  {
    a: WS("a", ["extension/src/b.ts"]),
    b: WS("b", ["extension/src/c.ts"]),
  },
  [],
);
assert(
  !two.halted &&
    two.workstreams.a?.outOfScope.includes(FENCE) === true &&
    two.workstreams.b?.outOfScope.includes(FENCE) === true,
  "every workstream of the plan is fenced, not only the one that covers the deliverable",
);
const correctivePrompt = correctiveDevelopPrompt({
  issues: [1676],
  scratchDirAbs: "/tmp/pi-rukas-dev/scratch",
  workstreamId: "default",
  parallel: false,
  scope: "scope",
  paths: ["extension/src/b.ts"],
  command: "bun run test",
  lines: ["not ok 1 - b"],
  outOfScope: first.workstreams.default?.outOfScope ?? [],
  deferredProtected: deferredProtectedPaths(SPEC, []),
});
assert(
  correctivePrompt.includes("OUT OF SCOPE — do NOT touch") &&
    correctivePrompt.includes(`"${FENCE}"`) &&
    correctivePrompt.includes("**Protected, no --allow-protected grant**"),
  "the corrective-round prompt shows the same fence and protected annotation",
);

// ------------------------------------------ 6. the gate off: nothing deferred, nothing appended

const off = await tail({ default: WS("default", ["extension/src/b.ts"]) }, [], false);
assert(
  off.workstreams.default?.outOfScope.length === 0,
  "with the plan gate off nothing is appended",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
