/**
 * work-driver-verify-consolidated-run — the consolidated leg of the develop
 * verify gate, split out of work-driver-verify-verify-cmd.ts so that file stays
 * under the AGENTS.md §12 size cap. Pure move: the #782/#807/#826 flake-retry
 * gate, the #1240 N=1 duplicate-run elision and the probe itself travel with
 * their comments, verbatim.
 */

import path from "node:path";
import type { ConsolidatedVerifyResult } from "./work-driver-consolidated-verify-types.ts";
import { runConsolidatedVerify } from "./work-driver-consolidated-verify.ts";
import { buildPerWorktreeFailuresByWs } from "./work-driver-consolidation-classify.ts";
import type { DriverContext, DriverExecFn } from "./work-driver-context.ts";
import {
  buildConsolidatedRetry,
  buildConsolidatedVerifyOpts,
} from "./work-driver-verify-consolidated-opts.ts";
import { developVerifiedTree } from "./work-driver-verify-eligibility.ts";
import type { GatePass } from "./work-driver-verify-gate-reuse.ts";
import { gatePerAssertion } from "./work-driver-verify-record.ts";
import type { WorkState } from "./workflow-state.ts";

export type ConsolidatedRunArgs = {
  execFn: DriverExecFn;
  ctx: DriverContext;
  state: WorkState;
  cmd: string;
  baseSha: string;
  suiteTimeoutMs: number;
  suiteTimeoutKnob?: string;
  fastTimeoutMs?: number;
  worktrees: Record<string, string>;
  changedWorktrees: string[];
  workstreamBaseShas?: Record<string, string>;
  walkProcessTree?: (leaderPid: number) => {
    processes: import("./work-driver-gate-hang.ts").HangProcess[];
    treeUnavailable?: string;
  };
  perWorktreeVerifyFailures: string[];
  notes: string[];
  onVerifyFlakeRecovered?: (evidenceTail?: string) => void;
  /** Set when the whole-gate pass was reused: the probe never runs. */
  reusedWholeGate: boolean;
  /** The held pass when the whole gate was reused; the probe then never runs. */
  reused: GatePass | undefined;
};

/**
 * Run (or reuse) the consolidated verify and report its wall-clock. The caller
 * owns the record, the outcome report and the aggregation — this decides only
 * whether the probe runs and what it returned.
 */
export async function runConsolidatedLeg(args: ConsolidatedRunArgs): Promise<{
  cons: ConsolidatedVerifyResult;
  consolidatedDurationMs?: number;
  /** The #807 shared view: both the retry gate and the classifier read this map. */
  perWorktreeFailuresByWs: Record<string, string>;
  singlePerWs?: string;
  singlePerAssertion?: string | null;
}> {
  const {
    execFn,
    ctx,
    state,
    cmd,
    baseSha,
    suiteTimeoutMs,
    suiteTimeoutKnob,
    fastTimeoutMs,
    changedWorktrees,
    workstreamBaseShas,
    perWorktreeVerifyFailures,
    notes,
    onVerifyFlakeRecovered,
    reusedWholeGate,
    reused,
  } = args;
  const execp = execFn;
  const scratchDir = path.join(ctx.repoRoot, "tmp", `issue-${ctx.issue}`);
  // #807 — the retry gate and the Case-2 root-cause match below must read
  // the SAME per-worktree failure map: if the retry fires on one view of
  // the failures and the classifier later compares a different, filtered
  // view, a "shared assertion" decision can diverge between the gate and
  // the verdict (the #798 class of marker-vs-marker mismatch). Both now
  // read `perWorktreeFailuresByWs`.
  const perWorktreeFailuresByWs = buildPerWorktreeFailuresByWs(
    args.worktrees,
    args.changedWorktrees,
    perWorktreeVerifyFailures,
  );
  // #782/#807/#826 — the consolidated-verify flake retry, two-phase gate:
  // (1) a length-only precondition admits the FIRST consolidated run — it
  // fires when this is a genuine consolidation (N>1) AND the per-worktree
  // failures are at most one (zero = the #782 shape; one = a possible
  // flake, the #798 shape where a timing-flaky test failed in a worktree
  // AND on the combined tree — one unstable test, not two independent
  // defects). The consolidated assertion is not known before the run, so
  // nothing more can be checked up front.
  // (2) the RE-RUN is decided by onFirstFailure against the RAW first-run
  // failure (deliberately raw: the elided detail can drop the ✗ line —
  // see #827 — while the classifier compares the elided detail): a KNOWN
  // per-worktree assertion that the first run does NOT share is suppressed
  // (a single per-worktree failure with a different assertion is a genuine
  // defect — the re-run would burn a full verify run and could mask it,
  // the #821 defect); a SHARED assertion or an UNKNOWN (unextractable) one
  // ALLOWS the re-run (pre-#826 behaviour for the unknown case). The
  // decision is computed ONCE in onFirstFailure and reported on the result
  // as `retryDecision` — the post-run notes are rendered from it, not from
  // a second comparator call.
  const singlePerWorktreeFailure = perWorktreeVerifyFailures.length === 1;
  const flakeRetryPrecondition =
    (!singlePerWorktreeFailure || Object.keys(perWorktreeFailuresByWs).length === 1) &&
    Object.keys(args.worktrees).length > 1;
  // The #807 invariant: the per-worktree assertion is extracted BEFORE the
  // consolidated run so the post-run note reads the same value the
  // classifier will compare. `null` = honest absence (nothing extractable),
  // which the gate treats as unknown, not as a mismatch.
  const singlePerWs = singlePerWorktreeFailure
    ? Object.keys(perWorktreeFailuresByWs)[0]
    : undefined;
  const singlePerAssertion: string | null | undefined =
    singlePerWs !== undefined ? gatePerAssertion(perWorktreeFailuresByWs[singlePerWs]) : undefined;
  // #1240 — the N=1 duplicate run: with ONE workstream whose per-worktree
  // verify just passed, the consolidated probe cherry-picks that workstream's
  // own commits onto baseSha and verifies the result — the same content the
  // run above already judged. The eligibility rule (and why the identity is
  // read here but compared inside the probe) is in `developVerifiedTree`.
  // Any failure yields `undefined` and the consolidated verify runs as before.
  const alreadyVerifiedTree = await developVerifiedTree(execp, ctx, {
    changedWorktrees,
    worktrees: state.pipelineState.worktrees ?? {},
    perWorktreeVerifyFailures,
  });
  // Wall-clock of the consolidated COMMAND, measured only when it runs. The
  // record the pass leaves behind carries it so the next round can tell a
  // 30-second gate from a 9-minute one — the difference between a verdict worth
  // reusing and one whose run the bound exists to cap.
  const consolidatedStartedAt = Date.now();
  const cons: ConsolidatedVerifyResult = reusedWholeGate
    ? { status: "passed", applied: [], reused }
    : await runConsolidatedVerify(
        execp,
        buildConsolidatedVerifyOpts({
          repoRoot: ctx.repoRoot,
          baseSha,
          stateWorktrees: state.pipelineState.worktrees ?? {},
          workstreamBaseShas,
          scratchDir,
          verifyCmd: cmd,
          timeoutMs: suiteTimeoutMs,
          ...(suiteTimeoutKnob !== undefined ? { suiteTimeoutKnob } : {}),
          ...(fastTimeoutMs === undefined ? {} : { fastTierTimeoutMs: fastTimeoutMs }),
          ...(alreadyVerifiedTree !== undefined ? { alreadyVerifiedTree } : {}),
          dirtyRootExempt: ctx.dirtyRootExempt,
          ...(args.walkProcessTree !== undefined ? { walkProcessTree: args.walkProcessTree } : {}),
          retry: buildConsolidatedRetry({
            canRetry: flakeRetryPrecondition,
            singlePerAssertion,
            onRecover: (evidenceTail) => {
              notes.push(
                `consolidated verify RECOVERED after one bounded re-run (transient flake) — first-run failure preserved${evidenceTail ? `: ${evidenceTail}` : ""}`,
              );
              onVerifyFlakeRecovered?.(evidenceTail);
            },
          }),
        }),
      );
  return {
    cons,
    perWorktreeFailuresByWs,
    singlePerWs,
    singlePerAssertion,
    // The consolidated run's wall-clock: measured, not estimated, because it is
    // the number the next round's reuse decision is screened against — and a
    // reused pass has no duration, because it ran nothing.
    consolidatedDurationMs: reusedWholeGate ? undefined : Date.now() - consolidatedStartedAt,
  };
}
