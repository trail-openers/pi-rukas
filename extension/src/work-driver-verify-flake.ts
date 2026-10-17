/**
 * work-driver-verify-flake — #782: the single bounded re-run for the
 * consolidated-tree verify seams (develop + commit-pr).
 *
 * A single transient flake on the consolidated gate (the #777 class: the
 * test-cancel.ts watchdog under parallel-fanout load) used to be classified
 * and parked, costing a full cycle + handoff for one flaky assertion. The
 * gate now re-runs the SAME command ONCE in the SAME still-checked-out
 * consolidated tree BEFORE classifying; when the re-run passes the caller
 * proceeds (emitting `verify-flake-recovered`), and when it fails the
 * caller classifies as today with `retries: 1, recovered: false` recorded.
 *
 * The caller is responsible for the preconditions — the retry fires ONLY
 * when every per-worktree verify passed, the consolidated run failed, and
 * the run is a genuine consolidation (workstreamCount > 1 at the develop
 * seam; the first consolidated run at the commit-pr seam). The re-run
 * happens BEFORE `classifyConsolidatedVerifyFailure` is called, so the
 * classifier's three-way contract and the N=1 invariant are unchanged.
 *
 * Lived in the callers per the issue's file-size budget note, but the
 * develop caller (work-driver-verify-develop.ts) is at the §12 500-line cap
 * — a shared helper keeps both seams identical without duplicating the
 * "extract a bounded, attributed tail from the raw failure" step.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withVerifySlot } from "./host-resources.ts";
import { trace } from "./trace.ts";
import type { GateHangInput, HangProcess } from "./work-driver-gate-hang.ts";
import { captureProcessTree, reportGateHang } from "./work-driver-gate-hang.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * #841 — the combined raw failure stream for a single consolidated verify
 * run. The pre-#841 shape used `e.stderr || e.stdout || e.message`, which
 * DROPPED stdout whenever stderr was non-empty (the ✗ / `FAILED:` lines in
 * `.pi/verify-cmd` are printed to stdout by the smoke-test loop's
 * `cat $CAPTURE`); the tail then classified only on the stderr fragment and
 * the operator was left with "(no specific assertion could be extracted)".
 * Concatenating stdout first then stderr matches the per-worktree verify
 * loop in work-driver-verify-verify-cmd.ts, which already does
 * `${stdout}\n${stderr}\n${message}`.
 *
 * Exported so the run1 / run2 log writes can use the SAME concatenation
 * (the ticket asks for a single helper — "concatenation" — and one home
 * is better than duplicating the expression at two call sites).
 */
export function combinedExecFailureStream(e: Error & { stderr?: string; stdout?: string }): string {
  return (
    `${(e.stdout ?? "").toString()}\n${(e.stderr ?? "").toString()}`.trim() ||
    (e.message || "").toString().trim()
  );
}

// #841 — the log filename for one consolidated verify run, relative to
// `scratchDir`. Single home for the name shape so the run1 and run2 paths
// (and the truncation cap below) cannot drift apart.
function consolidatedVerifyLogName(timestamp: string, run: 1 | 2): string {
  return `consolidated-verify-${timestamp.replace(/[:.]/g, "-")}-run${run}.log`;
}

// #841 — bound on a persisted run log. The raw stream can be large (the
// 8 MiB maxBuffer), and the log is diagnostic, not load-bearing: past the
// cap the operator still has the bounded tail in the evidence, so truncate
// with a marker instead of writing multi-MB scratch files.
const VERIFY_LOG_MAX_BYTES = 2 * 1024 * 1024;

// #841 — apply the size cap to a raw run stream before it is persisted.
function boundVerifyLog(raw: string): string {
  if (Buffer.byteLength(raw, "utf8") <= VERIFY_LOG_MAX_BYTES) return raw;
  const marker = "\n…[truncated — full output exceeded the 2 MiB log cap]\n";
  const max = VERIFY_LOG_MAX_BYTES - Buffer.byteLength(marker, "utf8");
  let out = raw;
  while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, Math.floor(out.length / 2));
  return out + marker;
}

/**
 * #841 — write the combined raw stdout+stderr of one consolidated verify run
 * to `<scratchDir>/consolidated-verify-<ISO timestamp>-run<1|2>.log`.
 * Never fails the step: a write error (unwritable scratch dir, ENOSPC,
 * etc.) is traced and returns `undefined` — the verify outcome is unchanged
 * and the caller's evidence string says the log is unavailable.
 *
 * `timestamp` is the SAME value for run1 and run2 of one verify cycle (the
 * ticket names them `consolidated-verify-<ISO timestamp>-run<1|2>.log` —
 * same prefix, different suffix), so the caller computes it once per run
 * pair and threads it through.
 */
export function rawOutputClause(logPath?: string): string {
  return logPath ? ` Raw output: ${logPath}.` : " Raw output: unavailable.";
}

/**
 * #1427 — the filename of one gate-hang report, relative to `scratchDir`.
 * Its own prefix rather than the consolidated-verify one because a hang report
 * is written by every gate seam (per-worktree, consolidated, commit-pr, the
 * baseline probe), not only the consolidated run: an operator looking for the
 * report of a per-worktree hang should not have to know which seam produced it.
 */
function gateHangLogName(timestamp: string): string {
  return `gate-hang-${timestamp.replace(/[:.]/g, "-")}.log`;
}

/**
 * #1427 — persist a killed gate run's hang report and return the path, or
 * `undefined` when nothing could be written. Never fails the step (same
 * contract as `writeConsolidatedVerifyLog`, whose size bound it shares):
 * the hang report is diagnosis, and the verify outcome is unchanged whether or
 * not the file exists.
 *
 * The full report — tree, output tail, every name — is too wide for the
 * 800-char failure-string window, which is why it lives here and only the
 * clause rides in the evidence. The handoff names this path.
 */
export function writeGateHangLog(
  scratchDir: string,
  timestamp: string,
  input: GateHangInput,
  deps: {
    walk?: (leaderPid: number) => { processes: HangProcess[]; treeUnavailable?: string };
  } = {},
): string | undefined {
  const file = path.join(scratchDir, gateHangLogName(timestamp));
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
export function writeConsolidatedVerifyLog(
  scratchDir: string,
  timestamp: string,
  run: 1 | 2,
  raw: string,
): string | undefined {
  const file = path.join(scratchDir, consolidatedVerifyLogName(timestamp, run));
  try {
    // mkdirSync(recursive) is idempotent — scratchDir is created elsewhere
    // at cycle start (the #750 precedent in work-driver-restore.ts uses the
    // same pattern), but a fresh cycle that skipped setupWorkspaceTmp still
    // writes. Failure here is caught below: a log-write error never changes
    // the verify outcome.
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(file, boundVerifyLog(raw), "utf8");
    // #841 — the raw stream can carry anything the verify command printed
    // (untrusted content); keep the log owner-only. A separate chmod (not
    // the write's mode option) also tightens a pre-existing log from an
    // older run; failure is caught below — a permission hiccup never
    // changes the verify outcome.
    chmodSync(file, 0o600);
    trace(`work-driver: consolidated verify — run${run} log written to ${file}`);
    return file;
  } catch (err) {
    trace(
      `work-driver: consolidated verify — could not write run${run} log: ${(err as Error).message?.slice(0, 160)}`,
    );
    return undefined;
  }
}

/**
 * Re-run `cmd` once in `cwd` (the SAME consolidated tree the first run ran
 * in — the caller must not restore in between). Returns the RAW failure
 * stream of the re-run when it fails (the caller extracts the bounded,
 * attributed tail from it exactly as it would for a single-run failure),
 * or `undefined` when the re-run passed (a flake — the caller proceeds).
 *
 * A re-run that errors in an unexpected way (a git error, an executor crash)
 * reports failure with a best-effort stream: a second run that is not a
 * clean pass is not evidence of recovery, so the cycle parks as if the
 * single run had failed.
 *
 * #841 — the re-run PERSISTS its raw stream (run2 log) when `scratchDir` +
 * `timestamp` are provided, and RETURNS the raw stream (not the bounded
 * tail) so the caller classifies it structurally instead of parsing prose.
 * The written run2 log path rides back as `logPath` — the ACTUAL return of
 * the write (`undefined` when it failed, so the caller never names a log
 * that does not exist); omitted when `scratchDir` is not provided
 * (commit-pr twin, which is intentionally out of scope for #841 per the
 * issue's DECISION).
 */
export async function rerunConsolidatedVerifyOnce(
  execFn: NonNullable<ExecFn>,
  cmd: string,
  cwd: string,
  timeoutMs: number,
  scratchDir?: string,
  timestamp?: string,
  /**
   * #1427 — injectable process-tree walker. The tree is walked here, in the
   * window between the executor's kill and the caller's classification: after
   * this function returns, the processes it must describe are gone.
   */
  walk?: (leaderPid: number) => { processes: HangProcess[]; treeUnavailable?: string },
): Promise<
  | {
      raw: string;
      logPath?: string;
      timedOut: boolean;
      /** #1427 — the tree captured at the kill, when this run was killed. */
      tree?: { processes: HangProcess[]; treeUnavailable?: string };
      /** #1427 — the leader pid whose group was killed, when the executor said. */
      treeLeaderPid?: number;
    }
  | undefined
> {
  trace(`work-driver: verify-flake — re-running \`${cmd}\` once in ${cwd}`);
  let rawFailure: string | undefined;
  // `killed` is how the executor reports its own timeout: the re-run was
  // stopped at the bound, so its stream ends wherever it happened to be.
  let timedOut = false;
  let tree: { processes: HangProcess[]; treeUnavailable?: string } | undefined;
  let treeLeaderPid: number | undefined;
  try {
    await withVerifySlot(() =>
      execFn(cmd, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }),
    );
  } catch (err) {
    const e = err as Error & {
      stderr?: string;
      stdout?: string;
      killed?: boolean;
      treePid?: number;
    };
    rawFailure = combinedExecFailureStream(e);
    timedOut = e.killed === true;
    // #1427 — walked synchronously in the catch, while the killed run's
    // grandchildren may still be alive: the nessie #1054 case is precisely
    // children that outlive the leader, and a walk after the settle would
    // report nothing about them.
    if (timedOut && typeof e.treePid === "number") {
      treeLeaderPid = e.treePid;
      tree = (walk ?? captureProcessTree)(e.treePid);
    }
  }
  if (rawFailure === undefined) return undefined;
  // #841 — persist the RAW run2 stream before the bounded tail is computed:
  // the run2 log is the operator's only record of what the second attempt
  // printed. The write's own return is threaded back (see the docblock) —
  // when it fails the caller says the log is unavailable, it never names
  // a precomputed path that does not exist on disk.
  if (scratchDir !== undefined && timestamp !== undefined) {
    const logPath = writeConsolidatedVerifyLog(scratchDir, timestamp, 2, rawFailure);
    return {
      raw: rawFailure,
      logPath,
      timedOut,
      ...(tree !== undefined ? { tree } : {}),
      ...(treeLeaderPid !== undefined ? { treeLeaderPid } : {}),
    };
  }
  return {
    raw: rawFailure,
    timedOut,
    ...(tree !== undefined ? { tree } : {}),
    ...(treeLeaderPid !== undefined ? { treeLeaderPid } : {}),
  };
}
