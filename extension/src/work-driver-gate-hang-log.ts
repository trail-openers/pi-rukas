/**
 * #1427 — writing a gate run's hang report to scratch.
 *
 * The full report (process tree, output tail, every still-running test name)
 * is too wide for the 800-char failure-string window the cap renderer keeps,
 * so the report lives in a file and only `gateHangClause`'s one line rides in
 * the evidence. The handoff names the path.
 *
 * Extracted from `work-driver-consolidated-verify.ts` (AGENTS.md §12's 500-line
 * gate) so the probe's run/restore logic keeps its shape; the write itself has
 * one job, one contract, and no dependency on the cherry-pick machinery beside
 * it. Same contract as `writeConsolidatedVerifyLog`: a report is diagnosis, so
 * a failed write is traced and returns `undefined` and NEVER changes the verify
 * outcome.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";
import type { GateHangInput, HangProcess } from "./work-driver-gate-hang.ts";
import { reportGateHang } from "./work-driver-gate-hang.ts";
import { VERIFY_LOG_MAX_BYTES, boundVerifyLog } from "./work-driver-verify-log-bounds.ts";

/**
 * #1427 — the filename of one gate-hang report, relative to `scratchDir`.
 * Its own prefix rather than the consolidated-verify one because a hang report
 * is written by every gate seam (per-worktree, consolidated, commit-pr, the
 * baseline probe), not only the consolidated run: an operator looking for the
 * report of a per-worktree hang should not have to know which seam produced it.
 */
function gateHangLogName(timestamp: string, tag?: string): string {
  const stamp = timestamp.replace(/[:.]/g, "-");
  // #1427 fix round — the timestamp alone collides when a fan-out kills two
  // gate runs in the same millisecond (every per-worktree run of one cycle is
  // started together), and the second write silently destroyed the first
  // report. The caller's discriminator is the workstream/cwd slug; when it is
  // absent a per-process counter keeps the name unique anyway.
  if (tag !== undefined && tag !== "") return `gate-hang-${stamp}-${slugName(tag)}.log`;
  return `gate-hang-${stamp}-${nextHangSeq()}.log`;
}

/** Filename-safe slug: path-ish input, lowercase, `[a-z0-9._-]` only, bounded. */
export function slugName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "run" : slug;
}

// #1427 fix round — the fallback discriminator when the caller has no slug:
// a monotonic per-process counter, so two writes in one millisecond never
// share a name.
let hangSeq = 0;
function nextHangSeq(): number {
  hangSeq += 1;
  return hangSeq;
}

/**
 * #1427 — persist a killed gate run's hang report and return the path, or
 * `undefined` when nothing could be written. Never fails the step (same
 * contract as `writeConsolidatedVerifyLog`, whose size bound it shares).
 *
 * The tree is NOT walked here: the caller captured it in its `catch`, in the
 * window where the killed group may still have been alive, and hands it in on
 * `input.processes` — one walk feeds both this file and the failure-string
 * clause, so the two cannot describe different snapshots for one kill.
 */
export function writeGateHangLog(
  scratchDir: string,
  timestamp: string,
  input: GateHangInput,
  deps: {
    walk?: (leaderPid: number) => { processes: HangProcess[]; treeUnavailable?: string };
    /** #1427 fix round — the per-run discriminator (workstream id or cwd). */
    tag?: string;
  } = {},
): string | undefined {
  const file = path.join(scratchDir, gateHangLogName(timestamp, deps.tag));
  try {
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(file, boundVerifyLog(reportGateHang(input, deps)), "utf8");
    chmodSync(file, 0o600);
    trace(`work-driver: gate hang — report written to ${file}`);
    return file;
  } catch (err) {
    trace(
      `work-driver: gate hang — could not write the report: ${(err as Error).message?.slice(0, 160)}`,
    );
    return undefined;
  }
}
