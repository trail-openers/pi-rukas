/**
 * workflow-state-validate-caps — the fixed-literal cap vocabulary, moved
 * verbatim from workflow-state-validate.ts for the 500-line cap (#861).
 * The validator (validateDiscriminants) reads this tuple; the export
 * keeps the single-source-of-truth invariant.
 */

/**
 * #543 — the FIXED-LITERAL caps (F1 loop / F6 token-budget included). A
 * cap-hit's `cap` must be one of these, or a `verify-failed:` / `step-failed:`
 * template value — nothing else. `validateDiscriminants` REJECTS a fabricated
 * `loop-detected:<anything>` / `token-budget:<anything>` suffix (the #533
 * "extend the union, don't smuggle a field" rule applied to cap strings).
 */
export const CAP_HIT_FIXED_LITERALS: readonly unknown[] = [
  "adversarial-loop",
  "round-cap",
  "wall-clock",
  "review-incomplete",
  "ci-retry",
  "developer-timeout",
  "explore-already-complete",
  "explore-needs-clarification",
  "explore-bodies-empty",
  "step-back-revise-spec",
  "commit-pr-incomplete-consolidation",
  "lens-fix-not-integrated",
  "integration-verify-failed",
  // #861 — the commit-pr fallback's post-dispatch branch-holder audit
  // (the #841 shape); the offending holder path rides in the cap's evidence.
  "integration-worktree-violation",
  // #669 — develop-time consolidation hit a file-level conflict (two
  // workstreams edited the same lines). A decomposition error, distinct
  // from the generic verify-failed:develop template.
  "consolidated-verify-conflict",
  // #777 — develop-time consolidated verify failed on a specific assertion
  // that neither workstream tripped alone (per-workstream pass, combined
  // fail). Distinct from the conflict cap and the verify-failed:develop
  // template. The failure message carries the classification + assertion.
  "consolidated-verify-consolidation-created",
  // #728 — consolidation dropped files (strict-subset stage, the #723
  // incident shape): distinct from the conflict cap and the verify-failed:
  // develop template. The dropped paths ride in the event's evidence.
  "consolidation-incomplete",
  // #741 — the converge gate's distinct cap: a plan deliverable is absent
  // from the end-of-develop diff even after the one-shot corrective
  // re-dispatch. Distinct from the verify-failed:develop template (the
  // code builds; the diff is incomplete).
  "develop-incomplete-deliverables",
  // #753 — a DEPENDENT workstream's deferred worktree creation was refused
  // by a dirty same-issue leftover. A deliberate park terminalized as a
  // handoff (not `step-failed:` — that prefix would read as a mid-flight
  // crash), so the validator must know the literal or every re-entry of a
  // live parked cycle would halt on "unrecognised value" and tell the
  // operator to rm the very record this cap exists to create.
  "deferred-creation:develop",
  // #746 task-b — the branch step's early dirty-root block: a stray
  // untracked/modified file at repoRoot (outside the driver-managed
  // exclusion set) present BEFORE any develop dispatch. A deliberate park
  // terminalized as a handoff (not `step-failed:` — that prefix would read
  // as a mid-flight crash); the paths are preserved, never mutated.
  "repo-root-residue",
  "intent-park",
  "awaiting-human-merge",
  "lens-diff-unreadable",
  "existing-pr-detected",
  // #844 — the ops-fallback branch path's post-dispatch merge-base check
  // failed: the branch ops created does not sit on the driver-fetched base.
  "ops-merge-base-mismatch",
  "adversarial-infra-failure",
  "loop-detected",
  "token-budget",
];
