/**
 * work-driver-verify-pr17-result — the shape `verifyStepOutcome` returns.
 *
 * Its own leaf because the result grew one documented field per incident the
 * outcome gate learned to report structurally, and those documents (each of
 * which exists to stop a caller regexing a path or a verdict out of failure
 * prose) outgrew the gate that produces them. Every field here is STRUCTURAL on
 * purpose: a caller that reads a cap, a log path, or a fence violation out of the
 * `failures` strings is the shape these fields exist to retire.
 */
import type { CommentEvidence } from "./comment-evidence.ts";
import type { FenceLift } from "./work-develop-scope-fence-seam.ts";
import type { GateHangPathSink } from "./work-driver-gate-hang.ts";
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { BaseHealthConsulted } from "./work-driver-verify-aggregate.ts";
import type { DevelopGateRecord } from "./work-driver-verify-gate-reuse.ts";
import type { VerifyCommandRecord } from "./work-driver-verify-record.ts";
import type { SelectedVerifyRecord } from "./work-driver-verify-select-exec.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import type { VerifyRunEventFragment } from "./workflow-state-events-verify.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

export interface VerifyStepOutcomeResult {
  ok: boolean;
  failures: string[];
  notes: string[];
  adoptedPrNumber?: number;
  /**
   * #782 — true when this run's consolidated verify recovered from a single
   * transient flake (the caller emits `verify-flake-recovered` and records
   * `retries: 1, recovered: true` on any verifyEvidence it writes). Absent
   * on every other outcome, including the retry-failed path (that path
   * records `retries: 1, recovered: false` without the flag).
   */
  flakeRecovered?: boolean;
  /**
   * #814 — structured develop-scope-fence violations recorded by the
   * develop gate (absent when the gate recorded none, including
   * pre-#814 state files and self-fence/dependsOn-exempt hits). The caller
   * persists them on `pipelineState.verifyEvidence.fenceViolations` so the
   * explain/handoff renderers can attribute a consolidation conflict to the
   * fence instead of asserting an incoherent decomposition.
   */
  fenceViolations?: FenceViolationRecord[];
  /** #1405 — the issue-fenced paths the primary's Test surface admitted this run. */
  fenceLifts?: FenceLift[];
  /**
   * #841 — the consolidated verify's persisted raw-output log path (run2
   * when a flake re-run fired, run1 otherwise), carried STRUCTURALLY so the
   * caller records it on the cap-hit event's `logPaths` field instead of
   * regexing the path out of the failure prose. Absent when no log was
   * written (write failure, no consolidated run).
   */
  logPath?: string;
  /** #1040 — the develop gate's comment-loss checks, structured (see `recordCommentEvidence`). */
  commentEvidence?: CommentEvidence[];
  /** #1349 — the verify command is red at base and its failures are the only ones. */
  baselineRedOnly?: boolean;
  /**
   * #1765 — the probe ESTABLISHED the base red for the command the gate ran: the
   * claim the develop CAP reads. Weaker than `baselineRedOnly` above, which also
   * requires every failure to be the base's — one foreign entry used to drop a
   * red base to `verify-failed:develop` and earn a corrective round for a base
   * nothing can pass. Both stay reported so the excuse keeps its own answer.
   */
  baselineRedEstablished?: boolean;
  /**
   * #1421 fix round — the consolidated gate DECLINED to consolidate because
   * the root held nothing but untracked, git-ignored build output. Carried
   * STRUCTURALLY from the result's `kind`/`buildResidueOnly`, so the cap
   * router never has to substring-match an operator-authored path out of the
   * failure prose to tell an environment refusal from a verdict.
   */
  buildResidueOnly?: boolean;
  /**
   * #1427 — the gate-hang reports this gate persisted, one per gate run it
   * killed at its bound (per-worktree, consolidated, or both). Carried
   * STRUCTURALLY so the cap emit site records them on the cap-hit event's
   * `logPaths` — the handoff then names the files, and no renderer has to find
   * a path in prose. Absent when no run was killed or nothing could be written.
   */
  hangLogPaths?: string[];
  /**
   * #1240 — the consolidated verify did not run because its probe tree is the
   * tree the per-worktree verify already judged. The caller turns this into a
   * `consolidated-verify-skipped` event (`makeConsolidatedVerifySkippedEvent`).
   */
  consolidatedVerifySkipped?: AlreadyVerifiedTree;
  /**
   * #1415 — `verify-started` (already persisted, so the stream showed it while
   * the gate ran) and `verify-completed`; the caller appends both through
   * `recordDevelopGateEvents`. Absent when no verify command was resolved.
   */
  verifyEvents?: VerifyRunEventFragment[];
  /**
   * #1415 — the gate's reuse bookkeeping (see `GateRecorded`); the caller folds
   * it into `pipelineState.gateReuse` through `recordDevelopGateEvents`, so the
   * next develop pass can reuse a verdict this one established.
   */
  gateRecord?: DevelopGateRecord;
  /** #1647 — the selected develop run's flaky and baseline-red tests, folded into `pipelineState.verifyAttribution`. */
  selectedVerify?: SelectedVerifyRecord;
  /**
   * The verdict the develop gate collected from the background base probe, when
   * it read one. The caller records it on `pipelineState.baseHealthProbe` through
   * `recordDevelopGateEvents` — the branch step never writes it, because the
   * probe runs beside develop and a background state write would race the step.
   */
  baseHealthProbe?: BaseHealthVerdict;
  /**
   * The record of the consultation the develop gate performed (colour and the
   * probe's measured ms). The caller appends it as an event through
   * `recordDevelopGateEvents`; the probe is no longer a branch-step
   * event because the branch step no longer awaits it, and a background task may
   * not write state.
   */
  baseHealthConsulted?: BaseHealthConsulted;
  /** #1667 — what the verify command gate ran, for the corrective-round decision ("not-run" when no command ran). */
  verifyRun?: VerifyCommandRecord;
}
