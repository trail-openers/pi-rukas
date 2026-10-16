/**
 * workflow-state-event-kinds — the `eventLog[].kind` membership tuple.
 *
 * Split out of `workflow-state-validate.ts` for the AGENTS.md §12 500-line
 * gate; the validator imports it back and the tuple's meaning is unchanged.
 *
 * A literal `as const` tuple, narrower than the pre-#986
 * `readonly WorkEventKind[]`: the wider type proved each entry was a valid
 * kind but not that the list was COMPLETE — the silent-resume-refusal bug
 * #986 fixed (four driver-emitted kinds were omitted, so every cycle that
 * crashed after its branch step refused to resume). Consumed at runtime by
 * `validateDiscriminants` for `eventLog[].kind` membership.
 *
 * Value-level consumers that need the wider `readonly unknown[]` shape (e.g.
 * for `.includes`) should cast: `(KNOWN_EVENT_KINDS as readonly unknown[])` —
 * the literal tuple type is intentionally not widened here.
 *
 * Adding a kind means three edits, and two of them are gates:
 *  1. the `WorkEvent` union in `workflow-state-events.ts` (a fragment module
 *     for the domain, following the sibling `workflow-state-events-*.ts`
 *     pattern),
 *  2. this tuple — absent from it, a running state file carrying the new kind
 *     fails `validateDiscriminants` and the cycle refuses to resume,
 *  3. a full, well-typed fixture in
 *     `smoke-tests/test-work-event-kinds-completeness.ts`, whose reverse
 *     direction asserts this tuple has exactly the fixture set's kinds.
 *
 * The compile-time half of the guard lives with the validator
 * (`workflow-state-validate.ts`): `[MissingEventKinds] extends [never]`
 * makes `tsc` fail, naming the kind, if the union gains a member this tuple
 * omits. It is declared there rather than here because tsc checks `src/` only —
 * smoke tests are not type-checked, which is why the runtime half exists.
 */
export const KNOWN_EVENT_KINDS = [
  "step-started",
  "dispatch-started",
  "dispatch-completed",
  "dispatch-failed-provider",
  "dispatch-failed",
  "adversarial-approved",
  "adversarial-rejected",
  "adversarial-round",
  "adversarial-workstream-outcome",
  "adversarial-skipped-empty-diff",
  // #1114 — the adversarial→develop routing record and the fix pass's applied marker.
  "adversarial-fix-requested",
  "adversarial-fix-applied",
  "lens-approved",
  "lens-issues-found",
  "lens-skipped-empty-diff",
  // #1094 — explore re-dispatched once after a completed reply had no `## Spec`.
  "explore-retried",
  // #654 — the empty-diff re-dispatch marker; no step field (it names the
  // review round + worktree instead), so the validator's step check skips it.
  "lens-fix-empty-resend",
  "cap-hit",
  "plumb-report",
  "step-back-triggered",
  "step-back-completed",
  "handoff-emitted",
  "ci-status",
  "merged",
  "branches-fanned-out",
  "branch-completed",
  "branches-converged",
  "verify-full-status",
  // #782 — the consolidated-verify gate's single-retry recovery marker.
  "verify-flake-recovered",
  // #558 — the branch step's worktree provisioning record (the driver writes
  // it when it symlinks dependencies into a fresh worktree). Absent from the
  // tuple, a cycle that crashed after provisioning refused to resume.
  "worktree-provisioned",
  "widening-scan",
  "memory-write",
  "memory-inject",
  // #741 — the converge gate's one-shot corrective dispatch marker.
  "converge-redispatch",
  // #625 — the develop step's safety-net commit record (the driver writes it
  // when it commits a workstream's in-scope work on a cap/failure exit).
  "safety-net-commit",
  // #674 — the handoff consolidation record (the driver writes it when it
  // consolidates parallel workstreams into a single handoff).
  "handoff-consolidated",
  // #735 — the branch step's leftover-worktree handling record (the driver
  // writes it when it adopts or removes a stale .worktrees/ entry).
  "worktree-leftover-handled",
  // #849 — the develop fence recovery marker (discarded SHA + owners).
  "fence-recovery-started",
  // #844 — the branch step's stale-local-branch reset record (old + new tip).
  // Absent from the tuple, EVERY restarted cycle that resets a stale branch
  // halts on its own re-entry (the fix manufactures the corruption it
  // exists to prevent).
  "branch-reset",
  // #799 — the slow-run crossing record (one per threshold crossing of a
  // driver dispatch, written between dispatch-started and
  // dispatch-completed). A state file written by a newer driver must
  // resume on an older one's reader without halting on an unknown kind.
  "dispatch-slow",
  // S4a (#1162) — the interrupt record (SIGTERM / SIGINT via markInterrupted).
  "interrupted",
  // The session-shutdown record. Absent from the tuple, the one cycle this
  // event promises is resumable would refuse to resume.
  "cycle-interrupted",
  // A residual-findings disclosure that did not reach the PR (and whether the
  // issue got it instead).
  "lens-residuals-post-failed",
  // #1391 — the record of the retry save: a lost attempt's dirt was preserved
  // (commit + durable ref + scratch patch) before the tree was cleared for the
  // re-dispatch. Absent from the tuple, a cycle that retried a severed lens-fix
  // refused to resume — the #986 shape, one dispatch later than the bug.
  "lens-fix-attempt-preserved",
] as const;
