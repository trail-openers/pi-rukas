/**
 * /work workflow state — pipeline snapshot + top-level state shape / types.
 * Split out of `workflow-state.ts` (AGENTS.md §12 file-size limit).
 */

import type { Verdict } from "./lens-review.ts";
import type { CapEvidence, CapedPartialState } from "./workflow-state-cap.ts";
import type { WorkEvent, WorkStep } from "./workflow-state-events.ts";

export {
  filesPresentFromConsolidation,
  type IncompleteConsolidation,
  type ConsolidationVerdict,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state-consolidation.ts";
import type { IncompleteConsolidation } from "./workflow-state-consolidation.ts";

/** Current schema version. Bump on breaking changes. */
export const WORK_STATE_SCHEMA_VERSION = 1 as const;

/**
 * The WorkStep vocabulary as a runtime value. The union type is the source
 * of truth for TS callers; this tuple exists so runtime readers (the #533
 * discriminant validator) can test membership — types are erased by the
 * untyped cast in `readState`, which is exactly why the validator needs it.
 */
export const WORK_STEPS: readonly WorkStep[] = [
  "explore",
  "plan",
  "branch",
  "develop",
  "adversarial",
  "commit-pr",
  "lens-review",
  "lens-fix",
  "step-back",
  "handoff",
  "ci",
  "merged",
];

export type { CapedPartialState, CapEvidence } from "./workflow-state-cap.ts";

export interface CommitPrRootState {
  /** Current branch (`git rev-parse --abbrev-ref HEAD`); placeholder when unreadable. */
  branch: string;
  /** Porcelain column-1/2 status codes (`UU`, `AA`, `DD` — the unmerged set). */
  unmergedPaths: string[];
  /** Entries staged on BOTH columns (`MM`, ` M`, `A `, …) — untracked (`??`) excluded. */
  stagedCount: number;
  /** Total porcelain entries (staged + unstaged + untracked). */
  totalEntries: number;
  /** Epoch ms of the inspection. */
  capturedAt: number;
}

/**
 * Pipeline snapshot — the driver's "where are we" view, reconstructible
 * from eventLog but stored explicitly for O(1) reads. When the two
 * diverge, eventLog is authoritative.
 */
export type PlanQualityReason =
  | "under-decomposed"
  | "empty-paths"
  | "overlapping-paths"
  | "test-subject-split";

export interface PipelineState {
  /** Current step. Drives template selection and transition table. */
  currentStep: WorkStep;
  /**
   * Last completed step (for resume; tells driver what to skip). Undefined
   * when no steps have completed yet.
   */
  lastCompletedStep?: WorkStep;
  /**
   * Active dispatch IDs in flight under `currentStep`. Cleared when
   * dispatch-completed lands. Driver uses this to detect "we crashed
   * mid-dispatch" on resume — if the eventLog has dispatch-started without
   * a matching dispatch-completed, the driver halts and asks the user to
   * verify worktree state (per the troubleshooting doc).
   */
  inFlightJobIds: string[];
  /** Feature branch name once Step 3 completes. */
  branchName?: string;
  /**
   * Workstreams decomposed by Step 2 (plan). Single-task /work writes
   * `{default: {id:"default", scope, paths, outOfScope}}` so downstream
   * code paths can treat `N=1` and `N>1` uniformly — they iterate
   * `Object.keys(workstreams)` either way.
   *
   * - `id` matches the key (e.g., "default", "task-a", "task-b")
   * - `scope` is a one-line brief; passed into the developer prompt
   * - `paths` lists touchpoint files; helps developer stay in scope
   * - `outOfScope` is the explicit fence — addresses the issue #553
   *   scope-contamination empirical pattern (developer pulled off-scope
   *   e2e files into a UX-fix PR because nothing told them what was OUT)
   *
   * Optional in the schema so state files written before PR3 still load
   * cleanly under the same `schemaVersion: 1`. Readers treat absent as
   * `{default: ...}` synthesised from the issue title.
   */
  workstreams?: Record<
    string,
    { id: string; scope: string; paths: string[]; outOfScope: string[] }
  >;
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
   * #378 — the resolved intent: what the issue is actually asking for,
   * checked against the code and the world, plus the verdict the driver
   * routed on. Absent when intent resolution is disabled or the resolver
   * returned no `## Spec` block. The full artifact is also written to
   * `.pi/work-state/<issue>/spec.txt` for inspection.
   */
  normalisedSpec?: {
    intent: string;
    deliverables: Array<{ id: string; description: string; paths: string[] }>;
    acceptanceCriteria: string[];
    outOfScope: string[];
    assumptions: Array<{ text: string; basis: string }>;
    openQuestions: string[];
    evidence: Array<{ claim: string; source: string; verdict: string }>;
    verdict: "proceed" | "proceed-with-assumptions" | "park";
    parkReason?: string;
    rationale: string;
  };
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
    /** Why the executed-evidence gate refused, when authority was granted. */
    evidenceReason?: string;
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
  };
  /**
   * PR14/#540 — the subsumption-aware consolidation verdict: `verdicts`
   * (workstreams NOT covered by the committed diff) + `filesPresent` (what
   * shipped). Single writer: `runCommitPr`'s gate. The `Array` member is
   * the pre-#540 shape — legacy files must keep reading; the validator
   * accepts both.
   */
  incompleteConsolidation?: IncompleteConsolidation | Array<{ id: string; paths: string[] }>;

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
   * (provider error-stop, pi-ensemble timeout/inactivity kill) on
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
  /**
   * PR5 — worktree snapshot captured by `runHandoff` before emitting
   * the handoff artefact. Lets the operator-facing surfaces
   * (renderHandoffUserMessage, renderTerminalStatus,
   * renderHandoffMarkdown) answer WHERE the work is without re-shelling
   * git on every call. Best-effort: capture failures populate the
   * snapshot with empty / placeholder fields rather than aborting the
   * handoff.
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
    /** Short SHA of HEAD when the snapshot was taken. */
    headSha: string;
    /** Epoch ms when the snapshot was captured. */
    capturedAt: number;
    /** Worktrees that were not removed because they contained uncommitted
     * work or were retained by the sweep. */
    retainedWorktrees?: string[];
  };
  /**
   * Epoch ms when the 90-min wall-clock cap was started. Persists across
   * Pi restarts — the cap-state accessor (review-cap.ts) reads this on
   * boot to restore in-memory timers.
   */
  reviewCapStartedAt?: number;
  /** Surfaced plumb-reports since the cycle began (for handoff body). */
  plumbReports: Array<{ step: WorkStep; role: string; body: string; at: number }>;
  /** PR number once Step 6 opens one. */
  prNumber?: number;
  /**
   * PR17 — SHA of the base commit the feature branch grew from, recorded
   * by the branch step (git rev-parse HEAD at repoRoot right after ops
   * created the branch). The outcome-verification gate diffs against
   * this to prove the developer actually produced changes. Optional so
   * pre-PR17 state files load cleanly; verifiers fall back to
   * origin/<default-branch> when absent.
   */
  baseSha?: string;
  /**
   * PR17 — evidence captured by the outcome-verification gate
   * (verifyStepOutcome) when a `verify-failed:<step>` cap fires. Each
   * failure string is one human-readable finding (e.g., "developer
   * claimed done but every worktree has an empty diff", "verify command
   * `cargo check` exited 101: <tail>"). Rendered into the handoff body
   * by explainCap. Optional — absent unless a gate has failed.
   */
  verifyEvidence?: { step: WorkStep; failures: string[]; at: number };
  /** Terminal status. "running" while active; flips on `merged` or `handoff`. */
  status: "running" | "merged" | "handoff" | "aborted";
}

/**
 * Top-level state-file shape. The schemaVersion field is at the top so
 * future readers can sanity-check before parsing the rest.
 */
export interface WorkState {
  /** Schema version; MANDATORY. Mismatched versions are rejected loudly. */
  schemaVersion: typeof WORK_STATE_SCHEMA_VERSION;
  /**
   * Whether this state file carries enough information to resume from.
   *
   * #382 — this was `false` as a LITERAL TYPE, so it could never be anything
   * else, and no code wrote it. It is now a real boolean: `true` once a
   * dispatch write-ahead has happened, meaning `inFlightJobIds` and `owner`
   * can be trusted. State files written by older versions read `false` and
   * are treated as pre-resume, which is the honest answer for them.
   */
  resumable: boolean;
  /**
   * #382 — which process owns this cycle, and since when.
   *
   * A file that says `status: "running"` is either a live driver's or a
   * corpse's, and those need opposite responses: resume the corpse, refuse
   * the live one. Without this the driver could not tell them apart, so it
   * did neither.
   */
  owner?: { pid: number; at: number };
  /**
   * Primary issue number — anchors the state-file path (`.pi/work-state/
   * <issue>.json`) + branch name. PR10: first of `issues` (the full list
   * passed to `/work N M P`); readers fall back to `[issue]` (pre-PR10).
   */
  issue: number;
  issues?: number[];
  /** Epoch ms when the cycle started. */
  startedAt: number;
  /** Latest write; for "did the user just nudge this?" UX heuristics. */
  updatedAt: number;
  /**
   * Pointers to other GitHub artefacts (plan issue, parent PR). Reserved for
   * inter-command composition; the v1 driver does not read these.
   */
  upstreamRefs?: Array<{ kind: "plan-issue" | "parent-pr" | "other"; ref: string }>;
  pipelineState: PipelineState;
  eventLog: WorkEvent[];
}

// The state constructors/mutators (`initialState`, `appendEvent`,
// `detectInconsistencies`) live in `workflow-state-update.ts` — split for
// module-size hygiene (AGENTS.md §12); `workflow-state.ts` re-exports them
// so existing imports keep working unchanged.
