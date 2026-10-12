/**
 * #1016 — the handoff's fan-out labels for an N=1 develop. An N=1 workstream
 * emits no branch-completed per attempt, so a fresh green must read "ok", never
 * "kept (ok)"; only a crash-resume re-record (resumed:true) reads "kept (ok)".
 */
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.log(`✗ ${msg}`);
    exit = 1;
  }
}

const { fanoutVerdictLines } = await import("../src/work-driver-handoff-fanout.ts");

const stateWith = (eventLog: WorkEvent[], verdicts?: Array<{ id: string; ok: boolean; reason?: string }>) =>
  ({
    schemaVersion: 1,
    issue: 1,
    updatedAt: 0,
    pipelineState: { currentStep: "handoff", inFlightJobIds: [] },
    eventLog: verdicts
      ? [
          ...eventLog,
          { kind: "branches-converged", step: "develop", verdicts, at: 99 },
        ]
      : eventLog,
  }) as unknown as WorkState;

// N=1 fresh green: the step-started, then the converged verdict, no branch-completed.
{
  const s = stateWith(
    [
      { kind: "step-started", step: "develop", at: 1 },
      { kind: "step-started", step: "verify", at: 2 },
    ] as WorkEvent[],
    [{ id: "default", ok: true }],
  );
  const texts = fanoutVerdictLines(s).map((l) => l.text);
  assert(texts.join() === "default: ok", `#1016 N=1: a fresh green reads "ok" (got ${texts.join()})`);
}

// N=1 failed then green-free: unchanged FAIL wording.
{
  const s = stateWith(
    [{ kind: "step-started", step: "develop", at: 1 }] as WorkEvent[],
    [{ id: "default", ok: false, reason: "boom" }],
  );
  const texts = fanoutVerdictLines(s).map((l) => l.text);
  assert(texts.join() === "default: FAIL — boom", `#1016 N=1: a failure keeps its reason (got ${texts.join()})`);
}

// A crash-resume re-record is the only "kept (ok)".
{
  const s = stateWith(
    [
      { kind: "step-started", step: "develop", at: 1 },
      { kind: "branch-completed", step: "develop", workstreamId: "task-a", ok: true, ms: 0, at: 2, resumed: true },
    ] as WorkEvent[],
    [{ id: "task-a", ok: true }],
  );
  const texts = fanoutVerdictLines(s).map((l) => l.text);
  assert(texts.join() === "task-a: kept (ok)", `#1016: a resumed green reads "kept (ok)" (got ${texts.join()})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
