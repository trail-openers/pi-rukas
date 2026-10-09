/**
 * #1016 — crash-resume of a develop fan-out: only workstreams with a green
 * branch-completed in the INTERRUPTED attempt are preserved.
 */
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

{
  const { greenWorkstreamsFromInterruptedDevelop } = await import("../src/work-develop-greens.ts");
  const base = (over: Record<string, unknown>): WorkState =>
    ({
      schemaVersion: 1,
      issue: 1,
      updatedAt: 0,
      pipelineState: { currentStep: "develop", inFlightJobIds: ["j1"], ...over },
      eventLog: [],
    }) as unknown as WorkState;
  const bc = (id: string, ok: boolean) => ({
    kind: "branch-completed",
    step: "develop",
    workstreamId: id,
    ok,
    ms: 1,
    at: 1,
  });
  const started = { kind: "step-started", step: "develop", at: 1 };
  const crashed = base({});
  crashed.eventLog = [
    { kind: "step-started", step: "branch", at: 0 },
    started,
    bc("task-a", true),
    bc("task-b", false),
  ];
  const green = greenWorkstreamsFromInterruptedDevelop(crashed);
  assert(
    [...green].join() === "task-a",
    "#1016: only task-a (green before the crash) is preserved",
  );
  const notInFlight = base({ inFlightJobIds: [] });
  notInFlight.eventLog = crashed.eventLog;
  assert(
    greenWorkstreamsFromInterruptedDevelop(notInFlight).size === 0,
    "#1016: no marker → full re-entry",
  );
  const atBranch = base({ currentStep: "branch" });
  atBranch.eventLog = crashed.eventLog;
  assert(
    greenWorkstreamsFromInterruptedDevelop(atBranch).size === 0,
    "#1016: not at develop → full re-entry",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
