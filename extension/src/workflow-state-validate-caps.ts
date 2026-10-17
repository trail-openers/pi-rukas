/**
 * workflow-state-validate-caps — the fixed-literal cap vocabulary, moved
 * verbatim from workflow-state-validate.ts for the 500-line cap (#861).
 * The validator (validateDiscriminants) reads this tuple; the export
 * keeps the single-source-of-truth invariant.
 *
 * #1338 — the tuple is checked against the driver's `WorkCapLiteral` union
 * at compile time in both directions (the headless/caps.ts pattern): a cap
 * the driver can emit but the validator does not list fails `tsc`, so a
 * parked cycle's state file can no longer be rejected on re-entry for a cap
 * its own driver wrote.
 */

import { CAP_TEMPLATES, type FixedCap } from "./headless/caps.ts";
import type { WorkStep } from "./workflow-state-events.ts";

/**
 * #543 — the FIXED-LITERAL caps (F1 loop / F6 token-budget included). A
 * cap-hit's `cap` must be one of these, or a `verify-failed:` / `step-failed:`
 * template value — nothing else. `validateDiscriminants` REJECTS a fabricated
 * `loop-detected:<anything>` / `token-budget:<anything>` suffix (the #533
 * "extend the union, don't smuggle a field" rule applied to cap strings).
 */
export const CAP_HIT_FIXED_LITERALS = [
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
  // #1403 — a develop child's engine died mid-pass and left uncommitted work
  // in its worktree. A deliberate park terminalized as a handoff (NOT
  // `step-failed:develop`, which would read as a generic dispatch failure and
  // terminalize as `aborted`, hiding that recoverable work is on disk).
  "develop-child-crash",
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
  // #849 — the develop fence's terminal cap after a recovery round (second
  // violation, or a violator↔owner cycle before any re-dispatch). A
  // deliberate park terminalized as a handoff; the evidence names both
  // attempts.
  "fence-violation:develop",
  // #746 task-b — the branch step's early dirty-root block: a stray
  // untracked/modified file at repoRoot (outside the driver-managed
  // exclusion set) present BEFORE any develop dispatch. A deliberate park
  // terminalized as a handoff (not `step-failed:` — that prefix would read
  // as a mid-flight crash); the paths are preserved, never mutated.
  "repo-root-residue",
  // #1396 round 3 — the residue pass could not read the worktree listing (a
  // bounded `git worktree list` that hung). A deliberate park terminalized as
  // a handoff: the alternative is the pass reporting "nothing to clean" over a
  // dirty same-issue tree it never saw.
  "worktree-listing-unreadable",
  "intent-park",
  "awaiting-human-merge",
  "lens-diff-unreadable",
  // #1398 — the review was re-running after the PR had been marked ready and
  // the driver could not put the PR back to a draft. Deliberate park.
  "draft-rearm-failed",
  "existing-pr-detected",
  // #844 — the ops-fallback branch path's post-dispatch merge-base check
  // failed: the branch ops created does not sit on the driver-fetched base.
  "ops-merge-base-mismatch",
  "adversarial-infra-failure",
  "loop-detected",
  "token-budget",
  // #973 — the lens review produced no review outcome (all lens dispatches
  // failed) without a delta to review: a deliberate park terminalized as a
  // handoff, emitted by work-driver-lens.ts.
  "no-review-outcome",
  // #981 — the round-2 lens-fix reposition guard halted: the worktree is
  // dirty, round-1 work is unlanded, or the tree diverged from the branch
  // tip. A deliberate park terminalized as a handoff.
  "lens-fix-reposition",
  // #1238 — the caller-set whole-cycle deadline parked the cycle at a step
  // boundary (the deadline was within the handoff grace). A deliberate
  // park terminalized as a handoff; the evidence names the deadline, the
  // time remaining, and the step that was not started.
  "deadline",
  // #571 — a sibling cycle holds a path claim that overlaps this plan.
  "cross-group-conflict",
  // #1101 — the queue, not a cycle, raised these: a group waited on a sibling
  // past its bound and never dispatched. `dependency-parked` is the dependency
  // settling non-merged (a wait cannot fix it); `dependency-timeout` is the
  // wait outlasting its bound. Both name a group that wrote nothing, so the
  // handoff must not send the operator to a diff.
  "dependency-parked",
  "dependency-timeout",
  // #754 — the plan step's own bound expired on the primary plan dispatch.
  "plan-timeout",
  // #819 — the plan-to-spec gate refused the plan (declared paths cover no
  // deliverable, or the reply carried several `## Workstreams` blocks). A
  // deliberate park terminalized as a handoff, fired before the branch step:
  // the validator must know the literal or a re-entry of a live parked cycle
  // would halt on "unrecognised value".
  "plan-spec-mismatch",
  // #280 §B — the same finding shape across ≥3 files routes to step-back.
  "repeat-finding-seam",
  // #1349 — the adversarial fix pass parked on its own checks.
  "fix-pass-park",
] as const satisfies readonly FixedCap[];

// Compile-time exhaustiveness: a fixed cap in WorkCapLiteral but not listed
// above names itself here (#1338). `satisfies` above rejects the reverse.
type MissingCaps = Exclude<FixedCap, (typeof CAP_HIT_FIXED_LITERALS)[number]>;
const _validatorCapsExhaustive: [MissingCaps] extends [never] ? true : MissingCaps = true;
void _validatorCapsExhaustive;

/** `<family>:` template caps (`verify-failed:develop`, `branch-ahead:3`). */
const CAP_TEMPLATE_RE = new RegExp(`^(${Object.keys(CAP_TEMPLATES).join("|")}):`);

/**
 * #543 — a cap-hit's `cap` is a known fixed literal or a template value,
 * nothing else. A fabricated `loop-detected:<anything>` suffix is rejected:
 * those caps are fixed literals, and a suffix would smuggle a role the
 * canary does not know (the role travels in the separate `role` field).
 */
export function isKnownCap(cap: string): boolean {
  return (CAP_HIT_FIXED_LITERALS as readonly string[]).includes(cap) || CAP_TEMPLATE_RE.test(cap);
}

// --- #1362: moved from workflow-state-validate.ts for the 500-line gate (the same
// #861 seam that brought the cap vocabulary here). Values verbatim; the validator
// imports them.

/** `pipelineState.status` vocabulary. */
export const KNOWN_STATUSES: readonly unknown[] = [
  "running",
  "merged",
  "handoff",
  "aborted",
  // S4a (#1162) — resumable; re-entry treats it as running.
  "interrupted",
];

/**
 * #540 — `pipelineState.incompleteConsolidation.verdicts[].status`
 * vocabulary. Legacy PR14 entries carry no `status` field at all (they
 * identify themselves by `paths`); the validator tolerates the absent-
 * status + `paths` shape and refuses everything else it does not
 * recognize — the same "extend the union, don't smuggle a field" rule
 * this module applies to event kinds and steps.
 *
 * #778 — `moved` joins the vocabulary: a covered workstream whose declared
 * path was renamed during develop/consolidation, with the move recorded in
 * `movedPaths` (the same "extend the union" move that added `unverifiable`
 * for #540).
 */
export const KNOWN_CONSOLIDATION_STATUSES: readonly unknown[] = [
  "complete",
  "uncovered",
  "moved",
  "unverifiable",
];

/** `cap-hit.nextStep` vocabulary. */
export const CAP_HIT_NEXT_STEPS: readonly unknown[] = ["handoff", "step-back", "ci"];

/** `pipelineState.capEvidence.kind` vocabulary (#543). */
export const CAP_EVIDENCE_KINDS: readonly unknown[] = ["loop", "token-budget"];

/** #543 F5 — `pipelineState.capedPartialState.tree` vocabulary. */
export const KNOWN_CAPPED_PARTIAL_TREES: readonly unknown[] = [
  "committed",
  "dirty-uncommitted",
  "clean",
];

/** #543 F5 — `pipelineState.capedPartialState.role` vocabulary. The
 * dispatch-cap kill is attributed to a role the driver can name, so a
 * fabricated `cap-hit.role` is rejected with the same rule. */
export const KNOWN_CAPPED_PARTIAL_ROLES: readonly unknown[] = [
  "project-manager",
  "developer",
  "ops",
  "explore",
  "adversarial-developer",
  "code-review-specialist",
];
