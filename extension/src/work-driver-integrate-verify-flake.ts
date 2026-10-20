/**
 * work-driver-integrate-verify-flake — #782's single bounded flake retry on
 * the commit-pr consolidated verify, split out of
 * `work-driver-integrate-verify.ts` for the 500-line cap (AGENTS.md §12).
 *
 * The seam is the one the code already had: the verify module owns the run, the
 * classification and the attribution; everything here decides what happens
 * between "the first run failed" and "the failure is classified". Nothing here
 * reaches the report channel except by threading the env the caller built, and
 * nothing here can turn a failure into a pass on its own — a recovered flake is
 * reported to the caller, which decides what the cycle does with it.
 *
 * WHY THE RETRY EXISTS AT ALL. On a parallel fan-out the gate's own watchdog
 * timings drift (#777 / #296), and a consolidated tree that is genuinely fine
 * can fail its first run. A transient flake passes on the second; a real
 * consolidated defect fails both and is classified exactly as a single-run
 * failure would have been. A test that fails twice is not a flake, so this is
 * ONE re-run and never a loop.
 *
 * WHY THE PRECONDITION IS A PARAMETER AND NOT A LOOKUP HERE. `canRetry` is
 * (a) the first consolidated run at commit-pr (`isCiRetry` unset), (b) N>1 —
 * N=1 is a no-op consolidation whose failure is a per-workstream defect the
 * develop gate should have caught — and (c) every per-worktree verify passed.
 * The caller evaluates it from the step's own state; this module runs the
 * recipe and nothing else, which is what keeps the "re-run only on the FIRST
 * consolidated run" acceptance criterion in one place.
 */

import { trace } from "./trace.ts";
import { type HangProcess, NO_TREE_CAPTURED } from "./work-driver-gate-hang.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { FAST_TIER_LABEL } from "./work-driver-verify-fast.ts";
import { rerunConsolidatedVerifyOnce } from "./work-driver-verify-flake.ts";
import { createVerifyReportDir, createVerifyReportFile } from "./work-driver-verify-report-path.ts";
import type { ExecFn } from "./worktree.ts";

/** What one flake-retry pass settled on. */
export interface FlakeRetryOutcome {
  /**
   * The stream the caller classifies — the re-run's when it failed, the first
   * run's when no re-run was owed.
   */
  failure: string;
  /** The command the classified run executed (fast tier vs full command). */
  ranCmd: string;
  /** True when the classified run was killed at its bound. */
  timedOut: boolean;
  /** The killed run's stream, when the classified run was killed. */
  killedOutput: string;
  /**
   * The tree captured at the classified run's kill. `undefined` when that run
   * was not killed — the caller only reads it for the hang clause.
   */
  killedTree?: { processes: HangProcess[]; treeUnavailable?: string };
  /**
   * The re-run PASSED: the first-run failure was a flake. The caller records
   * the recovery on the PR (`verify-flake-recovered`) and proceeds — but only
   * the caller decides that, because only the caller owns the push.
   */
  recovered?: boolean;
}

/**
 * Run the #782 flake retry when `canRetry` holds, and settle on the failure the
 * caller classifies.
 *
 * @param execFn — shell executor (injection seam for tests).
 * @param opts.cmd — the configured verify command. The re-run's own stream
 *   decides whether the fast tier is what actually failed (`FAST_TIER_LABEL`).
 * @param opts.canRetry — the three-part precondition, evaluated by the caller.
 * @param opts.changeEnv — the env the re-run executes with, carrying the
 *   out-of-band report path. The re-run is the run whose failure is classified,
 *   so it is the run whose report has to exist; `undefined` (no channel) writes
 *   none, which reads as unattributable downstream.
 */
export async function runFlakeRetry(
  execFn: NonNullable<ExecFn>,
  opts: {
    cmd: string;
    /** The fast-tier command, or `undefined` when the project has none. */
    fastCmd: string | undefined;
    repoRoot: string;
    timeoutMs: number;
    canRetry: boolean;
    /** The first run's combined failure stream (raw, unbounded). */
    firstFailure: string;
    /** Whether the first run was killed at its bound. */
    firstTimedOut: boolean;
    /** The first run's captured tree, when it was killed. */
    firstTree?: { processes: HangProcess[]; treeUnavailable?: string };
    /** The command the first run actually executed. */
    ranCmd: string;
    /** The env carrying the out-of-band report path; absent → no report. */
    changeEnv?: NodeJS.ProcessEnv;
  },
): Promise<FlakeRetryOutcome> {
  const settled: FlakeRetryOutcome = {
    failure: opts.firstFailure,
    ranCmd: opts.ranCmd,
    timedOut: opts.firstTimedOut,
    killedOutput: opts.firstTimedOut ? opts.firstFailure : "",
    ...(opts.firstTimedOut && opts.firstTree !== undefined ? { killedTree: opts.firstTree } : {}),
  };
  if (!opts.canRetry) return settled;
  // #841 — this twin passes neither scratchDir nor timestamp, so the re-run
  // persists no log (out of scope per the ticket's DECISION) and returns the
  // RAW stream; the caller bounds it with the pre-existing
  // `extractAttributedTail` — nothing multi-MB reaches the evidence.
  // #1427 round 3 — no walker argument: this seam has no walker to thread, and
  // the re-run's tree comes from the executor's own `treePid` exactly as the
  // first run's does.
  const secondRun = await rerunConsolidatedVerifyOnce(
    execFn,
    opts.cmd,
    opts.repoRoot,
    opts.timeoutMs,
    undefined,
    undefined,
    // The driver's knobs never reach the project's gate. With no report
    // channel there is no env at all, which is the shape the executor reads
    // as "inherit everything" — so the scrub is built here rather than left
    // to the seam below, which honours an injected executor's own default.
    opts.changeEnv ?? verifyChildEnv(),
  );
  if (secondRun === undefined) {
    return { ...settled, recovered: true };
  }
  // The re-run failed — the caller classifies its tail exactly as a single-run
  // failure would be classified (a test that fails twice is not a flake, so the
  // cycle parks as it always did). The re-run's own capture replaces the first
  // run's: the report describes the run that ended the run.
  return {
    failure: secondRun.raw,
    ranCmd: opts.fastCmd && secondRun.raw.includes(FAST_TIER_LABEL) ? opts.fastCmd : opts.cmd,
    timedOut: secondRun.timedOut,
    killedOutput: secondRun.timedOut ? secondRun.raw : "",
    ...(secondRun.timedOut
      ? {
          killedTree: secondRun.tree ?? {
            processes: [] as HangProcess[],
            treeUnavailable: NO_TREE_CAPTURED,
          },
        }
      : {}),
  };
}

/**
 * The out-of-band report channel: the private dir and the two report paths, or
 * `undefined` when the OS would not create them (see the call site).
 */
export interface VerifyChannel {
  reportDir: string;
  changeReportFile: string;
  probeReportFile: string;
}

/**
 * Create the channel, or return `undefined` — never throw. These three calls are
 * the only fs calls in the seam's setup, and any of them can fail on a machine
 * with nowhere to put a temp dir. Losing the channel loses the excuse, never the
 * gate: with no report the probe reads nothing, excuses nothing, and the cycle
 * parks exactly as before #1404.
 */
export function createVerifyChannel(): VerifyChannel | undefined {
  try {
    const reportDir = createVerifyReportDir();
    return {
      reportDir,
      changeReportFile: createVerifyReportFile(reportDir, "change"),
      probeReportFile: createVerifyReportFile(reportDir, "base"),
    };
  } catch (err) {
    trace(
      `work-driver: commit-pr verify — the out-of-band verify report channel could not be created (${String((err as Error).message?.slice(0, 120))}); failing-test names cannot be attributed, so a consolidated verify failure parks as before #1404`,
    );
    return undefined;
  }
}
