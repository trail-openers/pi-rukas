/**
 * /work workflow state — schema v1.
 *
 * The state file is the durable contract that lets the work-driver:
 *   1. resume a /work cycle that crashed mid-flight (e.g., overnight session
 *      went sideways, Pi got killed, machine rebooted),
 *   2. preserve enough structural facts for the user to intervene
 *      surgically when subagent providers degrade ("switch developer to
 *      cerebras, retry step develop"),
 *   3. tell the driver what the current step is + what to do next, without
 *      asking the LLM.
 *
 * Lives at `<project>/.pi/work-state/<issue>.json`. Matches the existing
 * `.pi/permissions.json`, `.pi/decisions.json` convention (gitignored, project-
 * scoped, survives `git worktree remove`). One file per /work cycle.
 *
 * ## Schema shape
 *
 * **Discriminated union**: `pipelineState` (the reconstructed-on-read
 * snapshot of "where are we right now") + `eventLog` (append-only log of
 * typed events). Why both:
 *
 * - `pipelineState` is fast O(1) "what step are we on, what's blocking" —
 *   driver reads it on resume without replaying the whole log.
 * - `eventLog` is the source of truth for *what happened* — every dispatch,
 *   every cap-hit, every adversarial verdict. New event types are additive;
 *   new fields don't break old readers.
 *
 * On every transition the driver appends to `eventLog` THEN mutates
 * `pipelineState`. Both writes go through `writeState()` which atomically
 * replaces the JSON file. If `pipelineState` drifts from what the event log
 * implies (rare — bug or external edit), the driver should detect it and
 * either repair or surface a loud error; the eventLog is authoritative.
 *
 * ## Versioning
 *
 * `schemaVersion: 1` is MANDATORY from day 1. The reader rejects mismatched
 * versions LOUDLY rather than auto-migrating — see `assertSchemaVersion()`.
 * The recovery affordance is documented in `docs/troubleshooting.md`:
 *   - inspect the file
 *   - either resolve manually or `rm .pi/work-state/<issue>.json` to start
 *     fresh under the new schema (the user keeps their git work; only the
 *     workflow-tracker state goes).
 *
 * ## Resumability
 *
 * v1 is **observational-only**: `resumable: false` is set on every state
 * file. Resumable execution would require async-jobs to survive process
 * restart (it doesn't — jobs live in-memory). The state file lets the user
 * intervene; it does not (yet) replay completed dispatches automatically.
 * Cap-state is the explicit exception — see `pipelineState.reviewRound`
 * + `reviewCapStartedAt` — those WILL survive restart so the cap timer
 * remains coherent.
 *
 * ## GitHub-is-the-bus
 *
 * No cross-command state lookup. The GitHub issue body is the contract
 * between /plan and /work. The schema reserves an optional `upstreamRefs`
 * array for future use but the driver does not implement lookup against
 * it. Keep state intra-command.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Current schema version. Bump on breaking changes. */
export const WORK_STATE_SCHEMA_VERSION = 1 as const;

/**
 * Linear step identifiers walked from `pi-prompts/work.md` (verbatim). Add
 * a step here and the discriminator carries through every event type that
 * names a step. Removing a step is a breaking change → schema bump.
 */
export type WorkStep =
  | "explore" // Step 1 — read issue + recon (gh + @explore)
  | "plan" // Step 2 — PM decomposes (no dispatch — pure PM judgment, may collapse)
  | "branch" // Step 3 — ops creates feature branch + worktrees
  | "develop" // Step 4 — developer implements (+ optional explore in same fanout)
  | "adversarial" // Step 5 — adversarial_loop gates the diff
  | "commit-pr" // Step 6 — ops commits + opens PR
  | "lens-review" // Step 7 — dispatch_lens_review
  | "lens-fix" // Step 7f — developer fixes findings; loops back to adversarial then lens-review
  | "step-back" // Step 7h — @explore steps back when findings cluster around a theme
  | "handoff" // Step 7g — cap-hit handoff artifact (terminal: needs-human-attention)
  | "ci" // Step 8 — ops watches CI
  | "merged"; // Step 9 — merged + learnings stored (terminal: success)

/**
 * Event log — append-only, typed. Driver appends one event per state
 * transition. The log is the audit trail; pipelineState is the derived
 * snapshot. Adding a new event type is additive (older readers will not
 * recognise it but won't crash — they'll see it as an opaque entry).
 *
 * Field naming: prefer `*At` for timestamps (epoch ms), `ms` for durations,
 * `<role>` (lower-case) for subagent roles to match DispatchResult.role.
 */
export type WorkEvent =
  | {
      kind: "step-started";
      step: WorkStep;
      at: number;
      /** PM-judgment-shaped step like "plan" that collapses without dispatch sets this. */
      note?: string;
    }
  | {
      kind: "dispatch-started";
      step: WorkStep;
      role: string;
      jobId: string;
      /** Label (e.g., "developer[task-A]") for batches. */
      label: string;
      at: number;
    }
  | {
      kind: "dispatch-completed";
      step: WorkStep;
      role: string;
      jobId: string;
      label: string;
      ok: boolean;
      ms: number;
      at: number;
      /** Path to the per-spawn Pi session JSON; for user post-hoc inspection. */
      transcriptPath?: string;
      /**
       * Bounded text payload: the subagent's final assistant text (trimmed,
       * truncated). For large outputs the driver writes the full text to a
       * claim-check artifact under `.pi/work-state/<issue>/<dispatch-id>.txt`
       * and stores the path here in `artifactPath` instead.
       */
      summary?: string;
      artifactPath?: string;
    }
  | {
      kind: "dispatch-failed-provider";
      step: WorkStep;
      role: string;
      jobId: string;
      label: string;
      ms: number;
      at: number;
      /** Provider's error message captured from the synthetic stopReason: "error". */
      providerMessage?: string;
      transcriptPath?: string;
    }
  | {
      kind: "dispatch-failed";
      step: WorkStep;
      role: string;
      jobId: string;
      label: string;
      ms: number;
      at: number;
      /** Process-level failure (non-zero exit), distinct from provider-error. */
      exitCode?: number | null;
      errorTail?: string;
    }
  | {
      kind: "adversarial-approved";
      at: number;
      jobId: string;
      rounds: number;
    }
  | {
      kind: "adversarial-rejected";
      at: number;
      jobId: string;
      rounds: number;
      findings: string;
    }
  | {
      kind: "lens-approved";
      at: number;
      jobId: string;
      round: number;
    }
  | {
      kind: "lens-issues-found";
      at: number;
      jobId: string;
      round: number;
      findings: string;
      /** "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND" — preserved verbatim from the verdict. */
      verdict: "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";
    }
  | {
      /**
       * PR6 — runLens skipped child dispatch because the diff was empty.
       * Lens children hallucinate findings against unrelated files when
       * given empty context (#533 PERFORMANCE findings in
       * src/web/sweep_stats.rs on an empty diff for a devDep bump that
       * was already merged). Paired with a synthesised `lens-approved`
       * so the driver's nextStep advances normally; the standalone event
       * preserves the audit trail.
       */
      kind: "lens-skipped-empty-diff";
      at: number;
      round: number;
    }
  | {
      kind: "cap-hit";
      at: number;
      /**
       * Which cap fired. Maps to /work.md Step 7g doctrine plus the
       * "ci-retry" cap added in PR2 after the live-test infinite-loop bug:
       * ci-status:failure → develop → adversarial → review → ci → ... had no
       * cap of its own and could spin forever when the branch step silently
       * ABORTed and no PR ever existed for CI to watch.
       *
       * PR5 adds two new cap shapes for halt-cascade prevention:
       *  - "developer-timeout": developer subagent SIGTERM'd by spawn-cap.
       *    Routed by the post-step dispatch-failed router to handoff
       *    immediately so adversarial doesn't waste hours on partial work
       *    (the empirical #553 cascade).
       *  - "step-failed:<step>": generic dispatch-failed at any HALT-class
       *    step (explore / plan / branch / commit-pr / lens-fix / ci) or
       *    retry-exhausted at any RETRY_ONCE-class step (adversarial /
       *    lens-review). Template-literal shape so explainCap() can
       *    enumerate without losing the originating step name.
       */
      cap:
        | "adversarial-loop"
        | "round-cap"
        | "wall-clock"
        | "ci-retry"
        | "developer-timeout"
        | "explore-already-complete"
        | "explore-needs-clarification"
        // PR11: pre-condition failure — `gh issue view <N>` returned empty
        // or errored for one or more issues. The driver halts before
        // explore-dispatch processing because per-issue verdict routing
        // is unreliable on partial body data (live evidence: v10r
        // 2026-06-25 where 4/5 empty bodies cascaded into wrong-issue
        // work landing on main).
        | "explore-bodies-empty"
        // PR12 — emitted by `runStepBack` after the SDD analysis lands so
        // the handoff renderers have a cap to switch on (step-back-
        // completed alone is invisible to explainCap). Surfaces the
        // proposedRevision + the /plan + /work --restart recovery path.
        | "step-back-revise-spec"
        // PR14 — emitted by the post-dispatch consolidation gate in
        // runCommitPr when the committed diff is missing files from
        // one or more workstreams' scope. The N>1 commit-pr prompt
        // (also new in PR14) is supposed to consolidate every worktree
        // before committing; this cap-hit catches the case where ops
        // drifted and committed only a subset. Pre-PR14 the partial
        // commit shipped silently (live evidence: /work 577 on v0.12.13
        // closed #577 with 1 of 3 workstreams' changes — root fix
        // lost from main).
        | "commit-pr-incomplete-consolidation"
        // PR17 — emitted by the driver-side outcome verification gate
        // (verifyStepOutcome) when a step's claimed outcome doesn't match
        // executed evidence: develop claimed done but no worktree has any
        // diff, the project's verify command (typecheck/test) exits
        // non-zero, commit-pr claimed a PR but no commits exist on the
        // branch or the PR number doesn't resolve via gh. The evidence
        // lives in pipelineState.verifyEvidence for the handoff body.
        // Escape hatch: PI_ENSEMBLE_VERIFY=0 disables the gate.
        | `verify-failed:${WorkStep}`
        | `step-failed:${WorkStep}`;
      reviewRound: number;
      /** What the driver will do next — either "handoff" (terminal) or "step-back" (Step 7h). */
      nextStep: "handoff" | "step-back";
    }
  | {
      kind: "plumb-report";
      at: number;
      /** Which step surfaced the structural decision. */
      step: WorkStep;
      /** Subagent that surfaced it. */
      role: string;
      /** Free-text structural decision body (PM-readable). */
      body: string;
    }
  | {
      kind: "step-back-triggered";
      at: number;
      /** Theme the driver clustered around — derived from prior findings. */
      theme: string;
    }
  | {
      kind: "step-back-completed";
      at: number;
      jobId: string;
      /** Which of the six SDD elements was identified as underspecified. */
      sddElement: string;
      diagnosis: string;
      proposedRevision: string;
    }
  | {
      kind: "handoff-emitted";
      at: number;
      /** GitHub URL of the handoff PR/issue comment. */
      commentUrl?: string;
      labelApplied: boolean;
      /**
       * Absolute path to the rich handoff markdown body the driver wrote
       * (`tmp/issue-<N>/handoff-comment.md`). PR5: lets
       * `renderHandoffUserMessage` produce the verbatim
       * `gh issue comment <N> --body-file <path>` recovery command
       * without re-deriving the path. Optional for back-compat with PR4
       * events.
       */
      handoffBodyPath?: string;
    }
  | {
      kind: "ci-status";
      at: number;
      status: "pending" | "success" | "failure";
      runUrl?: string;
    }
  | {
      kind: "merged";
      at: number;
      prNumber: number;
      mergeCommit?: string;
    }
  | {
      /**
       * Driver fanned out a step into N parallel branches (PR3 multi-
       * workstream support). Emitted before the Promise.all that
       * dispatches the N children. Pairs with `branches-converged` —
       * if the converged event is missing on resume, the driver crashed
       * mid-fanout (resume-hazard signal via `detectInconsistencies`).
       */
      kind: "branches-fanned-out";
      step: WorkStep;
      workstreams: string[];
      at: number;
    }
  | {
      /**
       * One branch of a fanned-out step completed (PR3). Recorded
       * per-branch so `/work-status` can surface partial progress
       * ("2 of 3 branches done") and the user can see which specific
       * workstream id failed when one does.
       */
      kind: "branch-completed";
      step: WorkStep;
      workstreamId: string;
      ok: boolean;
      ms: number;
      at: number;
      /** Failure tail (truncated) when ok=false. */
      error?: string;
    }
  | {
      /**
       * Fanned-out step's `Promise.all` resolved (PR3). Carries the
       * per-branch verdicts so the driver's next-step decision can
       * route on the aggregate (e.g., "any branch failed" → halt).
       */
      kind: "branches-converged";
      step: WorkStep;
      verdicts: Array<{ id: string; ok: boolean }>;
      at: number;
    };

/** Discriminator union of event kinds — useful for callers that switch on it. */
export type WorkEventKind = WorkEvent["kind"];

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
 * Resolve the project-local state directory. We anchor on `cwd` rather than
 * the worktree path because state must live at the project root so
 * `git worktree remove` doesn't take it down. Matches the existing
 * `.pi/permissions.json` convention.
 *
 * `repoRoot` should be the absolute path to the git repo's worktree root
 * (NOT a sub-worktree). Callers can resolve via `git rev-parse --show-toplevel`
 * outside any worktree, or via the parent path if running inside a worktree.
 */
export function workStateDir(repoRoot: string): string {
  return path.join(repoRoot, ".pi", "work-state");
}

/** Resolve the state file path for an issue. */
export function workStateFile(repoRoot: string, issue: number): string {
  return path.join(workStateDir(repoRoot), `${issue}.json`);
}

/** Resolve the claim-check artifact path for a dispatch. */
export function dispatchArtifactPath(repoRoot: string, issue: number, dispatchId: string): string {
  return path.join(workStateDir(repoRoot), String(issue), `${dispatchId}.txt`);
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
 * Read state from disk. Returns undefined when the file doesn't exist
 * (fresh /work cycle). Throws on schema mismatch — callers should surface
 * the loud error rather than auto-migrating.
 */
export async function readState(repoRoot: string, issue: number): Promise<WorkState | undefined> {
  const file = workStateFile(repoRoot, issue);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `work-state: ${file} is not valid JSON — ${(err as Error).message}. Inspect the file or rm to start fresh under the current schema (your git work is unaffected).`,
    );
  }
  return assertSchemaVersion(parsed as Record<string, unknown>, file);
}

/**
 * Reject mismatched schema versions LOUDLY. Future v2 can add a migration
 * path before the throw; for v1 this is the only path.
 */
function assertSchemaVersion(raw: Record<string, unknown>, file: string): WorkState {
  const v = raw.schemaVersion;
  if (v !== WORK_STATE_SCHEMA_VERSION) {
    throw new Error(
      `work-state: ${file} has schemaVersion=${String(v)} but this build expects ${WORK_STATE_SCHEMA_VERSION}. This /work cycle was started under a different driver version. Inspect the file or rm to start fresh (your git work is unaffected; only the workflow-state file is removed). Alternatively run with PI_ENSEMBLE_WORK_DRIVER=0 to use the legacy PM-driven flow.`,
    );
  }
  return raw as unknown as WorkState;
}

/**
 * Atomic state write: write to <file>.tmp then rename. Avoids leaving a
 * half-written file if the process dies mid-write. Updates `updatedAt`.
 */
export async function writeState(repoRoot: string, state: WorkState): Promise<void> {
  const file = workStateFile(repoRoot, state.issue);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const next: WorkState = { ...state, updatedAt: Date.now() };
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
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
 * Persist a claim-check artifact (large subagent output) and return the
 * path. Used by the driver when a dispatch result's `text` exceeds a
 * threshold — keeping the state file small lets the driver stay fast on
 * reads.
 */
export async function writeDispatchArtifact(
  repoRoot: string,
  issue: number,
  dispatchId: string,
  body: string,
): Promise<string> {
  const file = dispatchArtifactPath(repoRoot, issue, dispatchId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, "utf8");
  return file;
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
