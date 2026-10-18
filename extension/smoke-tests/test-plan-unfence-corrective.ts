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
    const first = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts, src/a.ts",
      "- out-of-scope: src/a.ts, docs/",
      "",
      "### task-b — the other half",
      "- paths: src/b.ts",
      "- out-of-scope: src/a.ts",
      "",
    ].join("\n");
    const second = [
      "## Workstreams",
      "",
      "### task-a — the fix",
      "- paths: src/a.ts, extension/src/dispatch.ts",
      "- out-of-scope: extension/src/dispatch.ts, docs/",
      "",
      "### task-b — the other half",
      "- paths: src/b.ts",
      "- out-of-scope: src/a.ts",
      "",
    ].join("\n");
    const tmp = `${process.env.TMPDIR ?? "/tmp"}/plan-unfence-corr-${process.pid}.md`;
    await Bun.write(tmp, body);
    const prompts: string[] = [];
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
          text: prompts.length === 1 ? first : second,
          toolUses: [],
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
    assert(
      (next.pipelineState.planQuality?.unfence?.removed ?? 0) >= 1,
      "and that it records the fence it removed",
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
  exit === 0 ? "\nAll plan-unfence corrective-parity assertions passed." : "\nFAILURES above.",
);
process.exit(exit);
