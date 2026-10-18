/**
 * /work workflow state — the two verification gates' record shapes.
 *
 * Split out of `workflow-state-schema.ts` for the 500-line gate (AGENTS.md
 * §12); the schema module re-exports all four types so existing importers keep
 * their paths. The seam is the one the code already had: these are the
 * structured records the merge-authority gate (#380/#407), the plan-quality
 * gate (#861/#1167) and the outcome-verification gate (PR17/#782/#814/#1421)
 * write, and nothing here reads the filesystem — they are pure data shapes
 * consumed by the explain/handoff renderers.
 */

import type { EvidenceFailureKind } from "./workflow-state-cap.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import type {
  PlanQualityReason,
  PlanUnfenceSummary,
} from "./workflow-state-schema-plan-quality.ts";
import type { FenceViolation, VerifyEvidenceOrigin } from "./workflow-state-schema-verify.ts";

/**
 * #380 — why the cycle stopped at the merge step: merge authority
 * (citation-verified grant) and executed `gh` evidence, both defaulting
 * to "no". Absent unless the merge was held.
 */
export interface VerifyMergeHold {
  authorityGranted: boolean;
  /** #407 — `doctrine` is a citation-verified grant; `citation-failed` is a
   * judge that asserted permission it could not point at. `agents-md`
   * remains for state files written before #407. */
  authoritySource: "agents-md" | "doctrine" | "operator" | "none" | "citation-failed";
  /** The AGENTS.md sentence that granted or forbade it, verbatim. */
  authorityQuote?: string;
  /** Why the executed-evidence gate refused. */
  evidenceReason?: string;
  /** The evidence refusal was a tooling failure, not a CI verdict (#745). */
  evidenceFailureKind?: EvidenceFailureKind;
  /** Required checks reporting `skipped`/`neutral` — green to GitHub, not to us. */
  inconclusive?: string[];
  /**
   * The review round cap routed this cycle to `ci` with findings still
   * outstanding, so the merge is held however permissive the grant is.
   */
  unresolvedReviewFindings?: boolean;
}

/**
 * #861 — the plan step's quality record: the findings count that triggered
 * (or did not trigger) the one-shot corrective re-plan, plus the two
 * follow-up records the re-plan can leave behind.
 */
export interface VerifyPlanQuality {
  findingsCount: number;
  redispatched: boolean;
  reason?: PlanQualityReason;
  /**
   * #849 — the dependsOn edges the one-shot corrective re-plan dropped
   * (reason: dropped-dependencies). Persisted alongside the reason so the
   * original trigger's evidence isn't the only thing the operator sees;
   * absent when no edge was dropped.
   */
  droppedEdges?: { from: string; to: string }[];
  /** #1167 — the issue-named unfence's record (`PlanUnfenceSummary`). */
  unfence?: PlanUnfenceSummary;
}

/**
 * PR17 — outcome-verification gate (verifyStepOutcome) evidence for a
 * `verify-failed:<step>` cap; each failure string is one finding rendered by
 * explainCap. Optional — absent unless a gate failed.
 * #782 — optional `retries`/`recovered`: the consolidated-verify gate's single
 * bounded re-run. Absent pre-#782; absent = no re-run, so schemaVersion stays 1.
 */
export interface VerifyEvidence {
  step: WorkStep;
  failures: string[];
  at: number;
  retries?: number;
  recovered?: boolean;
  /** Which writer raised this park; see `VerifyEvidenceOrigin`. Absent pre-origin. */
  origin?: VerifyEvidenceOrigin;
  /**
   * #1421 fix round — the consolidated gate DECLINED to consolidate because
   * the root held nothing but untracked, git-ignored build output, and
   * nothing else was in the way. Recorded so the queue's park reason (and
   * the advice `humanActionFor` renders from it) reads a fact the gate
   * established, rather than substring-matching a failure string whose path
   * text an operator or a tool chose.
   */
  buildResidueOnly?: boolean;
  /**
   * #814 — structured develop-scope-fence violations (see `FenceViolation`
   * in workflow-state-schema-verify.ts). Absent = none recorded.
   */
  fenceViolations?: FenceViolation[];
}

// `PrDraftState` is #1292's PR-draft record and already lives in
// workflow-state-schema-pr-draft.ts; it is re-exported here beside the other
// gate records so the schema module has one import for the whole group.
export type { PrDraftState } from "./workflow-state-schema-pr-draft.ts";
