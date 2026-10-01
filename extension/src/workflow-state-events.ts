/**
 * /work workflow state — event-log types. `WorkStep` (linear step identifiers)
 * and `WorkEvent` (append-only, typed event-log entries). Split from
 * `workflow-state.ts` for module-size hygiene (AGENTS.md §12).
 */
import type { RoleName } from "./roles.ts";
import type { DispatchUsage } from "./types.ts";
import type { AdversarialEventFragment } from "./workflow-state-events-adversarial.ts";
import type { BranchResetEvent } from "./workflow-state-events-branch-reset.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import type { CommitPrFallbackCause } from "./workflow-state-events-commitpr.ts";
import type { DeferredCreationEventFragment } from "./workflow-state-events-deferred.ts";
import type { FenceRecoveryStartedEvent } from "./workflow-state-events-fence.ts";
import type {
  HandoffConsolidatedEvent,
  HandoffEmittedEvent,
  LensSkippedEmptyDiffEvent,
} from "./workflow-state-events-handoff.ts";
import type { WorktreeLeftoverHandledEvent } from "./workflow-state-events-leftover.ts";
import type { MemoryEventFragment } from "./workflow-state-events-memory.ts";
import type { WorktreeProvisionedEvent } from "./workflow-state-events-provision.ts";
import type { SafetyNetCommitEvent } from "./workflow-state-events-safety-net.ts";
import type { DispatchSlowEvent } from "./workflow-state-events-slow.ts";
import type {
  VerifyFlakeRecoveredEvent,
  VerifyFullStatusEvent,
} from "./workflow-state-events-verify-flake.ts";
import type { WideningScanEvent } from "./workflow-state-events-widening.ts";
// #539 — single definition in the sibling fragment module.
export type { CommitPrFallbackCause } from "./workflow-state-events-commitpr.ts";
// #775 prep — handoff event members re-exported from the sibling fragment.
export type {
  HandoffConsolidatedEvent,
  HandoffEmittedEvent,
  LensSkippedEmptyDiffEvent,
} from "./workflow-state-events-handoff.ts";
export type { DispatchSlowEvent };
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
      /** Structured self-kill cause (#296; #543 adds loop/token-budget; #754 adds plan-timeout; #951 adds tool-inactivity). */
      killCause?:
        | "timeout"
        | "inactivity"
        | "abort"
        | "loop"
        | "token-budget"
        | "plan-timeout"
        | "tool-inactivity";
      /** #543 — the F1 streak evidence at a loop kill (tool + count);
       * persisted on `pipelineState.capEvidence` so `explainCap` renders WHAT looped.
       * #772 — `kind` names which counter fired ("streak" vs the success-keyed
       * "success") so the handoff rendering can tell the #753 shape apart. */
      loopEvidence?: { tool: string; count: number; kind?: "streak" | "success" };
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
  | LensSkippedEmptyDiffEvent
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
       * #797 — the ref the cycle's integration started from at repoRoot
       * (recorded before the checkout). Present on `lens-fix-not-integrated`
       * caps: the post-condition for the handoff's recovery steps is that
       * repoRoot is on this ref again. Absent on pre-#797 state files and
       * on caps whose recovery does not depend on the checkout.
       */
      restoredToRef?: string;
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
      cap: WorkCapLiteral;
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
  | HandoffEmittedEvent
  | HandoffConsolidatedEvent
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
      /** #753 — timing record for a `dependsOn` workstream: the epoch-ms at which the dependency it waited on completed. */
      depCompletedAt?: number;
      /** #753 — the underlying failure detail for a DEFERRED worktree-creation failure. Absent on every other branch-completed. */
      deferredCreation?: DeferredCreationEventFragment;
    }
  | {
      /**
       * Fanned-out step's `Promise.all` resolved (PR3). Carries the
       * per-branch verdicts so the driver's next-step decision can
       * route on the aggregate (e.g., "any branch failed" → halt).
       */
      kind: "branches-converged";
      step: WorkStep;
      verdicts: Array<{ id: string; ok: boolean; reason?: string }>;
      at: number;
    }
  | VerifyFullStatusEvent
  | VerifyFlakeRecoveredEvent
  | WideningScanEvent
  | MemoryEventFragment
  | WorktreeProvisionedEvent
  | SafetyNetCommitEvent
  | BranchResetEvent
  | WorktreeLeftoverHandledEvent
  | DispatchSlowEvent
  | FenceRecoveryStartedEvent;
/** Discriminator union of event kinds — useful for callers that switch on it. */
export type WorkEventKind = WorkEvent["kind"];
