/**
 * work-driver-verify-develop-options — the options bag `verifyDevelopOutcome`
 * takes for its out-parameters.
 *
 * Split out of `work-driver-verify-develop.ts` for the AGENTS.md §12 500-line
 * cap: the trailing positional callbacks had grown until the function's own
 * signature outgrew the file. It is the sibling of
 * `work-driver-consolidated-verify-types.ts`, which plays the same role for the
 * consolidated verify's result shape — the parameter types of this verify chain
 * live in their own module so the gate modules stay about the gates.
 */

import type { CommentEvidence } from "./comment-evidence.ts";
import type { FenceLift } from "./work-develop-scope-fence-seam.ts";
import type { VerifyCommandRecord } from "./work-driver-corrective-decide.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";

/**
 * The out-parameters of `verifyDevelopOutcome`, as one object instead of
 * positional callbacks. The gate mutates `failures` / `notes` in place (they
 * stay positional — they are the result, not options); everything here is a
 * structured side-channel whose absence means "this caller does not route on
 * it", so every field is optional.
 */
export interface VerifyDevelopOutcomeOptions {
  /**
   * #1667 \u2014 out-parameter: what the verify command gate ran and how each
   * run failed (per-worktree and consolidated), for the corrective-round decision.
   * Filled in place; absent = this caller does not route on it.
   */
  verifyRecord?: VerifyCommandRecord;
  // #782 — fires when the consolidated-verify flake re-run passed.
  onVerifyFlakeRecovered?: (evidenceTail?: string) => void;
  // #814 — out-parameter for structured fence-violation records (see the
  // scope/fanout gate call in work-driver-verify-develop.ts). Mutated in
  // place by runScopeFanoutGate.
  fenceViolations?: FenceViolationRecord[];
  // #1405 — out-parameter for the issue-fenced paths the Test surface admitted
  // (see scopeFenceLift). The caller records each as a `fence-lifted` event.
  fenceLifts?: FenceLift[];
  // #841 — out-parameter for the consolidated verify's persisted raw-output
  // log path (the gate records it when a log was written, so the caller can
  // put it on the cap-hit event structurally instead of regexing prose).
  onConsolidatedLogPath?: (logPath: string) => void;
  // #1040 — out-parameter for the structured comment-loss checks (the
  // note and its result), so the caller plumbs them without matching note text.
  commentEvidence?: CommentEvidence[];
  // #1349 — fires when the base-commit probe found the verify command red
  // at base AND the verify command's failures are the gate's only ones, so
  // the caller can park with verify-baseline-red instead of verify-failed.
  onBaselineRedOnly?: () => void;
  // #1240 — out-parameter carrying the identity that justified skipping the
  // consolidated run (the single workstream's tree, already verified green).
  // The caller appends the `consolidated-verify-skipped` EVENT from it: a
  // note would be the one kind of note that never survives to the state
  // file, and the event lives where the caller appends so the log stays
  // append-only.
  onConsolidatedVerifySkipped?: (skipped: AlreadyVerifiedTree) => void;
  /**
   * #1421 fix round — out-parameter: the consolidated gate declined to
   * consolidate because the root held nothing but untracked, git-ignored build
   * output. Read from the result's structured `kind`/`buildResidueOnly`, so
   * the cap router never decides an environment refusal by substring-matching
   * a failure string that may contain an operator-authored path.
   */
  onBuildResidueOnly?: () => void;
  /**
   * #1427 — injectable process-tree walker for the hang reports this gate
   * writes. Forwarded to `runVerifyCommandGate`, which threads it to BOTH the
   * per-worktree seam and the consolidated probe. Production omits it and the
   * real `ps` walk runs; a test that injects one must have the seam actually
   * honour it (the round-1 defect: the consolidated leg was handed the option
   * under a key that does not exist, so the walker never ran).
   */
  walkProcessTree?: (leaderPid: number) => {
    processes: import("./work-driver-gate-hang.ts").HangProcess[];
    treeUnavailable?: string;
  };
  /**
   * #1427 round 3 — the sink every hang report THIS gate call writes is
   * recorded on. `verifyStepOutcome` creates one per call (rather than the
   * reports accumulating on the cycle context, which is how a cap came to name
   * the reports of an earlier gate run of the same cycle) and forwards it here;
   * `runVerifyCommandGate` threads it to both writing seams. Absent = this
   * caller does not route on the paths, and the reports are still written.
   */
  hangSink?: import("./work-driver-gate-hang.ts").GateHangPathSink;
  /** #1415 — the gate's reuse records, forwarded to `runVerifyCommandGate`. */
  onGateRecorded?: import("./work-driver-verify-gate-reuse.ts").GateRecorded;
  /** #1647 — the selected develop run's flaky and baseline-red tests, once per gate call. */
  onSelectedVerify?: (
    record: import("./work-driver-verify-select-exec.ts").SelectedVerifyRecord,
  ) => void;
}
