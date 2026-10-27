#!/usr/bin/env bun
/**
 * #1167 round-3 — the corrective plan gets the SAME normalisation the primary
 * plan got.
 *
 * The quality tail re-runs the coupling merge on the corrective's map but used
 * to skip the unfence, so a corrective that rewrote the `out-of-scope:` lines
 * (which it does — that is what the contradictory-fence steer tells it to do)
 * could reintroduce the fence the primary plan had just been protected from,
 * and develop then parked on `declared fence violated`. The two plans must not
 * be normalised differently.
 */

import { runPlan } from "../src/work-driver-plan.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";
import { planResultFromCalls } from "./lib/plan-workstream-calls.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function stubExec(definitions: Record<string, string[]>) {
  return async (_cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    if (argv[0] === "grep") {
      const name = argv[5] ?? "";
      return { stdout: (definitions[name] ?? []).map((f) => `${f}\0`).join("") };
    }
    if (argv[0] === "show") {
      const file = (argv[1] ?? "").split(":")[1] ?? "";
      const defining = Object.entries(definitions).find(([, files]) => files.includes(file))?.[0];
      return {
        stdout: defining
          ? `export function ${defining}(opts: unknown) {\n  return 1;\n}\n`
          : "//\n",
      };
    }
    return { stdout: "" };
  };
}

// The corrective path is reached only through the quality tail, so the resume
// and cross-group gates are turned off to keep this a single dispatch each.
process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
try {
  // The issue's own decisions name dispatch.ts; the planner fences it in BOTH
  // plans. Only the primary used to get it removed.
  const body = [
    "# Title",
    "",
    "## Resolved decisions",
    "- The seam lives in extension/src/dispatch.ts.",
    "",
    "## Out of scope",
    "- nothing else",
  ].join("\n");
  const first = planResultFromCalls([
    {
      id: "task-a",
      scope: "the fix",
      paths: ["src/a.ts", "src/a.ts"],
      outOfScope: ["src/a.ts", "docs/"],
    },
    { id: "task-b", scope: "the other half", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
  ]);
  const second = planResultFromCalls([
    {
      id: "task-a",
      scope: "the fix",
      paths: ["src/a.ts", "extension/src/dispatch.ts"],
      outOfScope: ["extension/src/dispatch.ts", "docs/"],
    },
    { id: "task-b", scope: "the other half", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
  ]);
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/plan-unfence-corr-${process.pid}.md`;
  await Bun.write(tmp, body);
  const prompts: string[] = [];
  // The corrective plan also declares docs/, so the N=1 docs/test rule would
  // open that fence itself and the issue-named removal the assertion below
  // counts would not be attributable to the pass under test. The rule is
  // judged by test-plan-unfence-issue-named.ts, not here.
  process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS = "0";
  const ctx = {
    // biome-ignore lint/suspicious/noExplicitAny: the host is unused on this path
    host: {} as any,
    repoRoot: "/repo",
    issue: 1167,
    dispatchFn: async (_pi: unknown, spec: { prompt: string }) => {
      prompts.push(spec.prompt);
      return {
        role: "explore" as const,
        ok: true,
        ...(prompts.length === 1 ? first : second),
        ms: 1,
        exitCode: 0,
      };
    },
    verifyExecFn: stubExec({ dispatchCore: ["extension/src/dispatch.ts"] }),
  };
  const state0 = {
    ...initialState(1167, 1_000_000),
    pipelineState: {
      ...initialState(1167, 1_000_000).pipelineState,
      issueBodyArtifact: tmp,
    },
  };
  const next = await runPlan(ctx, state0, 1_000_000);
  assert(
    prompts.length === 2,
    "the corrective re-dispatch ran (so its pass is the one under test)",
  );
  const ws = next.pipelineState.workstreams as Record<string, Workstream> | undefined;
  assert(
    !(ws?.["task-a"]?.outOfScope ?? []).includes("extension/src/dispatch.ts"),
    "AC: the CORRECTIVE plan has no fence on the path the issue names (it is normalised like the primary's)",
  );
  assert(
    (ws?.["task-a"]?.outOfScope ?? []).includes("docs/"),
    "and the fence the issue never named survives the corrective pass too",
  );
  assert(
    next.pipelineState.planQuality?.unfence?.ran === true,
    "the operator can see from the state file that the unfence ran on this plan",
  );
  // The fence the corrective's plan carried is recorded — by whichever authority
  // removed it. The planner wrote `extension/src/dispatch.ts` as BOTH a declared
  // path and a fence, so the entry never reaches the stored map: the tool boundary
  // takes a path-shaped self-fence off at the call boundary, and the issue-named
  // pass can only remove what the map still holds. Before #1862 that removal left
  // no trace at all (the boundary's drops were derived by re-diffing a second map
  // nobody kept), which is the disclosure this issue is about — so the assertion
  // accepts the removal under either counter and requires it under one of them:
  // a plan whose fence went with no record anywhere still fails here.
  assert(
    (next.pipelineState.planQuality?.unfence?.removed ?? 0) +
      (next.pipelineState.planQuality?.unfence?.selfFences ?? 0) +
      (next.pipelineState.planQuality?.unfence?.boundarySelfFences ?? 0) >=
      1,
    "and that it records the fence it removed, under the counter of whoever removed it",
  );
  // The stronger form, and the one that says WHICH: the entry the planner fenced
  // over its own declared path is named in the record's notes. This is the fact
  // a plan step used to erase — the fence is gone from the map, so an operator
  // reading only the map cannot tell it was ever there.
  assert(
    (next.pipelineState.planQuality?.unfence?.notes ?? []).some(
      (n) => n.startsWith("self-fence dropped: ") && n.includes("extension/src/dispatch.ts"),
    ),
    `and names the self-fence it removed, so the record says which fence went (got ${JSON.stringify(next.pipelineState.planQuality?.unfence?.notes)})`,
  );
  await Bun.write(tmp, "");
  await Bun.$`rm -f ${tmp}`.quiet();
} finally {
  // Restored, not set to undefined: an absent variable and one holding
  // "undefined" are different to the reader, and a leak here would disable the
  // pass (or the resume gate) for every suite after this one.
  delete process.env.PI_ENSEMBLE_RESUME;
  delete process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS;
  delete process.env.PI_ENSEMBLE_UNFENCE_DOCS_TESTS;
}

console.log(
  exit === 0 ? "\nAll plan-unfence corrective-parity assertions passed." : "\nFAILURES above.",
);
process.exit(exit);
