/**
 * /work workflow state — the cap-hit `cap` literal union (#861-size split).
 *
 * Moved VERBATIM from workflow-state-events.ts (the `cap:` field of the
 * `cap-hit` event) so that file stays under the 500-line gate; the event
 * uses `cap: WorkCapLiteral` instead of inlining the union. The text is
 * byte-identical to the original (the move is the whole change).
 */
import type { WorkStep } from "./workflow-state-events.ts";

/**
 * #849 — the `cap` literal union for the `cap-hit` event.
 */
export type WorkCapLiteral =
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
  | "integration-worktree-violation"
  // #669 — develop-time consolidation hit a real file-level conflict:
  // two workstreams edited the same lines. Distinct from
  // verify-failed:develop — the work may be individually fine; the
  // decomposition is incoherent and needs re-planning, not a retry.
  | "consolidated-verify-conflict"
  // #777 — develop-time consolidated verify failed on a SPECIFIC
  // assertion that neither workstream tripped alone (per-workstream
  // pass, combined fail). Distinct from consolidated-verify-conflict
  // (cherry-pick conflict) and verify-failed:develop (generic).
  // The failure message carries the classification label, the
  // specific assertion, and both workstream ids.
  | "consolidated-verify-consolidation-created"
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
  // #844 — the ops-fallback branch path's post-dispatch merge-base check
  // failed: the branch ops created does not sit on the driver-resolved
  // baseSha (ops built off a stale local ref — the #830 shape).
  | "ops-merge-base-mismatch"
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
  // #754 — the plan step's own bound expired on the primary plan
  // dispatch; distinct from `step-failed:plan` and `developer-timeout`.
  | "plan-timeout"
  // #280 §B — round-1 repeat-finding seam detection. Same finding
  // shape across ≥3 files → step-back (SDD spec-gap analysis).
  | "repeat-finding-seam"
  | `verify-failed:${WorkStep}`
  | `step-failed:${WorkStep}`
  // #844 — a local branch of the resolved name is ahead of the
  // freshly-fetched origin/<mainline>; the ahead count is in the
  // cap suffix, the branch name is in `evidence`.
  | `branch-ahead:${string}`
  // #753 — deferred worktree creation failed (dirty-leftover park).
  // Own literal so explainCap can give it a tailored sentence and the
  // handoff does NOT terminalize it as `aborted`.
  | "deferred-creation:develop"
  // #849 — the develop fence's terminal cap after a recovery round (second
  // violation, a violator↔owner cycle before any re-dispatch, or a git
  // failure discarding a violator's commit). A deliberate park terminalized
  // as a handoff; the evidence names both attempts (the first via the
  // fence-recovery-started event's discarded SHA, the second via the
  // re-run's fence record) or the failing git command.
  | "fence-violation:develop"
  // #746 task-b — branch-step early dirty-root block: a stray untracked/
  // modified file at repoRoot BEFORE any develop dispatch. Deliberate park.
  | "repo-root-residue"
  // #973 — the lens review returned the no-review outcome (decision 4: an
  // empty delta, nothing changed since the last recorded lens run). The
  // driver treats it as a STOP (a no-review is NOT an approval — never a
  // fake lens-approved event the nextStep router would trust). Defensively
  // reached: runLens supplies its own diff, so this cap can only fire
  // through a `since`-shaped call (e.g. an injected lensReviewFn).
  | "no-review-outcome";
