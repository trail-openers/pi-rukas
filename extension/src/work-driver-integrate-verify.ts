/**
 * work-driver-integrate-verify — #777 commit-pr twin: run the project's
 * verify command against the CONSOLIDATED tree after the branch has the
 * cherry-picked commit, and — on failure — classify it instead of parking
 * on the generic "the consolidated tree fails the project's verify command".
 *
 * The develop-time twin lives in `work-driver-consolidated-verify.ts` and
 * returns a structured `{status, detail}`; this module runs on the
 * commit-pr path, where the consolidated tree IS the branch at repoRoot
 * (not a scratch probe) and the caller (`integrate()` step 4) needs a
 * fail-closed verdict plus the classification to name the handoff.
 *
 * The classification is delegated to the shared classifier
 * (`work-driver-consolidation-classify.ts`) — the same one the develop
 * seam uses — so the two call sites cannot drift. The `failureTail` we
 * hand to it is the raw stderr/stdout of the verify run, bounded to the
 * same 800 chars the develop seam uses via `extractAttributedTail`; the
 * classifier re-extracts the specific assertion from that tail, which is
 * the same contract the develop path relies on.
 *
 * The N=1 invariant is honoured by the classifier itself (it takes the
 * workstream count and refuses `consolidation-created` at N=1) — this
 * module just threads the count through.
 *
 * The restore claim is NOT mixed into `failureTail`: `consolidateCommitPrVerifyFailure`
 * composes the final `reason` from the classified message + the claim, so
 * the assertion the classifier parses is the assertion the verify command
 * emitted, not the restore post-condition. The develop seam keeps the
 * claim in the detail because its message builder reads the whole detail
 * verbatim; the commit-pr seam builds the reason itself and can keep the
 * two concerns separate.
 */

import { trace } from "./trace.ts";
import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "./work-driver-consolidation-classify.ts";
import type { ConsolidationFailureVerdict } from "./work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import {
  combinedExecFailureStream,
  rerunConsolidatedVerifyOnce,
} from "./work-driver-verify-flake.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The result of running the commit-pr consolidated-tree verify.
 *
 * - `ok: true` — the consolidated tree passed verify; the caller may push.
 * - `ok: false` — the consolidated tree failed verify; the caller must
 *   NOT push. The `failureTail` is the raw (bounded) verify output, the
 *   `verdict` is the three-way classification, and the `classifiedMessage`
 *   is the handoff-ready text that names the classification, the specific
 *   assertion, and the workstream ids.
 */
export type CommitPrConsolidatedVerifyResult =
  | {
      ok: true /** #782 — the first run flaked and the single re-run passed. */;
      recovered?: boolean;
    }
  | {
      ok: false;
      /** Raw bounded (800-char) verify output, with attribution anchor. */
      failureTail: string;
      /** True when the tail starts at a `FAILED:` marker (smoke-loop shape). */
      attributed: boolean;
      /** Three-way classification (see the classifier module docstring). */
      verdict: ConsolidationFailureVerdict;
      /** Handoff-ready message naming classification + assertion + workstreams. */
      classifiedMessage: string;
    };

/**
 * Run the project's verify command against the CONSOLIDATED tree at
 * repoRoot (which `integrate()` has already put on the integration
 * branch with the cherry-picked commit). On failure, classify via the
 * shared classifier and return the structured result.
 *
 * The caller is responsible for the restore claim — it composes the
 * final `reason` string from `classifiedMessage` + its own claim, which
 * keeps the restore concern (this module has no knowledge of the
 * original ref) out of the classification input.
 *
 * @param execFn — shell executor (injection seam for tests).
 * @param verifyCmd — the project's verify command (from `.pi/verify-cmd`).
 * @param repoRoot — the repoRoot the consolidated tree is checked out at.
 * @param workstreamCount — the number of workstreams in the cycle (N).
 * @param workstreamIds — all workstream ids in order.
 * @param perWorktreeFailuresByWs — per-worktree verify failure texts
 *   keyed by workstream id. In the commit-pr seam this is always `{}` —
 *   the develop gate ran per-worktree verify in a previous step and the
 *   results live in the state file's `verifyEvidence`, not here — the
 *   classifier's per-workstream-defect branch simply does not fire,
 *   which is correct: at commit-pr, a per-workstream defect would have
 *   been caught (or parked) in the develop step and never reach the
 *   push. The N=1 invariant is still honoured by the classifier.
 *
 * #782 — single bounded flake retry. On the FIRST consolidated run at
 * commit-pr (ciRetryCount unset), if every per-worktree verify passed
 * (perWorktreeFailuresByWs is empty) and there are multiple workstreams
 * (N>1), a transient flake (the #777/#296 watchdog-timing class under
 * parallel-fanout load) is classified and parked before the re-run gets
 * a chance. We now re-run the SAME verify command ONCE in the SAME still-
 * checked-out integration tree BEFORE classifying. If the re-run passes,
 * the caller proceeds (the flake was a false alarm); if it fails too,
 * classification proceeds as today. A test that fails twice is not a
 * flake — it still parks. The retry is exactly one re-run, never a
 * loop; the precondition (first run, N>1, no per-worktree failures) is
 * checked here so a later ci-retry (ciRetryCount set) re-enters the
 * single-run path without a second re-run.
 */
export async function runCommitPrConsolidatedVerify(
  execFn: NonNullable<ExecFn>,
  opts: {
    verifyCmd: string;
    repoRoot: string;
    workstreamCount: number;
    workstreamIds: string[];
    perWorktreeFailuresByWs?: Record<string, string>;
    timeoutMs?: number;
    /**
     * Set when this consolidated run is NOT the first at commit-pr (i.e.
     * a prior ci-retry already ran the verify command and the caller bumped
     * ciRetryCount). When set, the single flake retry is skipped — the
     * retry precondition (issue #782 AC: "the retry fires ONLY when … the
     * FIRST consolidated run at commit-pr (ciRetryCount unset)") is not met.
     * Absent (undefined) is the first run; the retry fires when the other
     * preconditions hold.
     */
    isCiRetry?: boolean;
    /**
     * #782 — the re-run passed: the caller records the recovery on the PR
     * via the `verify-flake-recovered` event (the callback is where that
     * append happens, BEFORE the caller appends any failure cap).
     */
    onRecover?: (evidenceTail?: string) => void;
  },
): Promise<CommitPrConsolidatedVerifyResult> {
  // The single flake retry is allowed only when: (a) this is the first
  // consolidated run at commit-pr (isCiRetry unset), (b) there are multiple
  // workstreams (N>1 — N=1 is a no-op consolidation, its failure is a
  // per-workstream defect), and (c) every per-worktree verify passed
  // (perWorktreeFailuresByWs is empty — at this seam it is always {}, but
  // the check is defensive and makes the precondition explicit).
  const canRetry =
    opts.isCiRetry !== true &&
    opts.workstreamCount > 1 &&
    Object.keys(opts.perWorktreeFailuresByWs ?? {}).length === 0;

  const runOnce = async (): Promise<string | undefined> => {
    try {
      await execFn(opts.verifyCmd, {
        cwd: opts.repoRoot,
        maxBuffer: 8 * 1024 * 1024,
        timeout: opts.timeoutMs,
      });
      return undefined;
    } catch (err) {
      // #841 — classify on stdout AND stderr (the shared helper), not on
      // stderr-with-stdout-dropped: a failure that prints its assertion on
      // stdout and a warning on stderr must still classify on the assertion.
      return combinedExecFailureStream(err as Error & { stderr?: string; stdout?: string });
    }
  };

  let firstFailure = await runOnce();
  if (firstFailure === undefined) return { ok: true };

  // #782 — on the first run, with every per-worktree verify passed and N>1,
  // re-run the SAME command ONCE in the SAME still-checked-out integration
  // tree BEFORE classifying. A transient flake (the #777/#296 watchdog-
  // timing class) passes on the second run; a genuine consolidated defect
  // fails both times and is classified below exactly as today.
  if (canRetry) {
    trace(
      `work-driver: commit-pr verify failed on the first run — re-running the verify command once (flake retry, N=${opts.workstreamCount})`,
    );
    // #841 — this twin passes neither scratchDir nor timestamp, so the
    // re-run persists no log (out of scope per the ticket's DECISION) and
    // returns the RAW stream; the caller bounds it with the pre-existing
    // `extractAttributedTail` below — nothing multi-MB reaches the evidence.
    const secondRun = await rerunConsolidatedVerifyOnce(
      execFn,
      opts.verifyCmd,
      opts.repoRoot,
      opts.timeoutMs ?? 30 * 60_000,
    );
    if (secondRun === undefined) {
      trace(
        "work-driver: commit-pr verify re-run PASSED — the first-run failure was a flake; proceeding without classifying",
      );
      // The caller's onRecover callback is where the
      // `verify-flake-recovered` step event is appended, so it happens
      // BEFORE the caller appends `verify-failed:commit-pr` + its
      // verifyEvidence (eventLog is append-only; the recovered path
      // appends no cap).
      opts.onRecover?.(firstFailure);
      return { ok: true, recovered: true };
    }
    // The re-run failed — classify the second run's tail exactly as a
    // single-run failure would be classified (a test that fails twice is
    // not a flake, so the cycle parks as today).
    firstFailure = secondRun.raw;
  }

  const failure = firstFailure;

  // The tail we hand to the classifier: anchored at the FAILED: marker when
  // present, last 800 chars otherwise (the biome/tsc shape emits no marker).
  // The same `extractAttributedTail` the develop seam uses, so the assertion
  // extraction path is identical across both seams.
  const { tail, attributed } = extractAttributedTail(failure, 800);
  // The restore claim is NOT in this tail — the caller composes it from
  // the classified message + its own claim. Passing the raw tail (with
  // the unattributed marker when applicable) keeps the classifier's
  // assertion extraction clean.
  const failureTail = tail || "verify command exited non-zero";
  const verdict = classifyConsolidatedVerifyFailure(
    opts.workstreamCount,
    opts.workstreamIds,
    failureTail + (attributed ? "" : " (unattributed — best-effort tail)"),
    opts.perWorktreeFailuresByWs ?? {},
  );
  const classifiedMessage = consolidatedFailureMessage(verdict, opts.verifyCmd);
  return { ok: false, failureTail, attributed, verdict, classifiedMessage };
}
