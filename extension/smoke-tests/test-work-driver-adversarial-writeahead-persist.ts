#!/usr/bin/env bun
/**
 * #1863 round 1 — a write-ahead that cannot persist must NOT dispatch a reviewer.
 *
 * The whole point of the write-ahead is that a killed review is on disk. If the
 * write fails and the reviewer is dispatched anyway — which is what the swallowed
 * `.catch(() => undefined)` did — the cycle spends a review whose death nothing
 * can record, and the crash-resume has nothing to read. So the pass must fail
 * closed: no reviewer call, and a NO-VERDICT infrastructure outcome with a
 * `dispatch-failed` tail, which is how every other write-ahead failure in the
 * driver routes.
 *
 * Split from test-work-driver-adversarial-writeahead.ts for the AGENTS.md §12
 * 500-line cap; the sibling file keeps the write-ahead / clear-on-exit cases.
 */

import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
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

function mkResult(): DispatchResult {
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

// ── A write-ahead that cannot persist must NOT dispatch a reviewer (#1863 round 1).
// The whole point of the write-ahead is that a killed review is on disk. If the
// write fails and the reviewer is dispatched anyway — which is what the swallowed
// `.catch(() => undefined)` did — the cycle spends a review whose death nothing
// can record, and the crash-resume has nothing to read. So the pass must fail
// closed: no reviewer call, and a NO-VERDICT infrastructure outcome with a
// `dispatch-failed` tail, which is how every other write-ahead failure in the
// driver routes.
async function persistFails(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), `work-driver-1863-persistfail-`));
  try {
    const s = initialState(1863, 1_000_000);
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: {},
      workstreams: undefined,
      branchName: "feature/issue-1863",
    };
    await writeState(dir, s);
    // A repository under the scratch root: the pass reads its diff before the
    // write-ahead, and a non-repository directory fails that read instead of
    // reaching the write.
    initCleanRepo(dir);
    // A real review would write the marker to `<repo>/.pi/work-state/1863.json`.
    // A root the caller cannot read (mode 000) is the honest shape of "the
    // persist failed": every write under it fails. The state the step is handed
    // is the in-memory one, so the step reaches its write-ahead and fails there.
    chmodSync(path.join(dir, ".pi", "work-state"), 0o000);
    let reviewerCalls = 0;
    const ctx: CycleContext = {
      host: makeFakePi(),
      emitSink: SILENT_SINK,
      repoRoot: dir,
      issue: 1863,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      // A real diff: an empty one short-circuits the review before the
      // write-ahead matters, which would make this case pass for the wrong
      // reason.
      verifyExecFn: (async () => ({
        stdout: "diff --git a/f.ts b/f.ts\n@@ -1 +1 @@\n-x\n+y\n",
      })) as unknown as DriverContext["verifyExecFn"],
      adversarialLoopFn: async () => {
        reviewerCalls++;
        return mkResult();
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };
    const after = await runAdversarial(ctx, s, Date.now());
    assert(
      reviewerCalls === 0,
      `a failed write-ahead dispatches NO reviewer (loop called ${reviewerCalls} time(s))`,
    );
    const started = markersOf(after.eventLog, "adversarial");
    assert(
      started.length === 0,
      `no marker claims a dispatch that was never written ahead (got ${started.length})`,
    );
    const failed = after.eventLog.filter(
      (e) => e.kind === "dispatch-failed" && e.step === "adversarial",
    );
    assert(
      failed.length >= 1,
      `the failure is recorded as a dispatch-failed the step router can classify (got ${failed.length})`,
    );
    assert(
      !after.eventLog.some((e) => e.kind === "dispatch-completed"),
      "nothing is reported as a completed review that never ran",
    );
    assert(
      !after.eventLog.some(
        (e) => e.kind === "adversarial-workstream-outcome" && e.outcome === "approved",
      ),
      "a failed write-ahead is never an approval",
    );
  } finally {
    // Restore the mode before removing: a 000 directory is not always walked
    // into by a recursive remove.
    try {
      chmodSync(path.join(dir, ".pi", "work-state"), 0o755);
    } catch {
      /* never created */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

await persistFails();

console.log(`\nexit ${exit}`);
process.exit(exit);
