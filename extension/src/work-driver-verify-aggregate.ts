/**
 * work-driver-verify-aggregate — the develop verify gate's post-run half:
 * reconcile the consolidated result with the per-worktree failures, then
 * attribute a failure against the base commit.
 *
 * Why this seam: `runVerifyCommandGate` in
 * `work-driver-verify-verify-cmd.ts` had grown to 542 lines, past the
 * 500-line cap AGENTS.md §12 enforces. Once the per-worktree loop has run and
 * the consolidated run has reported, what remains is a POST-RECONCILIATION
 * step with no more runs in it — it reads two already-computed values and the
 * caller's `failures`/`notes`, and it is the only place the baseline probe is
 * paid for. Splitting it leaves the two execution legs (per-worktree,
 * consolidated) exactly where they were, which matters: their ordering, the
 * #782 flake-retry precondition and the #1427 hang-report sink are
 * concurrency-sensitive and were not what overflowed the cap.
 *
 * Import chain: work-driver-verify-verify-cmd.ts → this file →
 * work-driver-verify-baseline.ts (acyclic; the caller already imports that
 * module for the same call, so no new dependency edge is introduced).
 */

import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";
import type { CycleContext, DriverExecFn } from "./work-driver-context.ts";
import { isHostExhaustionFailure } from "./work-driver-exec-error.ts";
import { baselineExplainsChange, compareWithBaseline } from "./work-driver-verify-baseline.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";
import { isVerifyTimeoutFailure } from "./work-driver-verify-develop-helpers.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

/**
 * Reconcile and attribute. Returns whether the baseline probe ATTRIBUTED the
 * failure — the caller turns that into its `verifyCmdEnd` marker.
 */
export async function aggregateVerifyOutcome(args: {
  execFn: DriverExecFn;
  ctx: CycleContext;
  cmd: string;
  baseSha: string | undefined;
  /** The suite tier's bound, resolved ONCE by the caller and threaded here. */
  suiteTimeoutMs: number;
  /** The consolidated run's outcome, already reported to `failures`/`notes`. */
  cons: ConsolidatedVerifyResult;
  /** Failures the per-worktree leg recorded; kept as failures regardless. */
  perWorktreeVerifyFailures: string[];
  failures: string[];
  notes: string[];
  /** #1349 — the base run fails the way the change's run does (the excuse). */
  onBaselineAttributed?: () => void;
  /** #1765 — the branch step's in-cycle verdict, when the cycle holds one. */
  baseHealthProbe?: BaseHealthVerdict;
}): Promise<boolean> {
  const {
    execFn,
    ctx,
    cmd,
    baseSha,
    suiteTimeoutMs,
    cons,
    perWorktreeVerifyFailures,
    failures,
    notes,
    onBaselineAttributed,
    baseHealthProbe,
  } = args;

  // Aggregation: a consolidated FAILURE keeps per-worktree failures as
  // failures. A consolidated PASS does NOT downgrade them (#1005 reverses the
  // #669 downgrade): a workstream that fails in its OWN tree must block, even
  // when the combined tree passes — a combined run that passes does not excuse
  // a workstream that fails on its own (the #933/#996 shape: 0/5 and 1/5
  // workstreams passing their own gate, the split halves coupled). The
  // per-worktree failure is kept as a failure AND the passing consolidated run
  // is still noted (the evidence that the combination is not the cause is
  // preserved in the note; the per-worktree defect is not excused).
  if (perWorktreeVerifyFailures.length > 0) {
    failures.push(...perWorktreeVerifyFailures);
    for (const f of perWorktreeVerifyFailures) {
      notes.push(
        `per-worktree verify (evidence; still a failure — the consolidated pass does not excuse a per-worktree defect, #1005) — ${f}`,
      );
    }
  }

  // Baseline comparison — ONLY once the verify command has already failed
  // (never on the happy path: it costs a full gate run). Not when the host
  // could not fork: the probe cannot run there either, and its "red at base"
  // would be the same environment failure read as a verdict. See
  // work-driver-verify-baseline.ts.
  if (
    (cons.status === "failed" || perWorktreeVerifyFailures.length > 0) &&
    !failures.some(isHostExhaustionFailure)
  ) {
    const changeFailures = [
      ...(cons.status === "failed"
        ? [{ text: cons.rawFailure ?? "", timedOut: cons.timedOut === true }]
        : []),
      ...perWorktreeVerifyFailures.map((f) => ({
        text: f,
        timedOut: isVerifyTimeoutFailure(f),
      })),
    ];
    const verdict = await compareWithBaseline(execFn, {
      repoRoot: ctx.repoRoot,
      baseSha: baseSha as string,
      issue: ctx.issue,
      cmd,
      timeoutMs: suiteTimeoutMs,
      // The base probe runs the project's own command, so it gets the same
      // scrubbed env the change run got (#1642).
      env: verifyChildEnv(),
      changeFailures,
      failures,
      notes,
      // #1765 — the branch step's verdict for this key: no second suite run pays
      // for a verdict this cycle already holds.
      ...(baseHealthProbe !== undefined ? { cachedVerdict: baseHealthProbe } : {}),
    });
    if (verdict === undefined) return false;
    // #1765 — the excuse question is #1349's and stays its answer; what changed is
    // how the develop gate RAISES the cap on it. It used to require the probe's
    // entry to be the gate's ONLY failure at its own position, so one foreign
    // failure beside it (the work-item scope fence) dropped `verify-baseline-red`
    // to `verify-failed` and orchard burned three develop rounds on a base nothing
    // could pass. A reused verdict states the base's colour only: no stream, so
    // nothing to match the change's failures against, so never an excuse.
    const attributed = verdict.reused !== true && baselineExplainsChange(verdict, changeFailures);
    if (attributed) onBaselineAttributed?.();
    return attributed;
  }
  return false;
}
