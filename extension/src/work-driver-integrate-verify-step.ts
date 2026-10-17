/**
 * The commit-pr step-4 seam: verify the consolidated tree before it becomes a
 * PR.
 *
 * `integrate()` extracts this so the integration function holds one concern
 * (the AGENTS.md §12 line cap is the proximate reason; the substantive one is
 * that a verify seam with its own rollback contract is easier to read apart
 * from the consolidation that produced the tree).
 *
 * Two properties the callers depend on and that are worth stating together:
 *
 * - **Rolling back on failure is safe.** The worktrees still hold every
 *   workstream's commit; they are advanced past it only after a successful
 *   push, which `integrate()` owns. So the restore here is enough to leave the
 *   tree in the state a retry expects, and the returned `reason` says the
 *   branch was not pushed.
 * - **#777's classification happens here**, at the commit-pr twin of the
 *   develop seam, via the shared classifier — so the handoff names the specific
 *   assertion and the workstream combination instead of "the combination does
 *   not build".
 *
 * #1240 — when the cycle has one workstream and this integration is that
 * worktree's content and nothing else, the committed tree is the tree the
 * develop step already verified green, and the command is not run again. The
 * eligibility rule is `commitPrVerifiedTree`; the comparison against the
 * committed tree is `commitPrSkipDecision`. `skipped` is reported on the
 * result so the caller can record the visible event.
 */

import { commitPrVerifiedTree } from "./work-driver-integrate-eligibility.ts";
import { runCommitPrConsolidatedVerify } from "./work-driver-integrate-verify.ts";
import type { IntegrateOpts, IntegrateResult } from "./work-driver-integrate.ts";
import type { VerifiedRestoreResult } from "./work-driver-restore.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";

export interface IntegrationVerifyOpts {
  repoRoot: string;
  ids: string[];
  cherryApplied: string[];
  patchApplied: string[];
  noDiff: Record<string, unknown>;
  mode: "create" | "followup";
  /** The worktree the caller claims it integrated (N=1 create-mode only). */
  verifiedWorktree: string | undefined;
  verifyCmd?: string;
  verifyExecFn?: ExecFn;
  verifyTimeoutMs?: number;
  /**
   * #1404 — the cycle's original base commit for the baseline probe (see
   * `IntegrateOpts.baselineBaseSha`). Absent → no probe, every consolidated
   * failure fails the integration as before.
   */
  baselineBaseSha?: string;
  verifyRetry?: IntegrateOpts["verifyRetry"];
  /** Restores repoRoot to the ref `integrate()` recorded; see its docstring. */
  restoreRoot: () => Promise<VerifiedRestoreResult>;
  /** The verified restore post-condition, phrased once (`integrate()`'s). */
  claimFor: (r: VerifiedRestoreResult) => string;
}

export interface IntegrationVerifyOutcome {
  /**
   * A failure the caller returns verbatim; `undefined` means proceed to push.
   *
   * #1404 — the ONE exception is a failure the base commit accounts for
   * entirely: when `preExistingFailures` is set the failure object is still
   * present (the gate did fail, and this module has no authority to call that
   * a pass) but the field says every failing test is red at base too, and the
   * caller — `integrate()`, which owns the push — proceeds and carries the
   * names. So the contract is "return the failure verbatim UNLESS
   * `preExistingFailures` is set"; no other field licenses continuing.
   */
  failure?: Extract<IntegrateResult, { ok: false }>;
  /**
   * #1404 — failing test names that also fail at the cycle's base commit,
   * set ONLY when they are every failure the run produced. `integrate()`
   * pushes on it and records the names for the PR body and the handoff.
   */
  preExistingFailures?: string[];
  /** The identity that justified skipping the run, when the run was skipped. */
  skipped?: AlreadyVerifiedTree;
}

export async function verifyIntegration(
  execFn: ExecFn,
  opts: IntegrationVerifyOpts,
): Promise<IntegrationVerifyOutcome> {
  if (opts.verifyCmd === undefined) return {};
  const verifyExec = opts.verifyExecFn ?? execFn;
  // #1240 — a named worktree is a claim; `commitPrVerifiedTree` adds the proof
  // (one workstream, create mode, a cherry-picked commit, no no-diff entry).
  // Every other shape yields no identity, so the verify runs.
  const alreadyVerifiedTree = await commitPrVerifiedTree(verifyExec, {
    verifiedWorktree: opts.verifiedWorktree,
    mode: opts.mode,
    ids: opts.ids,
    cherryApplied: opts.cherryApplied,
    patchApplied: opts.patchApplied,
    noDiff: opts.noDiff,
  });
  const vr = await runCommitPrConsolidatedVerify(verifyExec, {
    verifyCmd: opts.verifyCmd,
    repoRoot: opts.repoRoot,
    workstreamCount: opts.ids.length,
    workstreamIds: opts.ids,
    timeoutMs: opts.verifyTimeoutMs,
    // #1404 — the cycle's base commit, so a consolidated failure can be
    // attributed per failing test instead of parking on the combination alone.
    ...(opts.baselineBaseSha !== undefined ? { baseSha: opts.baselineBaseSha } : {}),
    // #782 — the single flake retry fires only on the FIRST consolidated run
    // (the cycle's ciRetryCount unset).
    isCiRetry: (opts.verifyRetry?.ciRetryCount ?? 0) > 0,
    onRecover: opts.verifyRetry?.onRecover,
    ...(alreadyVerifiedTree !== undefined ? { alreadyVerifiedTree } : {}),
  });
  if (vr.ok === false) {
    // #1404 — every failing test is red at the cycle's base commit too, so
    // this failure is not the change's doing: no restore, no failure — the
    // caller pushes and makes the names visible. Everything else (no probe,
    // no red base established, ANY change-caused or unattributable failure)
    // restores and fails exactly as before.
    if (
      vr.preExistingOnly === true &&
      vr.preExistingFailures &&
      vr.preExistingFailures.length > 0
    ) {
      return { preExistingFailures: vr.preExistingFailures };
    }
    const restore = await opts.restoreRoot();
    return {
      failure: {
        ok: false,
        failure: "verify",
        reason: `${vr.classifiedMessage} — it was not pushed. ${opts.claimFor(restore)}.`,
        ...(vr.timedOut ? { timedOut: true } : {}),
      },
    };
  }
  return vr.skipped !== undefined ? { skipped: vr.skipped } : {};
}
