#!/usr/bin/env bun
/**
 * #382 — a crash mid-dispatch used to lose the cycle silently.
 *
 * The resume machinery was declared but inert: `resumable: false` was a
 * literal in the TYPE, `inFlightJobIds` was validated and rendered but never
 * written, and `dispatch-started` was never emitted at all — so the validator
 * that cross-checks them could only ever pass vacuously. State was persisted
 * only at step boundaries while a dispatch can run for thirty minutes, so a
 * crash inside that window left the file at the PREVIOUS boundary still
 * saying `running`. A dead cycle and a live one looked identical, forever.
 *
 * The tests below kill the driver mid-dispatch for real (the injected
 * `dispatchFn` throws a marker after the write-ahead has hit disk) and then
 * re-invoke it, because that is the only way to observe what a crash actually
 * leaves behind. Live evidence this matters: `.pi/work-state/547.json` and
 * `551.json` in this repo are stuck at `status: "running"` with empty event
 * logs — cycles that died and can never be resumed or diagnosed.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  classifyRunningState,
  clearDispatch,
  clearForResume,
  explainRefusal,
  explainResume,
  markDispatchStarted,
  mintJobId,
  processAlive,
  resumeEnabled,
} from "../src/work-driver-resume.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readQueueSummary, writeQueueSummary } from "../src/work-queue.ts";
import { renderCycleIndex } from "../src/work-status-index.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import {
  type WorkState,
  detectInconsistencies,
  initialState,
  readState,
  writeState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkPi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  return {
    pi: {
      sendUserMessage: (c: unknown) => {
        sent.push(typeof c === "string" ? c : JSON.stringify(c));
      },
    } as unknown as ExtensionAPI,
    sent,
  };
}

// ------------------------------------------------ the state transitions

{
  const base = initialState(700, 1_000_000);
  assert(base.resumable === false, "a fresh state is not yet resumable (no write-ahead has run)");
  assert(base.owner === undefined, "...and has no owner recorded");

  const jobId = mintJobId("develop", "developer", 111);
  const marked = markDispatchStarted(base, "develop", "developer", "developer", jobId, 111);
  assert(marked.resumable === true, "the write-ahead makes the state resumable");
  assert(marked.owner?.pid === process.pid, "and stamps the owning process");
  assert(marked.pipelineState.inFlightJobIds.includes(jobId), "the job id is recorded in-flight");
  assert(
    marked.eventLog.some((e) => e.kind === "dispatch-started" && e.jobId === jobId),
    "a dispatch-started event is emitted — it was previously never emitted anywhere in src/",
  );
  assert(
    detectInconsistencies(marked).length === 0,
    "the validator accepts a write-ahead state — before #382 it could only pass vacuously",
  );

  const cleared = clearDispatch(marked, jobId);
  assert(
    cleared.pipelineState.inFlightJobIds.length === 0,
    "settling the dispatch clears the marker (else the next run resumes a finished step)",
  );
  assert(
    cleared.eventLog.some((e) => e.kind === "dispatch-started"),
    "...but the dispatch-started event stays — it is the record that work was paid for",
  );
}

// ------------------------------------------------------- classification

const withInFlight = (over: Partial<WorkState> = {}): WorkState => {
  const s = initialState(701, 1_000_000);
  // `runSingleDispatch` sets currentStep before the write-ahead; mirror that
  // here, since the resumed step is read from currentStep.
  const atDevelop = {
    ...s,
    pipelineState: { ...s.pipelineState, currentStep: "develop" },
  } as WorkState;
  return {
    ...markDispatchStarted(atDevelop, "develop", "developer", "developer", "j1", 5),
    ...over,
  } as WorkState;
};

{
  const v = classifyRunningState(withInFlight({ owner: { pid: process.pid, at: 5 } }));
  assert(
    v.action === "resume" && v.step === "develop",
    "an in-flight dispatch whose owner is THIS process resumes (we are re-entering our own state)",
  );
}
{
  // A pid that cannot exist. The owner is gone, so the cycle crashed.
  const v = classifyRunningState(withInFlight({ owner: { pid: 2_147_483_646, at: 5 } }));
  assert(v.action === "resume", "an in-flight dispatch with a dead owner resumes");
}
{
  // The dangerous case: a LIVE owner. Resuming would run two drivers against
  // one branch and interleave their commits.
  const v = classifyRunningState(withInFlight({ owner: { pid: process.pid, at: 5 } }), 999_999);
  assert(
    v.action === "refuse" && v.ownerPid === process.pid,
    "a live owner is REFUSED, not joined — two drivers on one branch is worse than stopping",
  );
  assert(
    /already running/.test(explainRefusal(701, process.pid)) &&
      /interleave/.test(explainRefusal(701, process.pid)),
    "the refusal explains why, not just that",
  );
}
{
  const s = initialState(702, 1_000_000);
  assert(
    classifyRunningState(s).action === "fresh",
    "a clean step boundary with nothing in flight is not a resume — it just continues",
  );
}
{
  // The distinction the pre-existing skeleton test caught: an id with no
  // dispatch-started cannot have come from the write-ahead. It is corrupt
  // state, and resuming would clear the very field that proves the file is bad.
  const s = initialState(703, 1_000_000);
  const corrupt = {
    ...s,
    pipelineState: { ...s.pipelineState, inFlightJobIds: ["orphan"] },
  } as WorkState;
  assert(
    classifyRunningState(corrupt).action === "fresh",
    "an orphan job id with no dispatch-started is NOT treated as a crash",
  );
  assert(
    detectInconsistencies(corrupt).length > 0,
    "...so the existing inconsistency halt still fires on it",
  );
}
{
  const resumed = clearForResume(withInFlight());
  assert(
    resumed.pipelineState.inFlightJobIds.length === 0,
    "clearForResume drops the in-flight markers so the step can be re-entered",
  );
  assert(
    resumed.eventLog.some((e) => e.kind === "dispatch-started"),
    "...and keeps the orphaned dispatch-started, so a resumed cycle is distinguishable",
  );
}
{
  assert(processAlive(process.pid), "processAlive says this process is alive");
  assert(!processAlive(2_147_483_646), "and that an impossible pid is not");
  assert(!processAlive(0) && !processAlive(-1), "invalid pids are not alive");
}

// ------------------------------------------- crash and resume, end to end

/**
 * Proving the write-ahead reaches DISK before the await is the whole point,
 * so the fake dispatch reads the state file back mid-flight. A crash cannot
 * be simulated by throwing — `runSingleDispatch` catches that and the cycle
 * continues — and what matters is not the throw but what is already on disk
 * when the process dies.
 */
{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-resume-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    process.env.PI_ENSEMBLE_VERIFY = "0";
    let midFlight: WorkState | undefined;
    const { pi } = mkPi();
    await runWorkDriver({
      pi,
      repoRoot: dir,
      issue: 710,
      issueBodyFetcherFn: async () => ({ stdout: "title:\tt\nstate:\tOPEN\n\nbody" }),
      dispatchFn: async (_pi, spec) => {
        midFlight ??= (await readState(dir, 710)) ?? undefined;
        return {
          role: spec.role,
          ok: false,
          text: "",
          toolUses: [],
          ms: 1,
          exitCode: 1,
          transcriptPath: "/tmp/stub.json",
        } as DispatchResult;
      },
    } as DriverContext);

    assert(
      midFlight?.eventLog.some((e) => e.kind === "dispatch-started") === true,
      "the state file ON DISK carries dispatch-started WHILE the dispatch is still running",
    );
    assert(
      (midFlight?.pipelineState.inFlightJobIds ?? []).length > 0,
      "...and a non-empty inFlightJobIds — the field was never written anywhere before #382",
    );
    assert(
      midFlight?.resumable === true,
      "...and declares itself resumable (this was a literal `false` in the TYPE)",
    );
    assert(midFlight?.owner?.pid === process.pid, "...and names the owning process");

    const settled = await readState(dir, 710);
    assert(
      (settled?.pipelineState.inFlightJobIds ?? []).length === 0,
      "once the dispatch settles the marker is cleared, so a finished step is not resumed",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_VERIFY;
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // The morning after: a state file left exactly as a process death leaves it
  // — mid-dispatch, owner dead. Re-invoking `/work N` must resume rather than
  // fall through silently or demand a destructive `--restart`.
  const dir = mkdtempSync(path.join(tmpdir(), "pi-resume-crashed-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    process.env.PI_ENSEMBLE_VERIFY = "0";
    const s = initialState(712, 1_000_000);
    const crashed = markDispatchStarted(
      {
        ...s,
        pipelineState: { ...s.pipelineState, currentStep: "plan", lastCompletedStep: "explore" },
      } as WorkState,
      "plan",
      "plan",
      "plan",
      "j-plan",
      1,
    );
    // A pid that cannot be running: the owner is gone.
    await writeState(dir, { ...crashed, owner: { pid: 2_147_483_646, at: 1 } } as WorkState);

    const labels: string[] = [];
    const { pi, sent } = mkPi();
    await runWorkDriver({
      pi,
      repoRoot: dir,
      issue: 712,
      issueBodyFetcherFn: async () => ({ stdout: "title:\tt\nstate:\tOPEN\n\nbody" }),
      dispatchFn: async (_pi, spec, opts) => {
        labels.push(opts?.label ?? spec.role);
        return {
          role: spec.role,
          ok: false,
          text: "",
          toolUses: [],
          ms: 1,
          exitCode: 1,
          transcriptPath: "/tmp/stub.json",
        } as DispatchResult;
      },
    } as DriverContext);

    assert(
      sent.some((m) => /resuming at/.test(m)),
      "re-invoking a crashed cycle RESUMES — pre-#382 it fell through with no message at all",
    );
    assert(!labels.includes("explore"), "the already-completed explore step is NOT re-dispatched");
    assert(
      labels.length === 0 || labels[0] === "plan",
      "re-entry starts at the step that was in flight, not at the beginning",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_VERIFY;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------- queue state survives the session

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-queue-persist-"));
  try {
    assert(
      (await readQueueSummary(dir)) === undefined,
      "no prior queue run → no summary (absence is not an error)",
    );
    const summary = {
      entries: [
        {
          groupId: "g1",
          issues: [901],
          outcome: "parked" as const,
          reason: "cap intent-park:underspecified",
          humanAction: "add acceptance criteria to #901",
          tokens: 123_456,
          cost: 0.87,
        },
      ],
      merged: 0,
      parked: 1,
      notStarted: ["g2 (#902, #903)"],
    };
    await writeQueueSummary(dir, summary, 1000);
    const back = await readQueueSummary(dir);
    assert(back?.parked === 1, "the queue outcome round-trips to disk");
    assert(
      back?.notStarted[0] === "g2 (#902, #903)",
      "groups that NEVER STARTED survive — they leave no state file, so this is the only record they existed",
    );
    assert(
      back?.entries[0]?.humanAction === "add acceptance criteria to #901",
      "...and so does the human action for each parked group",
    );
    assert(
      back?.entries[0]?.tokens === 123_456 && back?.entries[0]?.cost === 0.87,
      "the optional per-group tokens/cost survive the queue-summary round-trip",
    );

    // The index is what the operator actually reads the next morning.
    const idx = renderCycleIndex([], 1000 + 3 * 60_000, {
      at: 1000,
      parked: 1,
      notStarted: ["g2 (#902, #903)"],
    });
    assert(
      /never started/.test(idx) && /g2/.test(idx),
      "the status index names the groups that never started",
    );
    assert(
      /3m ago/.test(idx),
      "...and how long ago, so a stale summary is not mistaken for this morning's",
    );
    assert(
      !/never started/.test(renderCycleIndex([], 1000)),
      "and says nothing when there is no queue history (no phantom line)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------- terminal files stay observable

{
  // #533 — the discriminant validator is RESUME-path-only. A TERMINAL state
  // file (merged/handoff/aborted) with an unknown event kind must still load:
  // a parked cycle's history has to stay observable, and a future additive
  // event kind on a terminal file must not stop /work-status from rendering.
  const dir = mkdtempSync(path.join(tmpdir(), "pi-533-terminal-"));
  try {
    const s = initialState(720, 1_000_000);
    const terminal = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged" as const,
        status: "merged" as const,
      },
      eventLog: [
        { kind: "step-started", step: "explore", at: 1 },
        { kind: "merged", at: 2, prNumber: 42 },
        // An unknown kind — e.g. an additive event written by a newer build.
        { kind: "not-a-real-kind", at: 3 },
      ],
    } as unknown as WorkState;
    await writeState(dir, terminal);

    const loaded = await readState(dir, 720);
    assert(loaded !== undefined, "readState loads a TERMINAL file with an unknown kind (no throw)");
    assert(
      loaded !== undefined && loaded.pipelineState.status === "merged",
      "...and /work-status can still render its history",
    );
    assert(
      validateDiscriminants(loaded as unknown).length === 1 &&
        validateDiscriminants(loaded as unknown)[0].includes("not-a-real-kind"),
      "the resume-path validator still NAMES the unknown kind (refuse, don't drop)",
    );

    // The contrast: a `running` file with the same unknown kind is what the
    // resume path refuses. Same file contents, different status — different
    // reader. (The driver-level refuse is asserted in test-work-driver-schema.ts.)
    const running = {
      ...s,
      eventLog: [{ kind: "not-a-real-kind", at: 3 }],
    } as unknown as WorkState;
    assert(
      validateDiscriminants(running as unknown).some((f) => f.includes("not-a-real-kind")),
      "...but the same unknown kind in a RUNNING file is a finding for the resume path",
    );

    // #539 review — the untyped-cast reader: a partial `commitPrRoot` object
    // (hand edit or corrupt write) must be refused at read, not flow into the
    // handoff renderers' arithmetic as if complete.
    const root = (over: Record<string, unknown>) =>
      validateDiscriminants({
        ...initialState(539, 1000),
        pipelineState: { ...initialState(539, 1000).pipelineState, commitPrRoot: over },
      } as unknown as Record<string, unknown>);
    const completeRoot = { branch: "feature/issue-539", unmergedPaths: [], stagedCount: 0, totalEntries: 0, capturedAt: 1 };
    assert(root(completeRoot).length === 0, "validateDiscriminants accepts a complete commitPrRoot");
    for (const [field, over] of [
      ["pipelineState.commitPrRoot.totalEntries", { ...completeRoot, totalEntries: undefined }],
      ["pipelineState.commitPrRoot.stagedCount", { ...completeRoot, stagedCount: "0" }],
      ["pipelineState.commitPrRoot.capturedAt", { ...completeRoot, capturedAt: null }],
      ["pipelineState.commitPrRoot.branch", { ...completeRoot, branch: 42 }],
      ["pipelineState.commitPrRoot.unmergedPaths", { ...completeRoot, unmergedPaths: "none" }],
    ] as Array<[string, Record<string, unknown>]>)
      assert(root(over).some((f) => f.includes(field)), `partial ${field} is refused at read and names the field`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ messages

{
  const m = explainResume(42, "develop", 2);
  assert(/#42/.test(m) && /develop/.test(m), "the resume message names the issue and the step");
  assert(
    /gone/.test(m) || /starts over/.test(m),
    "and is honest that the dead child's work is lost, not continued",
  );
}

// ------------------------------------------------------------ escape hatch

{
  const prev = process.env.PI_ENSEMBLE_RESUME;
  process.env.PI_ENSEMBLE_RESUME = "0";
  try {
    assert(!resumeEnabled(), "PI_ENSEMBLE_RESUME=0 restores the pre-#382 behaviour");
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_RESUME;
    else process.env.PI_ENSEMBLE_RESUME = prev;
  }
  assert(resumeEnabled(), "and resume is ON by default");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
