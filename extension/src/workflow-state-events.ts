/**
 * /work workflow state — event-log types.
 *
 * `WorkStep` (the linear step identifiers the driver walks)
 * and `WorkEvent` (the append-only, typed event-log entries the driver
 * writes on every state transition). Split out of `workflow-state.ts` for
 * module-size hygiene (AGENTS.md §12) — re-exported from there so external
 * consumers' import paths are unaffected. See `workflow-state.ts` for the
 * full schema doc (versioning, resumability, GitHub-is-the-bus).
 */

import type { RoleName } from "./roles.ts";
import type { DispatchUsage } from "./types.ts";
import type { CommitPrFallbackCause } from "./workflow-state-events-commitpr.ts";
import type { MemoryEventFragment } from "./workflow-state-events-memory.ts";
import type { WorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import type { WideningScanEvent } from "./workflow-state-events-widening.ts";

/**
 * Linear step identifiers the driver walks. This union IS the definition of
 * the cycle — #393 deleted the prose flow that used to be its source. Add
 * a step here and the discriminator carries through every event type that
 * names a step. Removing a step is a breaking change → schema bump.
 */
// #539 — the commit-pr fallback-cause vocabulary (M1) lives in the
// sibling events-memory fragment module, next to its other pure
// event-type fragment: single definition, writer imports it from there.
export type { CommitPrFallbackCause } from "./workflow-state-events-commitpr.ts";
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
      /** #543 F3a — the child's session file (Pi transcript); re-attach key. Optional for back-compat. */
      transcriptPath?: string;
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
      /** #534 — tokens/cost the child actually consumed (see `withUsage`). */
      usage?: DispatchUsage;
      /** #456 — per-lens lens-review timings; additive, old state files load unchanged. */
      lensTimings?: Array<{ lens: string; startMs: number; ms: number }>;
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
      /** #534 — tokens flushed before the provider-error stop. */
      usage?: DispatchUsage;
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
      /** Structured self-kill cause (#296; #543 adds loop/token-budget). */
      killCause?: "timeout" | "inactivity" | "abort" | "loop" | "token-budget";
      /** #543 — the F1 streak evidence at a loop kill (tool + count); the
       * step router persists it on `pipelineState.capEvidence` at the
       * cap-hit so `explainCap` can render WHAT looped. */
      loopEvidence?: { tool: string; count: number };
      /** #543 — the F6 budget + used tokens at a token-budget kill; same
       * purpose as `loopEvidence`. Absent for every other killCause. */
      tokenBudget?: { budget: number; used: number };
      /** #534 — tokens flushed before the process-level failure. */
      usage?: DispatchUsage;
    }
  | {
      kind: "adversarial-approved";
      at: number;
      jobId: string;
      rounds: number;
      /**
       * Non-blocking findings that were outstanding when the gate passed.
       *
       * Only `CRITICAL_ISSUES_FOUND` blocks the commit; `ISSUES_FOUND` and
       * `MINOR_OBSERVATIONS` are documented as non-blocking and let the cycle
       * proceed. They are carried here so `commit-pr` can put them in the PR
       * body and the six-lens review can see them — passing a finding on is
       * not the same as discarding it, and that distinction is what makes the
       * relaxed terminal rule safe.
       */
      findings?: string;
    }
  | {
      kind: "adversarial-rejected";
      at: number;
      jobId: string;
      rounds: number;
      findings: string;
    }
  | {
      /**
       * #485 — one round of the adversarial loop, recorded verbatim from the
       * loop's own round table (NOT recovered from reply prose). The gate's
       * per-round decisions were previously recoverable only from the
       * transcript (issue #478), and the one aggregate `rounds` field was
       * guessed by `parseAdversarialRounds` — an infra failure in round 1
       * reported as "3 rounds, all rejected".
       *
       * `verdictParsed: false` is a real state: the reviewer ran but wrote
       * no readable VERDICT marker, and the status is the parser's safe
       * default, not the reviewer's. The driver records it exactly so
       * "this workstream was rejected" and "this workstream never produced
       * a verdict" stay distinct from the state file.
       */
      kind: "adversarial-round";
      at: number;
      /** #486 — which workstream's loop ran this round. */
      workstreamId?: string;
      round: number;
      status: "CRITICAL_ISSUES_FOUND" | "ISSUES_FOUND" | "MINOR_OBSERVATIONS" | "APPROVED";
      verdictParsed: boolean;
    }
  | {
      /**
       * #485/#486 — the per-workstream terminal outcome of the adversarial
       * loop, distinct from the aggregate verdict events:
       *
       *  - "approved" / "rejected" — a review completed and decided.
       *  - "infra-failure" — a round's dispatch died; NO verdict exists.
       *    Must never render as "all rejected" (issue #478).
       *  - "dispatch-failed" — the loop itself threw before any review ran.
       *  - "skipped-empty-diff" — #286 short-circuit; counts as a pass.
       *
       * Emitted per workstream on N>1 fan-outs so a partial failure
       * (issue #486: one workstream's loop dies, siblings approved) records
       * every sibling's outcome individually instead of discarding the
       * approved ones under one aggregate rejection.
       */
      kind: "adversarial-workstream-outcome";
      at: number;
      workstreamId: string;
      outcome: "approved" | "rejected" | "infra-failure" | "dispatch-failed" | "skipped-empty-diff";
      /** Reviews executed for this workstream (0 when none ran). */
      roundsExecuted: number;
      /** Present for infra-failure / dispatch-failed — what the failure was. */
      errorTail?: string;
    }
  | {
      kind: "lens-approved";
      at: number;
      jobId: string;
      round: number;
      /** #456 — sub-threshold findings retained on an APPROVED verdict (same shape as `lens-issues-found`). */
      findings?: string;
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
       * PR6 — runLens skipped child dispatch (empty diff); paired with a
       * synthesised `lens-approved` so the driver advances. Avoids #533
       * hallucinated findings on empty context.
       */
      kind: "lens-skipped-empty-diff";
      at: number;
      round: number;
    }
  | {
      /**
       * #286 — runAdversarial skipped the adversarial loop for a workstream
       * because its per-worktree diff was empty. Full adversarial reviewer
       * spawns on empty diffs were pure waste: one spawn on nessie 2026-07-27
       * concluded "treat the empty diff as a legitimate no-op" after burning
       * a complete review cycle. Skipped workstreams count as ok for the
       * aggregate verdict. Escape hatch: PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP=0.
       */
      kind: "adversarial-skipped-empty-diff";
      at: number;
      workstreamId: string;
    }
  | {
      kind: "cap-hit";
      at: number;
      /**
       * #492 — the worktree the lens-fix driver inspected, named so the
       * handoff tells the operator WHERE to look (`git -C <worktree>
       * status`) instead of "a worktree".
       */
      lensWorktreePath?: string;
      /**
       * Which cap fired. Covers the handoff-doctrine caps plus the
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
        // A lens failed every retry, so the six-pass review is incomplete.
        // Distinct from the round cap: nothing capped, the review could not be
        // completed. This used to be reported as "adversarial-loop".
        | "review-incomplete"
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
        | "lens-fix-not-integrated"
        | "integration-verify-failed"
        // PR17 — emitted by the driver-side outcome verification gate
        // (verifyStepOutcome) when a step's claimed outcome doesn't match
        // executed evidence: develop claimed done but no worktree has any
        // diff, the project's verify command (typecheck/test) exits
        // non-zero, commit-pr claimed a PR but no commits exist on the
        // branch or the PR number doesn't resolve via gh. The evidence
        // lives in pipelineState.verifyEvidence for the handoff body.
        // Escape hatch: PI_ENSEMBLE_VERIFY=0 disables the gate.
        // #362 — emitted by the branch-step pre-flight when an open PR
        // already covers this cycle's issue. Fires BEFORE any dispatch, so
        // a duplicate cycle costs zero tokens. The driver halts rather than
        // adopting the PR: attaching our commits to a PR whose head is a
        // different branch is the false-MERGED class (#245/#253), and
        // choosing between resume / retarget / close is judgment.
        // Escape hatch: PI_ENSEMBLE_PR_PREFLIGHT=0.
        // #378 — the intent resolver refused to write code: the issue could
        // not be resolved into a concrete, grounded intent. Fires BEFORE plan,
        // so a park costs one explore dispatch rather than a whole cycle. The
        // specific reason lives in pipelineState.normalisedSpec.parkReason.
        | "intent-park"
        // #380 — the PR is open and green but the driver is not permitted to
        // merge it (no grant in AGENTS.md, no operator grant), or the executed
        // evidence refused. Merging is the one irreversible act in the cycle
        // and is opt-in: the absence of permission is not permission.
        | "awaiting-human-merge"
        // #384 — lens-review could not read the diff it is supposed to
        // review. Previously an unreadable diff returned "" and the
        // empty-diff guard APPROVED on it, merging code unreviewed. Halting
        // is cheap; approving on the absence of evidence is not.
        | "lens-diff-unreadable"
        | "existing-pr-detected"
        // #486 — infra-failure: adversarial loop failed on infra every attempt.
        | "adversarial-infra-failure"
        // #571 — sibling cycle holds a path claim; overlap detected at plan
        // time. Two cycles cannot edit the same files in parallel.
        | "cross-group-conflict"
        // #543 — fixed literals (NOT `'<role>'` template shapes): a per-role
        // suffix would smuggle a cap the #533 canary doesn't know. Which role's
        // child was killed is carried in the new `role` field + capEvidence.
        | "loop-detected"
        | "token-budget"
        | `verify-failed:${WorkStep}`
        | `step-failed:${WorkStep}`;
      /** #543 — which role's child was cap-killed (loop/token-budget caps). */
      role?: RoleName;
      reviewRound: number;
      /**
       * #492 — the git evidence that establishes WHICH failure mode
       * produced this cap-hit, verbatim from the command that established
       * it. On `lens-fix-not-integrated` it distinguishes "the fixer
       * wrote nothing" from "a diff existed but integration failed".
       */
      evidence?: string;
      /**
       * What the driver will do next: "handoff" (terminal), "step-back"
       * (Step 7h), or "ci" (Step 8).
       *
       * "ci" exists for one cap only — a `round-cap` on a non-critical verdict
       * whose residual findings were posted to the PR. Every other cap that
       * fires is a reason to stop; that one was parking work a human then
       * merged unchanged. See `work-driver-lens-cap.ts` for why the other caps
       * did not move with it.
       */
      nextStep: "handoff" | "step-back" | "ci";
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
      /** #539 — machine-readable commit-pr fallback cause (single writer:
       * runCommitPrLocked), vocabulary in workflow-state-events-commitpr.ts. */
      fallbackCause?: CommitPrFallbackCause;
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
    }
  | {
      /**
       * Issue #279 — verify-full tier status.
       *
       * The verify-full suite runs driver-side in the ci step BEFORE
       * the ops gh-run-watch dispatch. Provides visibility into the
       * "fast green, full unrun/red" gap that caused the vipune bug:
       * the fast suite passed for ~2.5 months while the real-embedder
       * tests sat behind #[ignore].
       *
       * "skipped" is emitted when `.pi/verify-cmd-full` is absent —
       * silent absence would recreate the exact ambiguity this removes.
       */
      kind: "verify-full-status";
      at: number;
      status: "success" | "failure" | "skipped";
      /** Time spent executing the full suite (ms). Undefined when skipped. */
      ms?: number;
      /** Tail of the command output for the handoff/comment body. */
      evidenceTail?: string;
    }
  // The widening-scan, memory, and provision events live in their own
  // fragment modules (AGENTS.md §12 module-size hygiene). The union stays
  // exhaustive: nextStep() and the schema validator see the same closed type.
  | WideningScanEvent
  | MemoryEventFragment
  | WorktreeProvisionedEvent;

/** Discriminator union of event kinds — useful for callers that switch on it. */
export type WorkEventKind = WorkEvent["kind"];
