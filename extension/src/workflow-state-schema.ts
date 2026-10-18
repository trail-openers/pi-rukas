/**
 * /work workflow state — pipeline snapshot + top-level state shape / types.
 * Split out of `workflow-state.ts` (AGENTS.md §12 file-size limit).
 */

import type { Verdict } from "./lens-review.ts";
import type { NormalisedSpec } from "./work-driver-intent.ts";
import type { CapEvidence, CapedPartialState, EvidenceFailureKind } from "./workflow-state-cap.ts";
import type { WorkEvent, WorkStep } from "./workflow-state-events.ts";
// #679/#728 — workstream shape + consolidation record, split for the 500-line gate.
// Re-exported so existing importers keep their paths.
export type { Workstream, WorkstreamBaseShas } from "./workflow-state-schema-workstreams.ts";
export type { ConsolidationCompleteness } from "./workflow-state-schema-consolidation-completeness.ts";
export type { ConvergeEvidence } from "./workflow-state-schema-converge.ts";
// #814 — FenceViolation lives with the other verifyEvidence shapes.
export type { FenceViolation } from "./workflow-state-schema-verify.ts";
import type { ConsolidationCompleteness } from "./workflow-state-schema-consolidation-completeness.ts";
import type { ConvergeEvidence } from "./workflow-state-schema-converge.ts";
// #861 / #1167 — `PlanQualityReason` and `PlanUnfenceSummary` live in the
// plan-quality fragment (the 500-line cap); re-exported just below.
import type {
  PlanQualityReason,
  PlanUnfenceSummary,
} from "./workflow-state-schema-plan-quality.ts";
import type { FenceViolation, VerifyEvidenceOrigin } from "./workflow-state-schema-verify.ts";
import type { Workstream, WorkstreamBaseShas } from "./workflow-state-schema-workstreams.ts";

export type { PlanQualityReason, PlanUnfenceSummary };

export {
  filesPresentFromConsolidation,
  type IncompleteConsolidation,
  type ConsolidationVerdict,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state-consolidation.ts";
import type { IncompleteConsolidation } from "./workflow-state-consolidation.ts";

/** Current schema version. Bump on breaking changes. */
export const WORK_STATE_SCHEMA_VERSION = 1 as const;

export type { CapedPartialState, CapEvidence } from "./workflow-state-cap.ts";
export { WORK_STEPS } from "./workflow-state-events.ts";

export type { CommitPrRootState } from "./workflow-state-schema-commitpr-root.ts";
import type { CommitPrRootState } from "./workflow-state-schema-commitpr-root.ts";
export { prDraftFindings } from "./workflow-state-schema-pr-draft.ts";
import type { PrDraftState } from "./workflow-state-schema-pr-draft.ts";
// #1362 — cycle-start exempt-untracked baseline: type + #533 validator in workflow-state-dirty-root.ts (#540/#861 seam).
export {
  type DirtyRootExemptBaseline,
  dirtyRootExemptBaselineFindings,
} from "./workflow-state-dirty-root.ts";
import type { IssueClosedState } from "./workflow-state-schema-issue-closed.ts";

/**
 * Pipeline snapshot — the driver's "where are we" view, reconstructible
 * from eventLog but stored explicitly for O(1) reads. When the two
 * diverge, eventLog is authoritative.
 */

export interface PipelineState extends IssueClosedState {
  /** Current step. Drives template selection and transition table. */
  currentStep: WorkStep;
  /**
   * Last completed step (for resume; tells driver what to skip). Undefined
   * when no steps have completed yet.
   */
  lastCompletedStep?: WorkStep;
  /**
   * Active dispatch IDs in flight under `currentStep`. Cleared on
   * dispatch-completed. Detects "crashed mid-dispatch" on resume.
   */
  inFlightJobIds: string[];
  /** Feature branch name once Step 3 completes. */
  branchName?: string;
  /**
   * Workstreams decomposed by Step 2 (plan). Key = workstream id;
   * `id`/`scope`/`paths`/`outOfScope` per workstream (see Workstream type).
   * Optional for back-compat; absent = `{default: …}` synthesised.
   */
  workstreams?: Record<string, Workstream>;
  /**
   * Path to a claim-check artifact holding the cached `gh issue view`
   * body fetched driver-side in Step 1 (Pattern 1 intra-step fanout).
   * Downstream steps reference this instead of re-fetching the body
   * from GitHub.
   */
  issueBodyArtifact?: string;
  /**
   * Map of workstream id → absolute path of its worktree (or repo root
   * for the `default` single-task case). Populated by Step 3 (branch);
   * consumed by Steps 4 (develop), 5 (adversarial), 7 (lens-review),
   * 8 (ci). Empty map = pre-PR3 state file; readers fall back to
   * `repoRoot` for the `default` workstream.
   */
  worktrees: Record<string, string>;
  /**
   * #861 — the driver-owned integration worktree (`.worktrees/issue-<N>-integrate`),
   * recorded when the commit-pr ops-fallback creates it and cleared when the
   * post-dispatch audit removes it on success. Persists via the normal
   * state flow (writeState) so a re-entry after a crash recognises a
   * driver-owned tree at that path and REPLACES it (recording the old HEAD
   * first — decision (2)) rather than refusing a dirty one. Absent on
   * pre-#861 state files and on cycles that never created the tree.
   */
  integrateWorktree?: string;
  /**
   * #679 — the per-workstream EFFECTIVE BASE: the commit the workstream's
   * worktree was (or will be) created from. See WorkstreamBaseShas for the
   * full contract (case 2(b) deferred worktree creation, safety-net / verify
   * gate base resolution, back-compat with pre-#679 state files).
   */
  workstreamBaseShas?: WorkstreamBaseShas;
  /**
   * Last fetched diff hash — set after Step 5 / Step 7 fix passes. Lets the
   * user (or future code) detect "the diff hasn't changed between rounds"
   * which is a signal the developer is stuck.
   */
  lastDiffHash?: string;
  /**
   * Six-pass-review round counter; starts at 1 on first lens-review entry.
   * Hard cap at 3 — see MAX_REVIEW_ROUNDS in work-driver-context.ts.
   */
  reviewRound: number;
  /**
   * Number of times the driver has re-entered `develop` from `ci-status:
   * failure`. Capped at MAX_CI_RETRIES (2 → up to 3 CI attempts total)
   * before routing to handoff. Distinct from `reviewRound` which caps the
   * lens-fix loop; this caps the outer "CI keeps failing" loop that
   * surfaced on issue #553's live run when no PR existed for CI to watch.
   *
   * Optional in the schema so state files written by PR #239 (before this
   * field existed) still load cleanly under the same `schemaVersion: 1`.
   * Readers treat absent as 0.
   */
  ciRetryCount?: number;
  /**
   * PR6 — explore's structured verdict, persisted so handoff renderers
   * (renderHandoffUserMessage, renderHandoffMarkdown, renderTerminalStatus)
   * can quote it directly without re-parsing the dispatch-completed
   * event's summary. Set by `runExplore` after `parseExploreVerdict`
   * returns a non-null value; absent when the explore agent skipped the
   * `## Verdict` heading (older runs / agent ignored prompt).
   *
   * When set to ALREADY_COMPLETE or NEEDS_CLARIFICATION, runExplore also
   * synthesises a `cap-hit` and sets `currentStep='handoff'` — the field
   * is observational rather than load-bearing for routing.
   */
  exploreVerdict?: "NEEDS_WORK" | "ALREADY_COMPLETE" | "NEEDS_CLARIFICATION";
  /**
   * PR10 — for multi-issue /work (`/work 561 562 563`), the NEEDS_WORK
   * subset after `runExplore` parses per-issue verdicts. Implicit
   * fallback to `[WorkState.issue]` for single-issue cycles and for
   * state files written before this field existed. `runPlan` and
   * everything downstream operate on this subset; ALREADY_COMPLETE /
   * NEEDS_CLARIFICATION issues land in `droppedIssues` instead.
   */
  activeIssues?: number[];
  /**
   * PR11 — per-issue body-fetch failure list. Populated by `runExplore`
   * when `gh issue view <N>` returns empty stdout or rejects for any
   * issue in the cycle. Drives the operator-facing handoff body — each
   * entry names which `gh` call broke so the operator can target the
   * actual failure (gh auth, gh version, network, extension hijack).
   * Absent for normal cycles where every issue body fetched cleanly.
   */
  emptyBodyIssues?: Array<{ issue: number; reason: string }>;
  /**
   * #362 — the open PR the branch-step pre-flight found already covering
   * this issue, which is why the cycle halted with cap
   * `existing-pr-detected`. Drives the handoff body (PR number, its head
   * branch, and which signal matched). Absent for every cycle that ran.
   */
  existingPr?: { number: number; headRefName: string; matchedBy: "body" | "branch" };
  /**
   * #287 — bookkeeping for the integration step. `reintegrations` counts
   * lens-fix follow-up commits applied onto the branch after the first
   * consolidation, which is the signal that the fix loop is actually reaching
   * the PR (pre-#287 lens-fix edits were made in the worktree and never
   * pushed, so they silently never did).
   */
  integration?: { integratedAt?: number; reintegrations?: number };
  /**
   * #378 — the resolved intent. Absent when intent resolution is
   * disabled or the resolver returned no `## Spec` block.
   */
  /**
   * #792 — the plan-time no-diff marker. Set by the intent resolver
   * and nowhere else; a marker without a non-empty evidence string is
   * NOT honoured. Optional; absent = no marker.
   * (Carried on the deliverables of NormalisedSpec; see work-driver-intent.ts.)
   */
  normalisedSpec?: NormalisedSpec;
  /**
   * #380 — why the cycle stopped at the merge step: merge authority
   * (citation-verified grant) and executed `gh` evidence, both defaulting
   * to "no". Absent unless the merge was held. `mergeHold` below carries
   * the structured record; `lensDiffError` (#384) names the git error when
   * lens-review could not read the diff it is supposed to review, so the
   * operator does not have to reproduce it.
   */
  lensDiffError?: string;
  mergeHold?: {
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
  };
  planQuality?: {
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
  };
  /**
   * PR14/#540 — the subsumption-aware consolidation verdict: `verdicts`
   * (workstreams NOT covered by the committed diff) + `filesPresent` (what
   * shipped). Single writer: `runCommitPr`'s gate. The `Array` member is
   * the pre-#540 shape — legacy files must keep reading; the validator
   * accepts both.
   */
  incompleteConsolidation?: IncompleteConsolidation | Array<{ id: string; paths: string[] }>;
  /** #728 (task-a) — see ConsolidationCompleteness (schema fragment). */
  consolidationCompleteness?: ConsolidationCompleteness;
  /** #1153 — skipped consolidation checks, persisted and rendered in the handoff. */
  consolidationNotes?: string[];

  /**
   * #500 — repoRoot's ACTUAL state when commit-pr completed (mechanized:
   * clean tree on the branch; LLM-ops fallback: whatever the hand
   * consolidation left). The handoff renderers read it to state facts
   * instead of assuming the clean tree. Absent when the inspection never
   * ran or failed (`commitPrRootError`).
   */
  commitPrRoot?: CommitPrRootState;
  /** #500 — the git error, when the post-fallback inspection could not run. */
  commitPrRootError?: string;
  /**
   * PR10 — the issues that did NOT make the active set, with the
   * per-issue verdict and the reason explore gave. Surfaced in handoff
   * renderers + PR body so the operator sees WHICH issues were dropped
   * and WHY. Empty for single-issue cycles and for older state files.
   */
  droppedIssues?: Array<{
    issue: number;
    verdict: "NEEDS_WORK" | "ALREADY_COMPLETE" | "NEEDS_CLARIFICATION";
    reason: string;
  }>;
  /**
   * #453 — per-workstream commit SHAs set after integrate cherry-picks
   * the developer's commits onto the feature branch. Keyed by workstream
   * id so resume can skip workstreams already applied. Absent on state
   * files written before this field existed; readers treat absent as `{}`.
   */
  commitShas?: Record<string, string>;
  /**
   * PR5 — per-step retry budget for RETRY_ONCE-classified steps
   * (adversarial, lens-review). Driver's halt-cascade router increments
   * on dispatch-failed; once `>= 1` the next failure routes to handoff
   * via cap-hit `step-failed:<step>`. Persisted so a crash mid-retry
   * doesn't re-loop on resume. Optional for back-compat with PR4 state
   * files; readers treat absent step keys as 0 retries used.
   */
  retryAttempts?: Partial<Record<WorkStep, number>>;
  /**
   * #297 — per-step budget for INFRASTRUCTURE-TRANSIENT failures
   * (provider error-stop, pi-rukas timeout/inactivity kill) on
   * HALT-class steps. Distinct from `retryAttempts` (the RETRY_ONCE
   * semantic budget): a transient is retried up to 2× with backoff on any
   * step before the halt-cascade fires. Both counters reset when the step
   * completes successfully, so a later step-back re-entry gets a fresh
   * budget. Optional for back-compat; absent keys = 0 used.
   */
  transientRetryAttempts?: Partial<Record<WorkStep, number>>;
  /**
   * #486 — per-workstream budget for infra-transient failures INSIDE the
   * adversarial fan-out (N>1): the driver-level RETRY_ONCE/#308 router only
   * reaches the single-workstream path, so one loop dying on a provider
   * error with siblings approved was terminal for the whole cycle (#478).
   * On re-entry, workstreams whose last outcome was no-verdict re-run — at
   * most once — while the aggregate keeps the approved verdicts. Absent
   * keys = 0 used.
   */
  adversarialTransientRetries?: Record<string, number>;
  /**
   * #543 F5 — the most recent six-pass review's per-lens outcomes, persisted
   * by `runLens` so a REVIEW_INCOMPLETE handoff can render the completed
   * lenses' verdicts (one loop-killed lens is not a silent 1-of-6 loss).
   * `verdict` is the closed `Verdict` union from lens-review.ts (type-only
   * import; no cycle — lens-review does not import the state schema).
   * Additive; absent on pre-#543 state files / before the first review.
   */
  lensReviewSummary?: {
    round: number;
    verdict: Verdict;
    lenses: Array<{ lens: string; ok: boolean; blocked: boolean; findings: number }>;
  };
  /**
   * The pushed branch commit the most recent completed lens review read. The
   * next review round diffs against it to show what the fix pass changed
   * (fix-delta.ts). Absent before the first review and on older state files.
   */
  lensReviewedHead?: string;
  /**
   * #543 — the most recent cap kill's trigger evidence (F1 loop / F6
   * token-budget), on pipelineState per the #533 tail-invariance rule.
   * Type: workflow-state-cap.ts (§12).
   */
  capEvidence?: CapEvidence;
  /**
   * #543 F5 — the driver-owned checkpoint taken when the cap kill fired
   * (committed work / remaining paths / status file). Absent until then.
   */
  capedPartialState?: CapedPartialState;
  /** #741 — converge gate's per-deliverable classification. */
  convergeEvidence?: ConvergeEvidence;
  /**
   * PR5 — worktree snapshot captured by `runHandoff`. Lets operator-facing
   * surfaces answer WHERE the work is without re-shelling git. Best-effort:
   * capture failures populate empty / placeholder fields rather than aborting.
   */
  handoffSnapshot?: {
    /** `git status --porcelain` paths; capped at 50 entries for budget. */
    modifiedFiles: string[];
    /** Files in the unstaged tier (M, D, ??, etc. in column 2). */
    unstagedCount: number;
    /** Files in the staged tier (column 1 non-space). */
    stagedCount: number;
    /** True when `git rev-parse --verify <branch>` succeeds locally. */
    branchExists: boolean;
    /** True when `git ls-remote --heads origin <branch>` returns the branch. */
    branchPushed: boolean;
    /** Short SHA of repoRoot's HEAD (the operator's checkout) when the
     * snapshot was taken — NOT the feature branch; see `branchTip`. Absent on
     * snapshots written before the `headSha` → `repoRootHeadSha` rename (no
     * value was ever recorded under the new name), and the handoff omits the line. */
    repoRootHeadSha?: string;
    /** The feature branch's own tip, and its commits ahead of the cycle's
     * base when that was readable. Absent when no local branch exists and on
     * state files written before the field. */
    branchTip?: { sha: string; ahead?: number };
    /** True when reading the branch tip failed for a reason other than the branch
     * not existing — the tip is unknown, not absent, so no repoRoot fallback is shown. */
    branchTipNotRead?: boolean;
    /** Epoch ms when the snapshot was captured. */
    capturedAt: number;
    /** Worktrees that were not removed because they contained uncommitted
     * work or were retained by the sweep. */
    retainedWorktrees?: string[];
    /**
     * #674 — per-worktree COMMITTED work, captured by `runHandoff`.
     *
     * `captureWorktreeSnapshot` reads `git status --porcelain` only, so a
     * developer's committed work on a detached-HEAD worktree (clean tree,
     * N commits ahead of the base) reported 0 files / 0 staged / 0 unstaged
     * — the exact shape of the five parked cycles (#645/#649/#659/#660/
     * #664) whose recovery then printed main-checkout commands that showed
     * nothing. This field records the truth: each worktree's HEAD SHA and
     * how many commits it carries past the cycle's base, so the handoff
     * renderers can name the work's actual location and the pre-handoff
     * consolidation can know whether there is committed work to move.
     *
     * Optional — absent on pre-#674 state files and when the base SHA is
     * unknown (readers treat absent as "no committed work recorded").
     */
    committedWork?: Array<{ worktreeId: string; path: string; headSha: string; ahead: number }>;
    /**
     * git reads that FAILED while the snapshot was taken (`<what>: <error>`).
     * A failed read leaves its field at the empty default, which is
     * indistinguishable from a real "0 files / no branch / no commits" — a
     * fork-exhausted host produced a handoff saying "0 file(s) modified"
     * over five reviewed commits. Non-empty means the fields above are NOT
     * evidence of absence; the renderers say so. Absent on older state files.
     */
    unreadable?: string[];
  };
  /**
   * Epoch ms when the 90-min wall-clock cap was started. Persists across
   * Pi restarts — the cap-state accessor (review-cap.ts) reads this on
   * boot to restore in-memory timers.
   */
  reviewCapStartedAt?: number;
  /** #1238 — the caller's whole-cycle deadline as an absolute epoch ms, so a
   *  resume keeps it (work-driver-deadline.ts). Absent when none was set. */
  cycleDeadlineMs?: number;
  /** Surfaced plumb-reports since the cycle began (for handoff body). */
  plumbReports: Array<{ step: WorkStep; role: string; body: string; at: number }>;
  /** PR number once Step 6 opens one. */
  prNumber?: number;
  /**
   * #1292 — the PR's draft state, recorded only once the PR number is known:
   * `draft` until the review is done, `ready` once marked (or found not to be
   * a draft at all), `ready-failed` (with the last error) when `pr ready`
   * failed. `attempts` counts `pr ready` calls made this cycle (bounded);
   * `holdReason` says why the driver deliberately left it a draft. Absent =
   * no draft fact recorded (the PR was not opened as a draft).
   */
  prDraft?: PrDraftState;
  /**
   * PR17 — SHA of the base commit the feature branch grew from, recorded
   * by the branch step (git rev-parse HEAD at repoRoot after ops created
   * the branch). The outcome-verification gate diffs against this to prove
   * the developer produced changes. Optional so pre-PR17 state files load
   * cleanly; verifiers fall back to origin/<default-branch> when absent.
   */
  baseSha?: string;
  /**
   * #1093 — the ref repoRoot held when the cycle began: the branch name, or
   * the SHA when the operator was detached. Stamped once by the branch step,
   * BEFORE anything can move the checkout (a resumed cycle keeps it). Every
   * restore returns the operator's checkout here — not to mainline, and not
   * to whatever the cycle left checked out. Absent on pre-#1093 state files;
   * restore paths then fall back to their previous targets.
   */
  startRef?: string;
  /** #1362 — cycle-start exempt untracked paths; the restore claim's provenance. */
  dirtyRootExemptBaseline?: import("./workflow-state-dirty-root.ts").DirtyRootExemptBaseline;
  /**
   * #453 — per-workstream applied SHAs for crash-safe resume. Maps
   * workstream id → SHA cherry-picked onto the integration branch; updated as
   * each lands. On crash-resume, matching id+sha entries are skipped. Absent
   * on pre-#453 state files; readers treat absent as {}.
   */
  appliedShas?: Record<string, string>;
  /**
   * PR17 — outcome-verification gate (verifyStepOutcome) evidence for a
   * `verify-failed:<step>` cap; each failure string is one finding rendered by
   * explainCap. Optional — absent unless a gate failed.
   * #782 — optional `retries`/`recovered`: the consolidated-verify gate's single
   * bounded re-run. Absent pre-#782; absent = no re-run, so schemaVersion stays 1.
   */
  verifyEvidence?: {
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
     * #814 — structured develop-scope-fence violations (see
     * `FenceViolation` below). Absent = none recorded.
     */
    fenceViolations?: FenceViolation[];
  };
  /**
   * Terminal status. "running" while active; flips on `merged` or `handoff`.
   * S4a (#1162) — "interrupted" is written by `markInterrupted` (SIGTERM /
   * SIGINT). It is not terminal: re-entry resumes it as "running".
   */
  status: "running" | "merged" | "handoff" | "aborted" | "interrupted";
  /**
   * #580 — ISO timestamp of the last terminal in-chat delivery (merged text,
   * handoff message, etc.). Written write-ahead, BEFORE `notifyAgent` fires.
   * The delivery site refuses to send if the current state already carries it.
   * Absent on pre-#580 state files; readers treat absent as "not yet delivered".
   */
  handoffDeliveredAt?: string;
}

// #1362 — WORK_STEPS' home is workflow-state-events.ts (its own note there
// explains why); it and WorkState (workflow-state-schema-workstate.ts, with
// #1454's single terminal-status notion) left this module for the 500-line gate
// and are re-exported so every importer keeps its path.
export { TERMINAL_STATUSES, isTerminalState } from "./workflow-state-schema-workstate.ts";
export type { WorkState } from "./workflow-state-schema-workstate.ts";

// The state constructors/mutators (`initialState`, `appendEvent`,
// `detectInconsistencies`) live in `workflow-state-update.ts` —
// `workflow-state.ts` re-exports them so existing imports keep working.
