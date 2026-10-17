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

import { withVerifySlot } from "./host-resources.ts";
import { trace } from "./trace.ts";
import {
  classifyConsolidatedVerifyFailure,
  consolidatedFailureMessage,
} from "./work-driver-consolidation-classify.ts";
import type { ConsolidationFailureVerdict } from "./work-driver-consolidation-classify.ts";
import { extractAttributedTail } from "./work-driver-exec-error.ts";
import { type HangProcess, captureProcessTree } from "./work-driver-gate-hang.ts";
import { commitPrSkipDecision } from "./work-driver-integrate-verify-skip.ts";
import {
  isTimedOutKill,
  timeoutWhere,
  verifyTimeoutFailure,
} from "./work-driver-verify-develop-helpers.ts";
import {
  FAST_TIER_LABEL,
  failedVerifyCmd,
  fastVerifyCmdFor,
  withFastTier,
} from "./work-driver-verify-fast.ts";
import {
  combinedExecFailureStream,
  rerunConsolidatedVerifyOnce,
} from "./work-driver-verify-flake.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
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
      /**
       * #1240 — the verify command was not run because the integration tree
       * is the tree the develop gate already verified green. The caller
       * renders the visible note from it. Absent on every real run.
       */
      skipped?: AlreadyVerifiedTree;
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
      /** #1324 — the run was killed at its bound: no verdict, so no classification. */
      timedOut?: boolean;
      /**
       * #1427 — commit-pr carries the hang CLAUSE only. The clause is composed
       * into `classifiedMessage` (see the timeout branch below), which is what
       * the caller puts on the cap and the handoff renders; the commit-pr seam
       * has no scratch dir of its own to persist a full report to, so unlike
       * the develop seams this result reports no `runningTests` / `processes`
       * and no caller ever read them (round 1: two dead fields).
       */
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
    /**
     * #1240 — the tree the develop gate last verified GREEN, established by
     * the CALLER, plus the worktree it came from (the trace names it). At
     * this seam the tree under verification is the integration branch's
     * committed tree, which no develop run ever judged in place — the caller
     * can only assert equality for the shape where the integration is that
     * one workstream's content and nothing else (one workstream, a
     * cherry-pick, no uncommitted residue: see `integrate()` step 4). When
     * the pair is supplied and the committed tree is read successfully and
     * equals it, the verify command is skipped and `skipped` reports the
     * identity. A read failure, a mismatch, or no pair → the run happens.
     */
    alreadyVerifiedTree?: AlreadyVerifiedTree;
    /**
     * #1427 — injectable process-tree walker for the hang report (tests).
     */
    walkProcessTree?: (leaderPid: number) => {
      processes: HangProcess[];
      treeUnavailable?: string;
    };
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

  // #1324 — `.pi/verify-cmd-fast` runs first on the consolidated tree too.
  const fastCmd = await fastVerifyCmdFor(opts.repoRoot);
  const verifyExec = withFastTier(execFn, opts.verifyCmd, fastCmd);

  // #1240 — the duplicate-run check (`commitPrSkipDecision`): why the tree is
  // read here, after the caller committed the integration, and why residue in
  // the index forbids the skip. Every non-skip outcome falls through to the
  // run below.
  const skip = await commitPrSkipDecision(execFn, opts.repoRoot, opts.alreadyVerifiedTree);
  if (skip !== undefined) {
    return { ok: true, skipped: skip };
  }
  let timedOut = false;
  let ranCmd = opts.verifyCmd;
  // #1427 — the killed run's stream and the tree captured at its kill. The
  // capture happens in the catch, not after: the lantern #1054 case is children
  // that outlive their leader, and a walk after the settle would report nothing
  // about the processes the report exists to name.
  let killedOutput = "";
  let killedTree: { processes: HangProcess[]; treeUnavailable?: string } | undefined;
  const runOnce = async (): Promise<string | undefined> => {
    try {
      await withVerifySlot(() =>
        verifyExec(opts.verifyCmd, {
          cwd: opts.repoRoot,
          maxBuffer: 8 * 1024 * 1024,
          timeout: opts.timeoutMs,
        }),
      );
      return undefined;
    } catch (err) {
      // #841 — classify on stdout AND stderr (the shared helper), not on
      // stderr-with-stdout-dropped: a failure that prints its assertion on
      // stdout and a warning on stderr must still classify on the assertion.
      const e = err as Error & {
        stderr?: string;
        stdout?: string;
        killed?: boolean;
        timedOutKill?: boolean;
        overflow?: string;
        treePid?: number;
      };
      // #1427 fix round — a maxBuffer overflow is a kill but not a hang; only
      // the wall-clock kill earns the hang clause.
      timedOut = isTimedOutKill(e);
      ranCmd = failedVerifyCmd(err, opts.verifyCmd);
      const stream = combinedExecFailureStream(e);
      if (timedOut) {
        killedOutput = stream;
        killedTree =
          typeof e.treePid === "number"
            ? (opts.walkProcessTree ?? captureProcessTree)(e.treePid)
            : { processes: [] as HangProcess[] };
      }
      return stream;
    }
  };

  // The project's gate can run for minutes; without this line the step is
  // silent from its start to its end.
  trace(
    `work-driver: commit-pr — verifying the consolidated tree before the push: ${opts.verifyCmd.slice(0, 120)}`,
  );
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
      verifyExec,
      opts.verifyCmd,
      opts.repoRoot,
      opts.timeoutMs ?? 30 * 60_000,
      undefined,
      undefined,
      opts.walkProcessTree,
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
    timedOut = secondRun.timedOut;
    // The re-run's own capture replaces the first run's: the report describes
    // the run that ended the run.
    if (secondRun.timedOut) {
      killedOutput = secondRun.raw;
      killedTree = secondRun.tree ?? { processes: [] as HangProcess[] };
    }
    ranCmd = fastCmd && secondRun.raw.includes(FAST_TIER_LABEL) ? fastCmd : opts.verifyCmd;
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
  // #1324 — a killed run's stream stops wherever the kill landed: report
  // the bound, never a classification of the code.
  if (timedOut) {
    const where = timeoutWhere(`on the CONSOLIDATED tree at ${opts.repoRoot}`, {
      output: killedOutput,
      cmd: ranCmd,
      cwd: opts.repoRoot,
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
      ...(killedTree === undefined ? {} : { tree: killedTree }),
    });
    const bound = opts.timeoutMs ?? 30 * 60_000;
    const knob = "PI_ENSEMBLE_INTEGRATION_VERIFY_TIMEOUT_MS";
    const classifiedMessage = verifyTimeoutFailure(ranCmd, where, bound, knob);
    // #1427 fix round — no `runningTests` / `processes` on the result: the
    // clause above is the whole deliverable at this seam (nothing reads a
    // structured tree here, and no scratch dir exists to write a report to).
    return {
      ok: false,
      failureTail,
      attributed,
      verdict,
      classifiedMessage,
      timedOut,
    };
  }
  const classifiedMessage = consolidatedFailureMessage(verdict, ranCmd);
  return { ok: false, failureTail, attributed, verdict, classifiedMessage };
}
