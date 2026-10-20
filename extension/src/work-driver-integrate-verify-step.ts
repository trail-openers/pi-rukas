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

import { trace } from "./trace.ts";
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
   * #1404 — the workstream worktrees, handed to the baseline probe's name
   * comparison as trees the change run's names may live under. A gate script
   * that resolves its own directory prints paths under the checkout the script
   * lives in, so the integration checkout alone cannot anchor every name.
   */
  changeRoots?: readonly string[];
  /**
   * #1404 — the cycle's original base commit for the baseline probe (see
   * `IntegrateOpts.baselineBaseSha`). Absent → no probe, every consolidated
   * failure fails the integration as before.
   */
  baselineBaseSha?: string;
  verifyRetry?: IntegrateOpts["verifyRetry"];
  /**
   * #1702 — the cycle's scratch dir, passed straight to the verify seam so it can persist
   * the raw stream of each consolidated run (the develop side already does this). Absent →
   * the seam runs the same gate and simply writes no log.
   */
  scratchDir?: string;
  /**
   * #1702 — the log path the seam actually wrote, threaded out structurally so the terminal
   * cap names a file on disk. The develop gate's #841 contract, on the commit-pr side.
   */
  onConsolidatedLogPath?: (logPath: string) => void;
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
  /** The restore claim was NOT mixed into `failureTail`: see the module docstring. */
  preExistingFailures?: string[];
  /**
   * #1064 — the verify's own failure strings, handed to the caller verbatim so the
   * terminal cap can carry the test names and `✗` lines instead of the cap name alone.
   * `reason` is the classified message; these are the raw lines behind it.
   */
  failures?: string[];
  /** #1064 / #841 — persisted raw-output logs, carried structurally to the cap event.
   * #1702 — set in production: the seam writes the run log itself and reports the path it
   * wrote, so a terminal commit-pr park now points at a real file. */
  logPaths?: string[];
  /** The identity that justified skipping the run, when the run was skipped. */
  skipped?: AlreadyVerifiedTree;
}

export async function verifyIntegration(
  execFn: ExecFn,
  opts: IntegrationVerifyOpts,
): Promise<IntegrationVerifyOutcome> {
  if (opts.verifyCmd === undefined) return {};
  const verifyExec = opts.verifyExecFn ?? execFn;
  // #1702 — the path the seam actually wrote. The seam reports it on the result shape
  // (`vr.logPath`) and through the sink callback `integrate()` owns; either is honest and
  // neither may be lost here. A fabricated path is worse than no pointer, so nothing falls
  // back to a computed file name.
  const logPathOf = (): string | undefined => (vr.ok === false ? vr.logPath : undefined);
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
    ...(opts.changeRoots !== undefined ? { changeRoots: opts.changeRoots } : {}),
    // #782 — the single flake retry fires only on the FIRST consolidated run
    // (the cycle's ciRetryCount unset).
    isCiRetry: (opts.verifyRetry?.ciRetryCount ?? 0) > 0,
    onRecover: opts.verifyRetry?.onRecover,
    // #1702 — the scratch dir and the log sink, so this seam writes its own run log and
    // reports the path back rather than leaving `logPaths` a field nothing produced.
    ...(opts.scratchDir !== undefined ? { scratchDir: opts.scratchDir } : {}),
    ...(opts.onConsolidatedLogPath !== undefined
      ? { onConsolidatedLogPath: opts.onConsolidatedLogPath }
      : {}),
    ...(alreadyVerifiedTree !== undefined ? { alreadyVerifiedTree } : {}),
  });
  if (vr.ok === false) {
    // #1404 — every failing test is red at the cycle's base commit too, so
    // this failure is not the change's doing: no restore, no failure — the
    // caller pushes and makes the names visible. Everything else (no probe,
    // no red base established, ANY change-caused or unattributable failure)
    // restores and fails exactly as before.
    // `continueOnPreExisting` is where the three conditions live (a non-empty
    // change report, every name accounted for at base, nothing left as the
    // change's own) and it is the ONLY shape that sets `preExistingOnly`. This
    // site deliberately does not re-derive that judgement from the two arrays:
    // `preExistingFailures.length > 0` alone is the shape a zero-name change
    // report used to reach, and two independent readers of one rule is how one
    // of them ends up being the permissive one.
    if (vr.preExistingOnly === true) {
      const names = vr.preExistingFailures ?? [];
      if (names.length > 0) return { preExistingFailures: names };
      // A marker with no names behind it is a contradiction, not a pass. Fail
      // closed to the park rather than trusting the flag.
      trace(
        "work-driver: commit-pr verify — a pre-existing-only verdict arrived with no test names, which is not a shape the probe produces; the consolidated failure parks",
      );
    }
    const restore = await opts.restoreRoot();
    return {
      failure: {
        ok: false,
        failure: "verify",
        reason: `${vr.classifiedMessage} — it was not pushed. ${opts.claimFor(restore)}.`,
        ...(vr.timedOut ? { timedOut: true } : {}),
        // #1064 — the gate's own extraction, threaded to the terminal cap. The
        // classified message leads (it is the sentence the handoff opens with); the
        // raw failure stream follows, so the `FAILED:` test names and the `✗`
        // assertions survive for the recovery in
        // `work-driver-commit-verify-evidence.ts` even when the classifier's 800-char
        // window elided them.
        failures: [vr.classifiedMessage, ...(vr.failures ?? [])],
        ...(logPathOf() !== undefined ? { logPaths: [logPathOf() as string] } : {}),
      },
    };
  }
  return vr.skipped !== undefined ? { skipped: vr.skipped } : {};
}
