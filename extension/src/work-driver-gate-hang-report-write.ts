/**
 * #1427 — the single write site for a gate-hang report, so every gate seam
 * (per-worktree, consolidated, commit-pr) asks the same question in the same
 * order: was this run killed at its wall-clock bound, and what did its group
 * look like at the kill?
 *
 * Extracted from `work-driver-consolidated-verify.ts` (AGENTS.md §12's 500-line
 * gate). It deliberately does NOT know about cherry-picks, restore claims, or
 * the flake re-run: it takes the stream, the tree the caller walked, and where
 * to put the file, and returns the path or `undefined`.
 */

import type { HangProcess } from "./work-driver-gate-hang.ts";
import { writeGateHangLog } from "./work-driver-verify-flake.ts";

export interface GateHangWrite {
  scratchDir: string;
  timestamp: string;
  /** The killed run's combined stream (slow-test lines + output tail). */
  rawFailure: string;
  verifyCmd: string;
  repoRoot: string;
  timeoutMs: number;
  /** The tree the caller captured in its `catch` — never re-walked here. */
  tree?: { processes: HangProcess[]; treeUnavailable?: string };
  /** The leader whose group was killed, when the executor reported one. */
  leaderPid?: number;
  /** Filename discriminator; defaults to `consolidated` for the probe. */
  tag?: string;
}

/** The persisted report's path, or `undefined` when nothing could be written. */
export function writeGateHangReport(w: GateHangWrite): string | undefined {
  return writeGateHangLog(
    w.scratchDir,
    w.timestamp,
    {
      output: w.rawFailure,
      cmd: w.verifyCmd,
      cwd: w.repoRoot,
      timeoutMs: w.timeoutMs,
      ...(w.tree !== undefined
        ? {
            processes: w.tree.processes,
            ...(w.tree.treeUnavailable !== undefined
              ? { treeUnavailable: w.tree.treeUnavailable }
              : {}),
          }
        : {}),
      ...(w.leaderPid !== undefined ? { leaderPid: w.leaderPid } : {}),
    },
    // The tree was captured by the caller at the kill and is handed in, so the
    // report and the failure-string clause describe ONE snapshot; the tag keeps
    // the name distinct from a per-worktree report written at the same instant.
    { tag: w.tag ?? "consolidated" },
  );
}
