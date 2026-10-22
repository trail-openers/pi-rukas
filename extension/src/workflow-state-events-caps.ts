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
  | "lens-review-timeout"
  // A lens gave no verdict (failed, was stopped by a cap or its run bound, or
  // returned silence), so the six-pass review is incomplete. The evidence
  // names each such lane (#1564).
  // Distinct from the round cap: nothing capped, the review could not be
  // completed. This used to be reported as "adversarial-loop".
  | "review-incomplete"
  | "ci-retry"
  | "spawn-backstop"
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
  // #1439 — the forge refused the push (GitHub push protection / GH013 / repository
  // rules / a non-fast-forward). The consolidated commit is local and intact; nothing
  // an ops child does locally can lift a refusal the REMOTE issued, so this parks
  // instead of falling back. A `<step>` template because the refusal is a per-step
  // fact (commit-pr today; a lens-fix push goes through the same classifier), and the
  // cause classifier reads `verifyEvidence.origin === "push-refused"` rather than
  // re-matching the prose.
  | `push-refused:${WorkStep}`
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
  // #1398 — the review was about to run again after the PR had been marked
  // ready, and putting the PR back to a draft failed (or the cycle's
  // `pr ready` attempts are spent). Continuing would run a review on a PR
  // anyone could merge while it is under review — the exact window #1292
  // closes — so the cycle parks with the reason rather than reviewing a
  // mergeable PR.
  | "draft-rearm-failed"
  | "existing-pr-detected"
  // #1468 — `--continue-pr` could not continue the issue's open PR: the
  // lookup was not one PR, the PR is a fork or its head is unsafe, the head
  // moved under the run, or the merge of the mainline was left unfinished.
  | "continue-pr-ambiguous"
  | "continue-pr-fork"
  | "continue-pr-head-moved"
  | "continue-pr-not-found"
  | "continue-pr-unresolved"
  | "continue-pr-unsafe-head"
  // #844 — the ops-fallback branch path's post-dispatch merge-base check
  // failed: the branch ops created does not sit on the driver-resolved
  // baseSha (ops built off a stale local ref — the #830 shape).
  | "ops-merge-base-mismatch"
  // #486 — infra-failure: adversarial loop failed on infra every attempt.
  | "adversarial-infra-failure"
  // #1243 — the step parked because the PROVIDER was down, not because the
  // work failed. A transport severance / endpoint timeout / short-burst 429
  // that survived every retry (and, for the adversarial gate, the fan-out's
  // own ladder) parks here instead of `step-failed:<step>`, for two reasons.
  // (1) The caller can act: orchard runs pi-rukas headless and re-queues a
  // provider park itself when the endpoint answers again — it has nothing to
  // look at, because nothing about the code was judged. (2) It is NOT a
  // mid-flight-halt shape: `runHandoff` keys `status: "aborted"` off the
  // `step-failed:` prefix, and an outage that ends at a step boundary with
  // committed work on the branch is a handoff a person (or the queue) resumes,
  // not a crash to post-mortem. A quota window or a spend cap does NOT take
  // this cap — waiting does not clear those, so they stay `step-failed:<step>`
  // and go to a person (see `stepParkedOnProvider`).
  | "provider-unavailable"
  // #571 — sibling cycle holds a path claim; overlap detected at plan
  // time. Two cycles cannot edit the same files in parallel.
  | "cross-group-conflict"
  // #1454 r3 — the claims lock REFUSED a registration: the lockfile cannot be
  // created (read-only `.pi/work-state`, ENOSPC) or a sibling held it past the
  // wait window. `registerClaim` fails closed there — writing unlocked is the
  // lost update the lock exists to remove — and the plan step converts that
  // refusal into this cap rather than letting it escape as
  // `driver-crash:plan`, which reports "unhandled error in the step handler"
  // when the filesystem is what is broken. The refusal text rides on evidence.
  | "claims-lock-unavailable"
  // #1101 — the QUEUE raised these, not a cycle: a group waited on a sibling
  // past its bound and never dispatched. `dependency-timeout` is the ordering
  // edge that never cleared; `dependency-parked` is its sibling, the dependency
  // settling on something other than `merged` (waiting cannot fix that, so it is
  // a park, not a timeout). `dependency-cycle` is the pre-pass verdict for a
  // group inside an ordering loop, and `queue-stranded` the group the scheduler
  // was holding in the wait list when a halt released every worker. None of the
  // four has a state file, a worktree or a diff behind it, so each routes to
  // `isQueueLevelPark` for the never-dispatched report shape. `cross-group-conflict`
  // above is reused for a claim wait that capped out — same condition as the
  // plan-time check, seen earlier and more cheaply. See work-queue-cap.ts.
  | "dependency-timeout"
  | "dependency-parked"
  | "dependency-cycle"
  | "queue-stranded"
  // #543 — fixed literals (NOT `'<role>'` template shapes): a per-role
  // suffix would smuggle a cap the #533 canary doesn't know. Which role's
  // child was killed is carried in the new `role` field + capEvidence.
  | "loop-detected"
  | "token-budget"
  // #754 — the plan step's own bound expired on the primary plan
  // dispatch; distinct from `step-failed:plan` and `spawn-backstop`.
  | "plan-timeout"
  // #819 — the plan-to-spec gate refused the plan: no workstream declares any
  // path of a deliverable the spec requires, or the reply carried more than
  // one `## Workstreams` section. A DELIBERATE park terminalized as a handoff
  // (not `step-failed:plan`, which would read as a dispatch that failed and
  // terminalize as `aborted`, hiding that the plan was judged and found to be
  // about the wrong work). It fires BEFORE the branch step, so nothing was
  // written: the #818 shape — a corrective plan about a different problem,
  // four developers and 45 minutes spent building it — is what this stops.
  | "plan-spec-mismatch"
  // #1652 — the plan dispatch made report_workstream calls whose tool results
  // the replay did not carry, so they cannot be told from refusals. A DELIBERATE
  // park before the branch step (the plan is unjudged, not wrong): the operator
  // reads the channel failure, not a plan-spec verdict.
  | "workstream-results-unreadable"
  // #280 §B — round-1 repeat-finding seam detection. Same finding
  // shape across ≥3 files → step-back (SDD spec-gap analysis).
  | "repeat-finding-seam"
  // #1743 — the pre-loop guard (work-driver-state-guards.ts) refused a start
  // because two earlier cycles already parked this issue for the same reason,
  // against the same issue text. Nothing was dispatched and no state file was
  // written: the cap exists so the refusal has a name on every surface.
  | "repeat-park"
  | `verify-failed:${WorkStep}`
  // #1324 — the step's verify run was killed at its bound and reached no
  // verdict: distinct from verify-failed:<step>, which judged the code.
  | `verify-timeout:${WorkStep}`
  // #1560 — a child outlived its per-child run bound: steered to wrap up at
  // the bound, ended a grace period later with nothing committed or reported.
  | `child-timeout:${WorkStep}`
  // #1349 — the gate could not run: the system refused to start a process
  // (fork failed / EAGAIN) for every failure that is not a timeout. No
  // verdict on the code, like verify-timeout.
  | `verify-env:${WorkStep}`
  // #1349 — the base-commit probe confirmed the verify command already fails
  // without the change, and the verify command's failures are the only ones.
  | `verify-baseline-red:${WorkStep}`
  // #1349 — the cycle's PR was no longer open when the step started (the
  // commit-pr re-entry refusal, the PR-gone park). Nothing was judged.
  | `pr-not-open:${WorkStep}`
  // #1472 — a person CLOSED the cycle's issue mid-run: nothing judged, no
  // child dispatched. Unlike `pr-not-open`, which reads the PR an agent opened.
  | `issue-closed:${WorkStep}`
  // #1349 — the adversarial fix pass parked on its own checks (scope fence,
  // no-op pass, comment retention, a read that failed closed); the outcome
  // gate rejected nothing.
  | "fix-pass-park"
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
  | "no-review-outcome"
  // #981 — the round-2 lens-fix reposition guard could not establish the
  // correct base for the next round: the fix worktree is dirty, round-1
  // work never landed on the branch, or the worktree holds commits that
  // diverged from the branch tip. The driver halted the fix loop so the
  // stale tree is inspected and repaired, never re-dispatched. The detail
  // (kind + git evidence) rides on the cap's evidence; the backup ref for
  // an unlanded/diverged tree rides on the `restoredToRef` field.
  | "lens-fix-reposition"
  // #1263 — a step handler THREW (an fs failure, a bug, an uncaught exec
  // rejection). Routed through runHandoff so the operator gets a comment +
  // label, not just a silent `aborted` state file. Distinct from the
  // dispatch-failure `step-failed:<step>` (that one is a child that failed;
  // this one is the driver itself crashing). NOT a mid-flight-halt shape,
  // so runHandoff terminalizes it as `handoff`, the same value the
  // dispatch-failure path uses.
  | `driver-crash:${WorkStep}`
  // #1238 — the caller-set whole-cycle deadline (PI_ENSEMBLE_CYCLE_DEADLINE
  // or PI_ENSEMBLE_CYCLE_BUDGET_MS): at a step boundary the deadline was
  // within the handoff grace, so the driver started no new step and parked
  // so the handoff posts before the caller kills the process (the orchard `docker stop` shape: a mid-step kill, no
  // handoff, state left `running`). Emitted at the step boundary only — no
  // mid-step hard kill.
  | "deadline"
  // #1567 item 6 (#1447/#1547) — some useful time was left before the
  // deadline (less the handoff grace) but less than the step needs (15 min
  // for develop / lens-fix, 10 min for a lens round), so the step was not
  // started. The evidence names the step, the time left and the time needed.
  | "deadline:no-fit"
  // #1403 — a develop child's ENGINE DIED mid-pass (`the engine stopped
  // unexpectedly (exit code N)`, no `errorStop`, no `killCause`) and its
  // worktree was left with uncommitted work that its pass never committed.
  // Pre-fix the step reported `step-completed … recovered: false` and the
  // dead pass's fix stayed off the branch entirely (orchard #238: `M scripts/stop.sh`,
  // 56 insertions, reviewed by adversarial round 3 and then dropped).
  //
  // NOT a template and NOT `step-failed:develop`: that prefix terminalizes as
  // `aborted` and reads as "the dispatch failed", which is the shape the
  // router's transient-retry branch owns. This cap says something narrower and
  // different — the child died, and the driver can NAME the paths it left
  // behind — so the cycle parks as a handoff with the leftover list rather
  // than advancing on a tree whose state it does not know.
  | "develop-child-crash"
  // #1768 — a develop child exited 0 and reported itself done, made NO commit
  // of its own ahead of its base, and left its work UNCOMMITTED in the worktree
  // (the orchard cycle-id / cycle-id shape: `safety net
  // committed default (d81ce007)` printed beside the child's own `…
  // test/review_test.sh remain, then the gate. Continuing.`, then `agent done:
  // developer`). The #622 net used to commit that dirt and the net's own commit
  // then satisfied the green rule, so a mid-step quit rode into commit-pr on a
  // `wip: driver safety-net commit`.
  //
  // NOT `develop-child-crash` (that child's engine DIED; this one exited 0 and
  // said so) and NOT `develop-incomplete-deliverables` (that diff builds and is
  // judged by path presence after the verify gate passed; this step never
  // earned a verify). Emitted only when the ONE corrective round that resumed
  // from the child's own uncommitted work did not finish either — the paths
  // name the unfinished work in `evidence`.
  | "develop-incomplete-uncommitted"
  // #1396 (round 3) — the branch step's same-issue residue pass could not read
  // `git worktree list` (the listing is bounded since #1396, so a hang is a
  // rejection). The pass cannot tell whether a same-issue tree holds work, and
  // "could not look" must not degrade to "nothing to clean" — the branch step
  // parks with the git error as evidence rather than removing nothing and
  // reporting a clean pass.
  | "worktree-listing-unreadable";

/**
 * #1652 — the plan step's verdict behind a `plan-spec-mismatch` park, carried as
 * data on the cap-hit so the explainer and the recovery branch on it, never on
 * the evidence text.
 */
export type PlanVerdict = "no-calls" | "all-refused" | "uncovered-deliverables";

/** The runtime list of {@link PlanVerdict}, for validating a persisted value. */
export const PLAN_VERDICTS: readonly PlanVerdict[] = [
  "no-calls",
  "all-refused",
  "uncovered-deliverables",
];
