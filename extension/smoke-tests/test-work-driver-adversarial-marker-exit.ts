#!/usr/bin/env bun
/**
 * #1863 round 3 — an adversarial pass that exits BEFORE it dispatched still
 * carries the marker the fan-out wrote for it.
 *
 * THE REACHABLE PATH a lens found. `fanOutAdversarial` persists the pass's
 * `dispatch-started` BEFORE it calls `runAdversarialWorkstream`, and the leaf's
 * two earliest exits — a failed diff read (#1634) and the #286 empty-diff skip
 * — returned an outcome built from a marker-fields snapshot taken at entry,
 * i.e. BEFORE the fan-out reassigned `wa.jobId` from `beginDispatch`'s result.
 * Such an outcome names no marker, so the splice drops the pass's own marker out
 * of the replacement region and emits nothing in its place: the step's tail is
 * the orphaned `dispatch-started`, the shape a crash-resume reads as "a dispatch
 * that never finished" and the shape `failureEventOf` (which reads only the tail)
 * is blind to. An outcome that DID claim the marker without its `at`/`label`
 * used to `throw` out of `outcomeEvents` — in the middle of batch assembly, after
 * every pass had cleared its marker — which aborted the whole cycle instead of
 * routing it.
 *
 * Both exits are driven through the REAL fan-out (`runAdversarial`, no stubbed
 * step), and the assertions are on the state the step RETURNS, which is what the
 * driver persists and what `nextStep()` routes on. Routing must be UNCHANGED
 * from origin/main: the diff-read exit still parks with
 * `adversarial-diff-unreadable`, the clean-tree exit still records the skip and
 * approves. Nothing here spawns; the reviewer seam records whether it was called.
 *
 * Offline: no spawn, no sleep.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { initCleanRepo } from "./lib/clean-repo-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "Adversarial APPROVED after round 1.\n",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
    ...overrides,
  };
}

function makeFakePi(): DriverHost {
  return {
    sendUserMessage: () => undefined,
    emit: () => undefined,
  } as unknown as DriverHost;
}

const SILENT_SINK: NonNullable<CycleContext["emitSink"]> = {
  emit: () => undefined,
  fingerprints: [],
};

/** The `dispatch-started` records of one step, narrowed so `.jobId` typechecks. */
function markersOf(
  eventLog: readonly WorkEvent[],
  step: "adversarial",
): Array<Extract<WorkEvent, { kind: "dispatch-started" }>> {
  return eventLog.filter(
    (e): e is Extract<WorkEvent, { kind: "dispatch-started" }> =>
      e.kind === "dispatch-started" && e.step === step,
  );
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";


// ── #1863 round 3 — an exit that never dispatched still carries its marker.
//
// THE REACHABLE PATH a lens found: the fan-out writes the `dispatch-started`
// BEFORE it calls the leaf, and the leaf's earliest exits — a failed diff read
// (#1634) and the #286 empty-diff skip — return an outcome built BEFORE the
// marker fields were threaded through. The splice then drops the pass's own
// marker out of the replacement region and emits nothing in its place, so the
// step's tail is the orphaned `dispatch-started`: the shape resume reads as "a
// dispatch that never finished", and `failureEventOf` (which reads only the
// tail) is blind to it. Worse, an outcome that DID claim the marker but not its
// `at`/`label` used to `throw` out of the batch builder and abort the cycle.
async function exitAfterWrittenMarker(
  name: string,
  mode: "diff-read-fails" | "empty-diff",
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), `work-driver-1863-marker-exit-`));
  try {
    initCleanRepo(dir);
    const s = initialState(1863, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: { default: dir },
      workstreams: { default: { id: "default", scope: "test", paths: [], outOfScope: [] } },
      branchName: "feature/issue-1863",
    };
    await writeState(dir, s);
    let loopCalls = 0;
    // The file-wide `= "0"` above DISABLES the #286 skip (it is a kill-switch);
    // this case's whole subject is the skip's own exit, so it restores it.
    process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "1";
    const ctx: CycleContext = {
      host: makeFakePi(),
      emitSink: SILENT_SINK,
      repoRoot: dir,
      issue: 1863,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async () => {
        loopCalls++;
        return mkResult();
      },
      // The read the pass makes FIRST, through the driver's exec seam. Both
      // modes get past `readDiffOrFailureOutcome` — one answers as git does for
      // an unreadable tree, the other for a clean one — so the exit is the
      // leaf's, not the read helper's.
      verifyExecFn: async (_cmd, o) => {
        const argv = o?.argv ?? [];
        if (argv.includes("--show-toplevel")) return { stdout: `${o?.cwd ?? ""}\n` };
        if (mode === "diff-read-fails") throw new Error("simulated git failure");
        return { stdout: "" };
      },
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        if (spec.role === "ops") return mkResult({ role: "ops", text: "pr: 9999" });
        throw new Error(`no dispatch expected: ${spec.role}/${opts?.label}`);
      },
    };
    // The step must not throw: a malformed marker is reported, never fatal.
    let after: Awaited<ReturnType<typeof readState>>;
    let throws = false;
    try {
      after = await runAdversarial(ctx, (await readState(dir, 1863))!, Date.now());
    } catch {
      throws = true;
    }
    assert(!throws, `${name}: the step does not throw on its ${mode} exit`);
    if (throws || !after) return;
    const tail = after.eventLog[after.eventLog.length - 1];
    assert(
      tail?.kind !== "dispatch-started",
      `${name}: the step's tail is NOT the orphaned write-ahead marker (tail: ${tail?.kind})`,
    );
    assert(
      markersOf(after.eventLog, "adversarial").length >= 1,
      `${name}: the pass's marker is still recorded after the splice (got ${markersOf(after.eventLog, "adversarial").length})`,
    );
    assert(
      after.pipelineState.inFlightJobIds.length === 0,
      `${name}: the marker was cleared (${JSON.stringify(after.pipelineState.inFlightJobIds)})`,
    );
    // Routing is what the fix must not change: the same exit on origin/main
    // routes on its own failure/skip event, not on a marker.
    if (mode === "diff-read-fails") {
      assert(loopCalls === 0, `${name}: the reviewer was never dispatched`);
      assert(
        after.eventLog.some((e) => e.kind === "dispatch-failed" && e.step === "adversarial"),
        `${name}: the failed read is recorded as a dispatch-failed`,
      );
      assert(
        after.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "adversarial-diff-unreadable"),
        `${name}: routes with the adversarial-diff-unreadable cap, as on main`,
      );
      assert(
        !after.eventLog.some((e) => e.kind === "adversarial-approved"),
        `${name}: an unreadable diff is never an approval`,
      );
    } else {
      assert(loopCalls === 0, `${name}: the reviewer was never dispatched for an empty diff`);
      assert(
        after.eventLog.some((e) => e.kind === "adversarial-skipped-empty-diff"),
        `${name}: still records the empty-diff skip, as on main`,
      );
      assert(
        after.eventLog.some((e) => e.kind === "adversarial-approved"),
        `${name}: a clean tree still routes to adversarial-approved, as on main`,
      );
    }
  } finally {
    process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";
    rmSync(dir, { recursive: true, force: true });
  }
}

await exitAfterWrittenMarker("diff-read failure after a written marker", "diff-read-fails");
await exitAfterWrittenMarker("empty-diff skip after a written marker", "empty-diff");
console.log(`\nexit ${exit}`);
process.exit(exit);
