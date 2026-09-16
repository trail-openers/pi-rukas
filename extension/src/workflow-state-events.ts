/**
 * /work workflow state — event-log types.
 * `WorkStep` (the linear step identifiers the driver walks) and `WorkEvent`
 * (the append-only, typed event-log entries the driver writes on every state
 * transition). Split out of `workflow-state.ts` for module-size hygiene
 * (AGENTS.md §12) — re-exported from there so consumers' import paths are
 * unaffected.
 */
import type { RoleName } from "./roles.ts";
import type { DispatchUsage } from "./types.ts";
import type { AdversarialEventFragment } from "./workflow-state-events-adversarial.ts";
import type { CommitPrFallbackCause } from "./workflow-state-events-commitpr.ts";
import type { WorktreeLeftoverHandledEvent } from "./workflow-state-events-leftover.ts";
import type { MemoryEventFragment } from "./workflow-state-events-memory.ts";
import type { WorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import type { SafetyNetCommitEvent } from "./workflow-state-events-safety-net.ts";
import type { WideningScanEvent } from "./workflow-state-events-widening.ts";
// #539 — the commit-pr fallback-cause vocabulary (M1) lives in the
// sibling events-memory fragment module: single definition.
export type { CommitPrFallbackCause } from "./workflow-state-events-commitpr.ts";
/**
 * Linear step identifiers the driver walks. This union IS the definition
 * of the cycle — #393 deleted the prose flow that used to be its source.
 * Add a step here and the discriminator carries through every event type
 * that names a step. Removing a step is a breaking change → schema bump.
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
 * Event log — append-only, typed. The log is the audit trail; pipelineState
 * is the derived snapshot. Adding a new event type is additive (older readers
 * will not recognise it but won't crash). Field naming: `*At` for timestamps,
 * `ms` for durations, `<role>` (lower-case) for subagent roles.
 */
export type WorkEvent =
  | {
      kind: "step-started";
      step: WorkStep;
      at: number;
      note?: string;
      /**
       * #657 — the 1-based run count of this step within the cycle (re-entries
       * of adversarial / lens-review / ci). Additive: renders as "(round N)"
       * only when present and > 1.
       */
      round?: number;
    }
  | AdversarialEventFragment
  | {
      kind: "dispatch-started";
      step: WorkStep;
      role: string;
      jobId: string;
      label: string;
      at: number;
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
      /** #543 — the F1 streak evidence at a loop kill (tool + count);
       * persisted on `pipelineState.capEvidence` so `explainCap` renders WHAT looped. */
      loopEvidence?: { tool: string; count: number };
      /** #543 — the F6 budget + used tokens at a token-budget kill; same purpose as loopEvidence. */
      tokenBudget?: { budget: number; used: number };
      /** #534 — tokens flushed before the process-level failure. */
      usage?: DispatchUsage;
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
      /**
       * #741 — the end-of-develop converge gate's one-shot corrective
       * developer dispatch completed (the first absent set was reported to a
       * re-dispatch). The follow-up gate re-ran; whether it passed is visible
       * on the next event (cap-hit develop-incomplete-deliverables or step
       * completion).
       */
      kind: "converge-redispatch";
      step: "develop";
      at: number;
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
        // #669 — develop-time consolidation hit a real file-level conflict:
        // two workstreams edited the same lines. Distinct from
        // verify-failed:develop — the work may be individually fine; the
        // decomposition is incoherent and needs re-planning, not a retry.
        | "consolidated-verify-conflict"
        // #728 — consolidation dropped files: the branch's committed
        // name-set (baseSha..HEAD) is missing paths that ARE present in a
        // workstream's committed diff (cumulative baseSha..worktree-HEAD).
        // The #723 incident: the HEAD-only cherry-pick staged 1 of 7 files
        // and every downstream gate then verified the truncated tree as if
        // it were the complete work. Distinct from cherry-pick conflict
        // (the pick succeeded — it just picked too little) and from
        // verify-failed:develop (the code was never defective; the diff was
        // never assembled). The dropped paths live in capEvidence/evidence
        // from the cherry-pick seam's `droppedPaths` diagnostic.
        | "consolidation-incomplete"
        // #741 — the end-of-develop converge gate (work-driver-converge.ts):
        // a plan deliverable whose declared paths are absent from the diff
        // even AFTER the one-shot corrective re-dispatch. Distinct from
        // verify-failed:develop — the code builds (the verify gate passed);
        // the diff is INCOMPLETE. The missing deliverables ride in `evidence`
        // + pipelineState.convergeEvidence.
        | "develop-incomplete-deliverables"
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
        // #280 §B — round-1 repeat-finding seam detection. Same finding
        // shape across ≥3 files → step-back (SDD spec-gap analysis).
        | "repeat-finding-seam"
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
       * #657 — on `cap: "intent-park"` the machine-readable park reason
       * (underspecified / contradicted-by-code / already-implemented /
       * too-large / premise-unsound), carried on the event so the renderers
       * can show `intent-park (contradicted-by-code)` without re-deriving it
       * from `pipelineState.normalisedSpec`. Additive: the schema validator
       * ignores extra fields.
       */
      parkReason?: string;
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
      /** #654 — empty-diff re-dispatch marker (see runLensFix). */
      kind: "lens-fix-empty-resend";
      at: number;
      jobId: string;
      round: number;
      /** The worktree the driver inspected and found clean. */
      worktree: string;
      /** The git evidence that established the no-diff classification. */
      evidence: string;
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
      /** Path to the handoff markdown body (PR5; back-compat with PR4 events). */
      handoffBodyPath?: string;
      /** #674 — true when the driver consolidated the work onto the branch before rendering. */
      consolidated?: boolean;
      /** #674 — the feature branch the work was consolidated onto (success only). */
      consolidatedBranch?: string;
      /** #674 — workstream ids whose committed work landed on the branch. */
      consolidatedWorkstreams?: string[];
      /** #674 — why consolidation degraded to the per-worktree fallback. */
      consolidationReason?: string;
    }
  | {
      kind: "handoff-consolidated";
      at: number;
      /** #674 — the feature branch the work was consolidated onto. */
      branchName: string;
      workstreams: string[];
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
      /** Issue #279 — verify-full tier status: driver-side, ci step. */
      kind: "verify-full-status";
      at: number;
      status: "success" | "failure" | "skipped";
      /** Time spent executing the full suite (ms). Undefined when skipped. */
      ms?: number;
      /** Tail of the command output for the handoff/comment body. */
      evidenceTail?: string;
    }
  // Fragment events (AGENTS.md §12 module-size hygiene) — the union stays
  // exhaustive: nextStep() and the schema validator see the same closed type.
  | WideningScanEvent
  | MemoryEventFragment
  | WorktreeProvisionedEvent
  | SafetyNetCommitEvent
  | WorktreeLeftoverHandledEvent;
/** Discriminator union of event kinds — useful for callers that switch on it. */
export type WorkEventKind = WorkEvent["kind"];
