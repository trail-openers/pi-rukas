#!/usr/bin/env bun
/**
 * #1360 lens 5, arms 1-2 — the params the `adversarial_loop` TOOL hands the loop.
 *
 * The loop is stubbed here so the params object the tool's `work` thunk builds is
 * readable verbatim. Everything the issue claims about provenance is a claim
 * about THAT object: that it carries the minted marker, and that a caller's raw
 * args can neither set it nor clear it.
 */

import { mock } from "bun:test";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type LoopParams = Record<string, unknown> & { context?: string };
const loopCalls: LoopParams[] = [];
const startJobWork: Array<{ work: (s: AbortSignal, h: { jobId: string }) => unknown }> = [];

// startJob is where a tool's `work` thunk gets invoked; the mock runs it inline
// so the params are recorded without the async-job registry. The rest of the
// module's surface is forwarded verbatim — other modules re-export names from
// here and a stub that drops them breaks the import graph.
const asyncJobsSurface = await import("../../../src/async-jobs.ts");
mock.module(new URL("../../../src/async-jobs.ts", import.meta.url).href, () => ({
  ...asyncJobsSurface,
  startJob: (_pi: unknown, spec: { work: (s: AbortSignal, h: { jobId: string }) => unknown }) => {
    startJobWork.push(spec);
    void spec.work(new AbortController().signal, { jobId: "job-provenance" });
    return { jobId: "job-provenance" };
  },
}));

// The loop is a recorder: arms 1-2 assert on what the tool handed it, and
// nothing here is about review rounds. Registered BEFORE adversarial-tool.ts is
// imported, because that module resolves `./adversarial.ts` at its own load.
mock.module(new URL("../../../src/adversarial.ts", import.meta.url).href, () => ({
  MAX_ROUNDS: 3,
  runAdversarialLoop: async (params: LoopParams) => {
    loopCalls.push(params);
    return { ok: true, text: "", toolUses: [], ms: 1, exitCode: 0, loopOutcome: "approved" };
  },
}));

const deckSurface = await import("../../../src/dispatch-deck.ts");
mock.module(new URL("../../../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...deckSurface,
  startEntry: () => {},
  updateEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
  clearBatchEntry: () => {},
}));

const { registerAdversarialTool } = await import("../../../src/adversarial-tool.ts");
const { isToolPathProvenance } = await import("../../../src/adversarial-loop-params.ts");

/** Drive the real tool registration and return the params its `work` thunk
 * handed to `runAdversarialLoop`. */
async function driveTool(raw: Record<string, unknown>): Promise<LoopParams> {
  loopCalls.length = 0;
  startJobWork.length = 0;
  let tool: { execute: (id: string, raw: unknown) => Promise<unknown> } | undefined;
  registerAdversarialTool({
    registerTool: (t: unknown) => {
      tool = t as { execute: (id: string, raw: unknown) => Promise<unknown> };
    },
    on: () => {},
  } as never);
  if (!tool) throw new Error("the adversarial_loop tool was never registered");
  await tool.execute("call-1", raw);
  return loopCalls[0] ?? {};
}

// ── 1. the tool mints the marker, and raw args cannot clear or set it
const honest = await driveTool({ context: "honest", diff: "diff --git a/f b/f\n+x" });
assert(
  isToolPathProvenance(honest.toolPath),
  `tool path: the params reaching runAdversarialLoop carry the minted marker (got ${JSON.stringify(honest.toolPath)})`,
);
assert(
  honest.toolPath !== true,
  "tool path: the marker is NOT a bare `true` — a boolean widens through a spread and can be cleared",
);

const spoofFalse = await driveTool({
  context: "spoof",
  diff: "diff --git a/f b/f\n+x",
  toolPath: false,
});
assert(
  isToolPathProvenance(spoofFalse.toolPath),
  `raw args carrying toolPath:false STILL reach the loop with the marker — a caller cannot opt its row out of the bindings (got ${JSON.stringify(spoofFalse.toolPath)})`,
);

const spoofTrue = await driveTool({
  context: "spoof3",
  diff: "diff --git a/f b/f\n+x",
  toolPath: true,
});
assert(
  isToolPathProvenance(spoofTrue.toolPath),
  `raw args carrying toolPath:true do not satisfy the marker by widening (got ${JSON.stringify(spoofTrue.toolPath)})`,
);

// The other raw fields still pass through, so the strip did not eat the call.
assert(
  spoofTrue.context === "spoof3" && String(spoofTrue.diff).includes("diff --git"),
  "stripping a forged toolPath does not drop the caller's other params",
);
assert(
  spoofTrue.callerSuppliedDiff === true,
  "the #1161 callerSuppliedDiff policy still sets after the spread",
);
assert(
  "pi" in honest && honest.fixFence !== undefined,
  "the tool still threads pi + the #1104 fixFence through the spread",
);
assert(
  honest.reportVerdict === undefined && honest.reportOnly === false,
  "the #1154 verdict policy still resolves from reportOnly after the spread",
);
const terminal = await driveTool({ context: "ro", diff: "d", reportOnly: true });
assert(
  terminal.reportVerdict === "terminal" && terminal.reportOnly === true,
  "reportOnly:true still resolves the terminal verdict policy",
);
assert(
  startJobWork.length > 0,
  "the tool really went through startJob — the thunk this file observed is the production one",
);

// ── 2. the predicate refuses every value the runtime could not have minted
for (const forged of [true, false, undefined, null, "true", "", "adversarial-loop-tool ", 1]) {
  assert(
    isToolPathProvenance(forged) === false,
    `isToolPathProvenance(${JSON.stringify(forged)}) is false — only the minted string satisfies it`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
