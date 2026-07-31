/**
 * /work workflow state — event-log types.
 *
 * `WorkStep` (the linear step identifiers walked from `pi-prompts/work.md`)
 * and `WorkEvent` (the append-only, typed event-log entries the driver
 * writes on every state transition). Split out of `workflow-state.ts` for
 * module-size hygiene (AGENTS.md §12) — re-exported from there so external
 * consumers' import paths are unaffected. See `workflow-state.ts` for the
 * full schema doc (versioning, resumability, GitHub-is-the-bus).
 */

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
      /** Structured kill-cause from pi-ensemble self-kill (timeout/inactivity/abort). */
      killCause?: "timeout" | "inactivity" | "abort";
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
