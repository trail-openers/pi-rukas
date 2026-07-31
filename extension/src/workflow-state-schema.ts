/**
 * /work workflow state — pipeline snapshot + top-level state shape, plus
 * pure (no-fs) helpers that operate on in-memory `WorkState`.
 *
 * `PipelineState` (the reconstructed-on-read snapshot of "where are we
 * right now") and `WorkState` (the top-level state-file shape). Split out
 * of `workflow-state.ts` for module-size hygiene (AGENTS.md §12) —
 * re-exported from there so external consumers' import paths are
 * unaffected. See `workflow-state.ts` for the full schema doc (versioning,
 * resumability, GitHub-is-the-bus).
 */

import type { WorkEvent, WorkStep } from "./workflow-state-events.ts";

/** Current schema version. Bump on breaking changes. */
export const WORK_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Pipeline snapshot — driver's "where are we" view, reconstructible from
 * eventLog but stored explicitly so reads are O(1). When the two diverge,
 * eventLog is authoritative; the driver should rebuild pipelineState from
 * scratch on read if it detects inconsistency.
 */
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
   * Hard cap at 3 per /work.md Step 7f.6.
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
   * PR14 — per-workstream "missing from committed diff" list. Populated
   * by `runCommitPr`'s post-dispatch consolidation gate when the
   * integration branch's diff (vs origin/main) doesn't include files
   * from one or more workstreams' `paths`. Drives the operator-facing
   * handoff body — each entry names which workstream's slice didn't
   * land. Absent for N=1 cycles and for happy-path N>1 cycles where
   * every workstream's files appear in the diff.
   */
  incompleteConsolidation?: Array<{ id: string; paths: string[] }>;
  /**
   * PR10 — multi-issue counterpart of `activeIssues`: issues filtered
   * out by `runExplore` because explore declared them complete or
   * ambiguous. Surfaced in handoff renderers + PR body so the operator
   * sees WHICH issues were dropped and WHY. Empty for single-issue
   * cycles and for older state files.
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
   * v1 contract: state is observational, not resumable for in-flight async
   * jobs. The user can intervene surgically when they come back; the
   * driver does not auto-resume completed dispatches yet. Reserved field
   * so v2 (true resumable) can flip it without a schema bump.
   */
  resumable: false;
  /** Primary issue number this /work cycle targets — anchors the state-file path
   * (`.pi/work-state/<issue>.json`) and the feature branch name. For multi-issue
   * cycles (PR10 `/work N M P`) this is the FIRST issue in `issues`; readers
   * that need the full list should consult `issues` and fall back to `[issue]`
   * when absent (back-compat with pre-PR10 state files).
   */
  issue: number;
  /**
   * PR10 — all issue numbers passed to `/work`. Absent for single-issue cycles
   * and for state files written before PR10; readers MUST fall back to
   * `[WorkState.issue]` in that case. The first entry equals `WorkState.issue`.
   */
  issues?: number[];
  /** Epoch ms when the cycle started. */
  startedAt: number;
  /** Latest write; for "did the user just nudge this?" UX heuristics. */
  updatedAt: number;
  /**
   * Optional pointers to other GitHub artefacts (plan issue, parent PR,
   * etc.). Reserved for inter-command composition; v1 driver does not read
   * these. GitHub-is-the-bus axiom.
   */
  upstreamRefs?: Array<{ kind: "plan-issue" | "parent-pr" | "other"; ref: string }>;
  pipelineState: PipelineState;
  eventLog: WorkEvent[];
}

/**
 * Build an initial state for a fresh /work cycle. Caller must `writeState`
 * to persist.
 */
export function initialState(issue: number, now: number = Date.now()): WorkState {
  return {
    schemaVersion: WORK_STATE_SCHEMA_VERSION,
    resumable: false,
    issue,
    startedAt: now,
    updatedAt: now,
    pipelineState: {
      currentStep: "explore",
      inFlightJobIds: [],
      worktrees: {},
      reviewRound: 0,
      ciRetryCount: 0,
      plumbReports: [],
      status: "running",
    },
    eventLog: [],
  };
}

/**
 * Append an event AND patch pipelineState in one atomic write. The driver
 * uses this for every transition — `appendEvent(state, evt)` returns the
 * updated state but does NOT persist; callers `await writeState(...)`
 * after batching their event(s) + pipelineState mutation.
 *
 * Why not auto-persist: some transitions emit multiple events at once
 * (e.g., dispatch-completed + adversarial-approved); persisting between
 * them would expose intermediate states to a concurrent reader.
 */
export function appendEvent(state: WorkState, ...events: WorkEvent[]): WorkState {
  return {
    ...state,
    eventLog: [...state.eventLog, ...events],
  };
}

/**
 * Detect inconsistency: pipelineState says we have in-flight jobs but the
 * eventLog has no matching dispatch-started. Or pipelineState.currentStep
 * doesn't match the last step-started in the log. The driver calls this
 * on resume to decide whether the file is trustworthy.
 *
 * Returns an array of human-readable inconsistencies, empty if state is
 * coherent. Caller decides whether to halt or repair.
 */
export function detectInconsistencies(state: WorkState): string[] {
  const out: string[] = [];
  const lastStepStarted = [...state.eventLog]
    .reverse()
    .find((e): e is Extract<WorkEvent, { kind: "step-started" }> => e.kind === "step-started");
  if (lastStepStarted && lastStepStarted.step !== state.pipelineState.currentStep) {
    // Allow forward drift — pipelineState moved ahead of the last step-started
    // (rare but legal for PM-judgment steps that collapse without emitting).
    // Backward drift is the bug we care about.
    // For v1 we just report; callers can decide.
    out.push(
      `pipelineState.currentStep=${state.pipelineState.currentStep} but last step-started was ${lastStepStarted.step}`,
    );
  }
  // Every inFlightJobId should have a dispatch-started in the log without a
  // matching dispatch-completed / dispatch-failed*.
  for (const jobId of state.pipelineState.inFlightJobIds) {
    const started = state.eventLog.find(
      (e) =>
        (e.kind === "dispatch-started" ||
          e.kind === "dispatch-completed" ||
          e.kind === "dispatch-failed" ||
          e.kind === "dispatch-failed-provider") &&
        "jobId" in e &&
        e.jobId === jobId,
    );
    if (!started) {
      out.push(`pipelineState.inFlightJobIds includes ${jobId} but log has no record of it`);
    }
  }
  return out;
}
