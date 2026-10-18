#!/usr/bin/env bun
/**
 * #1167 round-4 — the plan recovered after a KILLED primary gets the same
 * normalisation the primary and the quality corrective get.
 *
 * `runPlan` has three paths to a plan the cycle keeps: the primary reply, the
 * #290 quality corrective, and the #754 corrective that recovers a dispatch
 * killed at the step's own bound. The first two ran the fold, the coupling
 * merge and the #1167 unfence; the third ran none of them — the two passes
 * were composed by hand at each call site and only two sites got both. So a
 * cycle whose first planner was killed reached develop with the planner's
 * fences intact, and the develop gate parked on a file the issue itself names:
 * the #1020 shape arriving through the recovery door, which is the door a
 * slow planner always comes out of.
 *
 * All three paths now go through `runPlanNormalisationPass`, and this file
 * pins the one that had nothing.
 */

import { runPlan } from "../src/work-driver-plan.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A grep/read stub that COUNTS its calls. Every named symbol is defined in
 * exactly one source file. The counter is the round-5 assertion: each
 * normalisation pass re-spawns the `git grep` for every identifier the issue
 * named, so the number of greps is the number of passes — an exact proxy for
 * "normalised once" that does not depend on which internal helper fired.
 */
function stubExec(definitions: Record<string, string[]>, counter: { greps: number }) {
  return async (_cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    if (argv[0] === "grep") {
      counter.greps += 1;
      const name = argv[4] ?? "";
      return { stdout: (definitions[name] ?? []).map((f) => `${f}\n`).join("") };
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

// The kill branch is reached directly (the primary is killed, the corrective
// answers), so the resume and cross-group gates are off to keep this one
// dispatch each.
process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS = "0";
try {
  const body = [
    "# Title",
    "",
    "## Resolved decisions",
    "- The seam lives in extension/src/dispatch.ts.",
    "",
    "## Out of scope",
    "- nothing else",
  ].join("\n");
  // `paths` are declared so the quality gate stays quiet — the ONLY corrective
  // on this fixture is the kill-triggered one, which is the path under test.
  const plan = [
    "## Workstreams",
    "",
    "### default — the fix",
    "- paths: extension/src/dispatch-core.ts",
    "- out-of-scope: extension/src/dispatch.ts, docs/",
    "",
  ].join("\n");

  const tmp = `${process.env.TMPDIR ?? "/tmp"}/plan-unfence-kill-${process.pid}.md`;
  await Bun.write(tmp, body);
  const prompts: string[] = [];
  const greps = { greps: 0 };
  const ctx = {
    // biome-ignore lint/suspicious/noExplicitAny: the host is unused on this path
    host: {} as any,
    repoRoot: "/repo",
    issue: 1167,
    dispatchFn: async (_pi: unknown, spec: { prompt: string }) => {
      prompts.push(spec.prompt);
      if (prompts.length === 1) {
        // The primary is killed at the plan step's own bound: no output.
        return {
          role: "explore" as const,
          ok: false,
          text: "",
          toolUses: [],
          ms: 1,
          exitCode: 143,
          killCause: "timeout" as const,
          killBudgetMs: 30 * 60_000,
        };
      }
      return {
        role: "explore" as const,
        ok: true,
        text: plan,
        toolUses: [],
        ms: 1,
        exitCode: 0,
      };
    },
    verifyExecFn: stubExec({ dispatchCore: ["extension/src/dispatch.ts"] }, greps),
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
    "the kill-triggered corrective ran (that plan is the one under test)",
  );
  const ws = next.pipelineState.workstreams as Record<string, Workstream> | undefined;
  assert(
    !(ws?.default?.outOfScope ?? []).includes("extension/src/dispatch.ts"),
    "AC: the kill-recovered plan has no fence on the path the issue names (it is normalised like the primary's)",
  );
  assert(
    (ws?.default?.outOfScope ?? []).includes("docs/"),
    "and the fence the issue never named survives the recovery pass too",
  );
  assert(
    next.pipelineState.planQuality?.unfence?.ran === true,
    "the operator can see from the state file that the unfence ran on this recovered plan",
  );
  assert(
    (next.pipelineState.planQuality?.unfence?.removed ?? 0) >= 1,
    "and that it records the fence it removed",
  );
  // #1167 round-5 — the kill-recovered plan used to be normalised TWICE: the
  // kill branch ran the injected normaliser and `runPlan` then ran its own
  // `runPlanNormalisationPass` unconditionally over the same map. Every
  // `git grep` fired twice and the second pass's summary replaced the kill
  // branch's in the state file. The issue names exactly three identifiers here
  // (`seam`, `lives`, `in` — each resolved with one grep; the `dispatch.ts`
  // token is already a fence entry so it needs no grep), so one normalisation
  // is exactly THREE greps — restoring the double call doubles this to 6 and
  // turns the line red.
  assert(
    greps.greps === 3,
    `the kill-recovered plan is normalised exactly once — one grep per identifier the issue named (got ${greps.greps})`,
  );
  // The recorded summary is the KILL branch's, not a later pass's. Distinguishing
  // proof: a second pass over the already-unfenced map has no fence left to
  // remove, so it reports `removed: 0` — the `1` here can only be the kill
  // branch's own record of the fence it removed.
  assert(
    next.pipelineState.planQuality?.unfence?.removed === 1,
    "the recorded unfence summary is the kill branch's own record of the fence it removed",
  );
  await Bun.write(tmp, "");
  await Bun.$`rm -f ${tmp}`.quiet();
} finally {
  // Restored, not set to undefined: an absent variable and one holding
  // "undefined" are different to the reader, and a leak here would disable the
  // pass (or the resume gate) for every suite after this one.
  delete process.env.PI_ENSEMBLE_RESUME;
  delete process.env.PI_ENSEMBLE_CROSS_GROUP_CONFLICTS;
}

console.log(
  exit === 0 ? "\nAll plan-unfence kill-recovery assertions passed." : "\nFAILURES above.",
);
process.exit(exit);
