/**
 * workflow-state-events-cap-hit — the `cap-hit` event, split out of the
 * `WorkEvent` union for module-size hygiene (AGENTS.md §12), following the same
 * pattern as the other `workflow-state-events-*.ts` leaves.
 *
 * A `cap-hit` is the event the handoff renders, so its optional fields are all
 * operator-facing: each one exists because a handoff told an operator to do
 * something and did not say where, or named the wrong gate. All are optional —
 * a cap-hit from a different cap carries none of them, and a reader treats an
 * absent field as "not this cap's", never as a broken record.
 *
 * `cap` is `string` here and narrowed by the union member that composes this
 * type: `workflow-state-events.ts` writes `{ cap: WorkCapLiteral } & ...`, so
 * the literal union stays where `explainCap()` enumerates it and this leaf stays
 * free of the cap taxonomy's imports. `reviewRound` and `nextStep` likewise stay
 * required in the union — a router must not be able to read an absent one.
 */
import type { RoleName } from "./roles.ts";
import type { PlanVerdict } from "./workflow-state-events-caps.ts";

/** The operator-facing tail a `cap-hit` may carry. */
export interface CapHitFields {
  /**
   * #492 — the worktree the lens-fix driver inspected, named so the
   * handoff tells the operator WHERE to look (`git -C <worktree>
   * status`) instead of "a worktree".
   */
  lensWorktreePath?: string;
  /**
   * #797 — the ref repoRoot started from before the checkout. Present on
   * `lens-fix-not-integrated`: the recovery's post-condition is that
   * repoRoot is on this ref again.
   */
  restoredToRef?: string;
  /**
   * #1852 — the on-disk patch a stray revert wrote, when the cap-hit follows
   * one. `restoredToRef` is git's copy of the reverted content and reaches a
   * TRACKED file; an UNTRACKED stray is in no commit, so the patch (and its
   * copies) is the only record of it. Present on the `lens-fix-scope` park
   * whose round had already spent its one revert: the operator needs both
   * locations to see what the driver deleted before refusing the second set.
   */
  restoredToPath?: string;
  /**
   * The HEAD of the lens-fix worktree when a COMMITTED fix existed and
   * could not be integrated. Present only on that
   * `lens-fix-not-integrated` shape: the handoff names the commit to
   * land, and does not suggest the findings were false positives.
   */
  committedFixSha?: string;
  /** #543 — which role's child was cap-killed (loop/token-budget caps). */
  role?: RoleName;
  /** #1652 — the plan verdict behind a `plan-spec-mismatch` park. */
  planVerdict?: PlanVerdict;
  /**
   * #492 — the git evidence that establishes WHICH failure mode
   * produced this cap-hit, verbatim from the command that established
   * it. On `lens-fix-not-integrated` it distinguishes "the fixer
   * wrote nothing" from "a diff existed but integration failed".
   */
  evidence?: string;
  /**
   * #841 — the persisted raw verify output logs behind this cap (the
   * consolidated verify's run1/run2 logs), carried STRUCTURALLY on the
   * event instead of being regexed out of the cap's prose evidence by
   * the explain renderer. Present only on the develop verify caps whose
   * gate wrote one or more logs; absent everywhere else (and on all
   * pre-#841 state files).
   */
  logPaths?: string[];
  /**
   * #657 — on `cap: "intent-park"` the machine-readable park reason
   * (underspecified / contradicted-by-code / already-implemented /
   * too-large / premise-unsound). Carried on the event so the renderers
   * can show `intent-park (contradicted-by-code)` without re-deriving it.
   */
  parkReason?: string;
  /**
   * #1561 — on an `already-implemented` intent park, the cited PR the
   * forge reported OPEN: the work awaits review, so the issue is not done.
   */
  awaitingReviewPr?: number;
}
