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

import { trace } from "./trace.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Re-run `cmd` once in `cwd` (the SAME consolidated tree the first run ran
 * in — the caller must not restore in between). Returns the bounded,
 * attributed failure tail of the re-run when it fails (the caller classifies
 * that tail exactly as it would a single-run failure), or `undefined` when
 * the re-run passed (a flake — the caller proceeds).
 *
 * A re-run that errors in an unexpected way (a git error, an executor crash)
 * reports failure with a best-effort tail: a second run that is not a
 * clean pass is not evidence of recovery, so the cycle parks as if the
 * single run had failed.
 */
export async function rerunConsolidatedVerifyOnce(
  execFn: NonNullable<ExecFn>,
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<string | undefined> {
  trace(`work-driver: verify-flake — re-running \`${cmd}\` once in ${cwd}`);
  let rawFailure: string | undefined;
  try {
    await execFn(cmd, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const e = err as Error & { stderr?: string; stdout?: string };
    rawFailure = (e.stderr || e.stdout || e.message || "").toString().trim();
  }
  if (rawFailure === undefined) return undefined;
  const { tail } = extractAttributedTail(rawFailure, 800);
  return tail || rawFailure || "verify command exited non-zero";
}
