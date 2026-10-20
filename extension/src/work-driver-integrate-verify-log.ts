/**
 * work-driver-integrate-verify-log — #1702: the commit-pr consolidated verify now
 * persists its own run logs, the way the develop-side seam already does.
 *
 * Split out of `work-driver-integrate-verify.ts` for the AGENTS.md §12 500-line cap, and
 * because it is one self-contained concern: what gets written where, and how the path gets
 * back to the cap.
 *
 * WHY THE SEAM EXISTS AT ALL. `CommitPrConsolidatedVerifyResult.logPath` and the cap event's
 * `logPaths` were documented as the commit-pr twin of #841's develop contract — and no
 * production path ever filled them. The develop seam passed `scratchDir` + a timestamp to
 * `writeConsolidatedVerifyLog`; this seam passed neither, so every `integration-verify-failed`
 * park carried an absent pointer while its own docstring promised the operator a file to
 * open. A field nothing writes is worse than no field: it makes the contract look held. The
 * end-to-end proof (a real `integrate()` whose park names a file that exists on disk) is in
 * `test-work-driver-integrate-verify-skip.ts`; this file pins the sink's own contract.
 *
 * THE WRITE'S RETURN IS THE PATH. `written` is what `writeConsolidatedVerifyLog` actually
 * returned (it never throws — an unwritable scratch dir yields `undefined`), and it is the
 * ONLY thing that reaches `logPath`. A path computed here from the scratch dir + a timestamp
 * would name a file that may not exist, which is the failure mode #841 named for the develop
 * side and why the write's own return is threaded rather than re-derived.
 *
 * run1 AND run2 both persist, under one timestamp so the pair shares a prefix: run2 is the
 * run whose stream is classified (a test that fails twice is not a flake), and run1 is the
 * only record of the case where run2 recovered.
 */

import { writeConsolidatedVerifyLog } from "./work-driver-verify-flake.ts";

/** What the seam knows about the logs it wrote during one verify call. */
export interface CommitPrVerifyLogSink {
  /** Persist the raw stream of run `run`; a no-op when the caller passed no scratch dir. */
  persist: (run: 1 | 2, raw: string) => void;
  /** The last log this seam actually wrote — `undefined` when nothing was written. */
  readonly written: string | undefined;
}

/**
 * Create the per-verify-call log sink.
 *
 * @param scratchDir the cycle's scratch dir (the same one `integrate()` uses for its
 *   conflict-patch artifact). `undefined` → the seam runs the same gate and writes no log,
 *   which is the shape every commit-pr park had before #1702.
 * @param onWritten the caller's sink — `integrate()` threads this into the terminal cap's
 *   `logPaths`, so the handoff names the file without parsing prose.
 */
export function createCommitPrVerifyLogSink(
  scratchDir: string | undefined,
  onWritten?: (logPath: string) => void,
): CommitPrVerifyLogSink {
  // One timestamp for the run pair, so run1 and run2 of one verify cycle share a prefix
  // (the develop-side consolidated verify uses the same naming).
  const timestamp = new Date().toISOString();
  let written: string | undefined;
  return {
    persist: (run, raw) => {
      if (scratchDir === undefined) return;
      const path = writeConsolidatedVerifyLog(scratchDir, timestamp, run, raw);
      if (path === undefined) return;
      written = path;
      onWritten?.(path);
    },
    get written() {
      return written;
    },
  };
}
