/**
 * work-driver-cause-table — the closed cause-class vocabulary (#1675) and the
 * one table that maps every published cap to a class.
 *
 * The four classes answer one question for a person reading a park: what kind
 * of thing has to change before this cycle can succeed?
 *
 *   issue       — the issue (or the PR it names) asks for something only a
 *                 person can decide: an underspecified or already-done spec, a
 *                 protected path that needs an operator grant, a stale PR.
 *   change      — the cycle's own code still fails its gates: a verify check
 *                 names a failing line, a review blocks, a fence was crossed.
 *   environment — the world around the cycle failed: a provider outage or
 *                 quota, a timeout, a host that refused a process, a permission
 *                 or guard denial, a base branch that was already red.
 *   pi-rukas    — a driver defect or an internal inconsistency. The user cannot
 *                 act on it; the handoff says so.
 *
 * The class is a pure function of the cap, the failure kind and structured
 * evidence (work-driver-cause-class.ts), never of free prose. This module is
 * the only place that decides what a cap means; the typed `Record`s below make
 * a new fixed cap or a new template family a compile error until it is mapped.
 *
 * Type-only imports from headless/ keep this module free of runtime cycles.
 */

import type { CAP_TEMPLATES, FixedCap } from "./headless/caps.ts";
import type { FailureKind } from "./headless/failure.ts";

export const CAUSE_CLASSES = ["issue", "change", "environment", "pi-rukas"] as const;
export type CauseClass = (typeof CAUSE_CLASSES)[number];

/**
 * One cap's entry. `reason` is one plain sentence. `action` is what the user
 * can do (`{issue}` is replaced with the issue number at render time). A
 * `pi-rukas` entry has no action; the merge hold has no class. `kindDriven`
 * means: the cap's failure kind decides the class (KIND_CLASS), so a provider
 * outage behind a step failure is `environment`, and a child that exited with
 * no structured cause is `environment` too (the host, not the driver, is the
 * usual culprit). `cls: null` is the one entry that is not a failure at all.
 */
export type CapCause =
  | { cls: "pi-rukas"; reason: string; action: null; kindDriven?: boolean }
  | { cls: Exclude<CauseClass, "pi-rukas">; reason: string; action: string; kindDriven?: boolean }
  | { cls: null; reason: string; action: string; kindDriven?: boolean };

/** How a failure kind maps to a class when the cap's failure kind decides it. */
export const KIND_CLASS: Record<FailureKind, CauseClass | undefined> = {
  provider: "environment",
  timeout: "environment",
  environment: "environment",
  guard: "environment",
  process: "environment",
  crashed: "environment",
  driver: "pi-rukas",
  verify: "change",
  cap: undefined,
};

/** The action for a kind whose cause is the host, not the change or the driver (`{issue}` filled at render). */
export const HOST_ACTION =
  "check that the host ran undisturbed (sleep/suspend, memory pressure — e.g. run `caffeinate -dimsu` alongside long cycles on macOS), then re-run `/work {issue}`";

/** Kind-specific actions, used when a kind moves a cap into a class other than its own entry's. */
export const KIND_ACTION: Partial<Record<FailureKind, string>> = {
  process: HOST_ACTION,
  crashed: HOST_ACTION,
};

/** The generic action for a class, used when a kind-driven cap lands in a class other than its default. */
export const ACTION_FOR_CLASS: Record<CauseClass, string | null> = {
  issue:
    "decide the open question named in the evidence (on the issue or its PR), then re-run `/work {issue} --restart`",
  change:
    "fix the change the evidence names — the failure is in this cycle's own code — then re-run `/work {issue} --restart`",
  environment:
    "clear the environment fault the evidence names (the provider, the host or the deadline), then re-run `/work {issue}`",
  "pi-rukas": null,
};

const ISSUE_DECIDES =
  "decide the open question named in the evidence, then re-run `/work {issue} --restart`";
const CHANGE_FIX = "fix the change the evidence names, then re-run `/work {issue} --restart`";
const ENV_CLEAR = "clear the environment fault the evidence names, then re-run `/work {issue}`";

/** Every fixed-literal cap the driver can record. Compile-time exhaustive. */
export const FIXED_CAP_CAUSE: Record<FixedCap, CapCause> = {
  "adversarial-infra-failure": {
    cls: "environment",
    reason: "the adversarial reviewer's child could not be run to a verdict",
    action:
      "check the reviewer's provider and quota named in the evidence, then re-run `/work {issue}`",
    kindDriven: true,
  },
  // The reviewer judged the diff and still found issues after its own rounds.
  "adversarial-loop": {
    cls: "change",
    reason: "the adversarial gate still found issues in the diff after its internal rounds",
    action: CHANGE_FIX,
  },
  // Not a failure: the work is done and pushed, so it carries no class.
  "awaiting-human-merge": {
    cls: null,
    reason:
      "all the work is done and pushed, and only the merge is held — this is a hold, not a failure",
    action:
      "merge the PR, or grant merge authority (AGENTS.md section 9, or --merge) and re-run `/work {issue}`",
  },
  "ci-retry": {
    cls: "change",
    reason: "CI failed on every retry, so the change does not pass the project's CI",
    action: CHANGE_FIX,
  },
  "claims-lock-unavailable": {
    cls: "environment",
    reason: "the driver could not take its claims lock under .pi/work-state",
    action: "make .pi/work-state writable and free of a stuck lock, then re-run `/work {issue}`",
  },
  // The committed diff lacks files from a workstream: the driver's own
  // integration invariant, not something the change did.
  "commit-pr-incomplete-consolidation": {
    cls: "pi-rukas",
    reason:
      "the driver's consolidation dropped files from a workstream before the commit (a driver defect)",
    action: null,
  },
  "consolidated-verify-conflict": {
    cls: "change",
    reason: "two workstreams' changes conflict when combined",
    action: CHANGE_FIX,
  },
  "consolidated-verify-consolidation-created": {
    cls: "change",
    reason: "the combination of workstreams fails a check that neither tripped alone",
    action: CHANGE_FIX,
  },
  // Same invariant family as the commit-pr gap above.
  "consolidation-incomplete": {
    cls: "pi-rukas",
    reason: "the driver's consolidation of workstream results is incomplete (a driver defect)",
    action: null,
  },
  "continue-pr-ambiguous": {
    cls: "issue",
    reason:
      "more than one open PR matches the issue, so the driver will not guess which to continue",
    action:
      "close or retarget the extra PRs, or pick one and re-run `/work {issue} --continue-pr <N>`",
  },
  "continue-pr-fork": {
    cls: "issue",
    reason: "the PR to continue comes from a fork, which the driver will not push to",
    action:
      "continue the PR by hand, or re-run `/work {issue} --restart` on a branch of this repository",
  },
  "continue-pr-head-moved": {
    cls: "issue",
    reason:
      "the PR's head moved after the driver read it, so continuing it could overwrite someone's commits",
    action: "re-read the PR, then re-run `/work {issue} --continue-pr <N>`",
  },
  "continue-pr-not-found": {
    cls: "issue",
    reason: "the PR named for continuation does not exist",
    action: "name an existing PR, or re-run `/work {issue} --restart`",
  },
  "continue-pr-unresolved": {
    cls: "issue",
    reason: "the driver could not resolve which PR to continue",
    action: "name the PR explicitly with `--continue-pr <N>`, then re-run `/work {issue}`",
  },
  "continue-pr-unsafe-head": {
    cls: "issue",
    reason: "the PR's head branch is not one the driver may safely continue",
    action: "decide whether to continue or replace the PR, then re-run `/work {issue}`",
  },
  "cross-group-conflict": {
    cls: "environment",
    reason: "another cycle in this clone holds claims on the same paths",
    action: "wait for the other cycle to finish, then re-run `/work {issue}`",
  },
  deadline: {
    cls: "environment",
    reason: "the caller's whole-cycle deadline ended the cycle",
    action: "raise or clear the deadline, then re-run `/work {issue} --restart`",
    kindDriven: true,
  },
  "deadline:no-fit": {
    cls: "environment",
    reason: "too little time was left before the caller's deadline for the next step",
    action: "raise or clear the deadline, then re-run `/work {issue} --restart`",
  },
  "deferred-creation:develop": {
    cls: "environment",
    reason:
      "a dependent workstream's worktree could not be created because a leftover sat at its path",
    action:
      "salvage or remove the leftover named in the evidence, then re-run `/work {issue} --restart`",
  },
  "dependency-cycle": {
    cls: "issue",
    reason: "the issue's declared dependencies form a cycle, so no order can satisfy them",
    action: "remove or reverse one declared dependency, then re-run `/work {issue} --restart`",
  },
  "dependency-parked": {
    cls: "issue",
    reason: "a declared dependency did not merge, so this issue never started",
    action:
      "get the dependency merged, or drop it from the issue body, then re-run `/work {issue} --restart`",
  },
  "dependency-timeout": {
    cls: "issue",
    reason: "a declared dependency did not settle within the queue's wait bound",
    action:
      "get the dependency settled, or drop it from the issue body, then re-run `/work {issue} --restart`",
  },
  "develop-child-crash": {
    cls: "environment",
    reason: "the develop child died mid-pass, most often the host suspending",
    action:
      "keep the host awake for the cycle (`caffeinate -dimsu` on macOS), then re-run `/work {issue} --restart`",
  },
  "develop-incomplete-deliverables": {
    cls: "change",
    reason: "develop finished without producing every deliverable the spec names",
    action: CHANGE_FIX,
  },
  "draft-rearm-failed": {
    cls: "environment",
    reason: "the forge would not return the PR to draft while its review re-ran",
    action:
      "make the PR a draft by hand (the handoff names the command), then re-run `/work {issue} --restart`",
  },
  "existing-pr-detected": {
    cls: "issue",
    reason: "an open PR already exists for this issue",
    action: "decide whether to resume, retarget or close that PR, then re-run `/work {issue}`",
  },
  "explore-already-complete": {
    cls: "issue",
    reason: "explore found the issue already satisfied by earlier work",
    action:
      "confirm and close the issue, or re-run `/work {issue}` with the context that says otherwise",
  },
  "explore-bodies-empty": {
    cls: "environment",
    reason: "the issue body could not be fetched on any attempt",
    action: "fix the gh setup (`gh auth status`), then re-run `/work {issue}`",
  },
  "explore-needs-clarification": {
    cls: "issue",
    reason: "the issue does not say concretely enough what to build",
    action: "clarify the issue body, then re-run `/work {issue} --restart`",
  },
  "fence-violation:develop": {
    cls: "change",
    reason:
      "the cycle's own code crossed its declared scope fence and the recovery did not converge",
    action: "split the plan so each file has one owner, then re-run `/work {issue} --restart`",
  },
  "fix-pass-park": {
    cls: "change",
    reason: "the adversarial fix pass did not clear its own checks on the change",
    action: CHANGE_FIX,
  },
  "integration-verify-failed": {
    cls: "change",
    reason: "the integrated tree fails the project's verify command",
    action: CHANGE_FIX,
  },
  // Routed to pi-rukas except when git could not create the integrate worktree
  // at all; that git error is an environment fault (see work-driver-cause-class).
  "integration-worktree-violation": {
    cls: "pi-rukas",
    reason:
      "commit-pr's ops fallback worked in a worktree the driver does not own (a driver invariant)",
    action: null,
  },
  // Every intent-park reason is a spec-level question for the issue.
  "intent-park": {
    cls: "issue",
    reason: "the issue as written cannot be resolved into work the driver should build",
    action: "revise the issue body as the evidence says, then re-run `/work {issue} --restart`",
  },
  // The review's diff could not be read: the driver's own read path.
  "lens-diff-unreadable": {
    cls: "pi-rukas",
    reason: "the driver could not read the branch's diff for the review",
    action: null,
  },
  "lens-fix-not-integrated": {
    cls: "pi-rukas",
    reason: "a lens fix was written but never integrated into the branch (a driver defect)",
    action: null,
  },
  "lens-fix-reposition": {
    cls: "change",
    reason: "a lens fix could not be placed on the branch's current head",
    action: CHANGE_FIX,
  },
  "lens-review-timeout": {
    cls: "environment",
    reason: "the review's fix loop ran past its own wall-clock budget",
    action:
      "raise PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS or reduce host load, then re-run `/work {issue}`",
    kindDriven: true,
  },
  "loop-detected": {
    cls: "environment",
    reason: "pi-rukas stopped a child that was repeating the same actions",
    action: "split the issue into smaller steps, then re-run `/work {issue} --restart`",
    kindDriven: true,
  },
  // Empty delta: the review had nothing to read, which the driver must not treat as approval.
  "no-review-outcome": {
    cls: "pi-rukas",
    reason:
      "the lens review returned no outcome for a delta the driver had to review (a driver defect)",
    action: null,
  },
  "ops-merge-base-mismatch": {
    cls: "pi-rukas",
    reason:
      "the branch the ops fallback created does not sit on the resolved base (a driver defect)",
    action: null,
  },
  "plan-spec-mismatch": {
    cls: "pi-rukas",
    reason:
      "the plan was judged to describe different work than the spec (a driver defect in plan-to-spec)",
    action: null,
  },
  "plan-timeout": {
    cls: "environment",
    reason: "the plan step ran past its own time bound",
    action: "raise PI_ENSEMBLE_PLAN_BOUND_MS or reduce host load, then re-run `/work {issue}`",
    kindDriven: true,
  },
  "provider-unavailable": {
    cls: "environment",
    reason: "the model endpoint was down and every retry met the same fault",
    action: "re-run `/work {issue}` once the endpoint answers (do not pass --restart)",
  },
  "queue-stranded": {
    cls: "pi-rukas",
    reason: "the queue halted and released a group that had not started (a queue defect)",
    action: null,
  },
  // Same shape as a seam between workstreams: the spec is the thing to revise.
  "repeat-finding-seam": {
    cls: "issue",
    reason: "the same finding repeats across files, which points at a missing seam in the spec",
    action: ISSUE_DECIDES,
  },
  "repo-root-residue": {
    cls: "environment",
    reason: "uncommitted work sat at the repo root before development, and it is not this cycle's",
    action: "commit, move or ignore the paths named in the evidence, then re-run `/work {issue}`",
  },
  "review-incomplete": {
    cls: "environment",
    reason: "at least one review lane returned no verdict, so the diff was not fully reviewed",
    action: "re-run `/work {issue}` once the lane's provider or host is healthy",
    kindDriven: true,
  },
  "round-cap": {
    cls: "change",
    reason: "the review hit its round cap with findings still open",
    action: "fix the findings on the PR, then re-run `/work {issue} --restart`",
  },
  "spawn-backstop": {
    cls: "environment",
    reason: "a developer child hit the two-hour backstop before it finished",
    action: "split the issue into smaller workstreams, then re-run `/work {issue} --restart`",
    kindDriven: true,
  },
  "step-back-revise-spec": {
    cls: "issue",
    reason: "the step-back analysis found the spec underspecified",
    action:
      "revise the issue using the proposed revision in the handoff, then re-run `/work {issue} --restart`",
  },
  "token-budget": {
    cls: "environment",
    reason: "the cycle exceeded its token budget and pi-rukas stopped it",
    action: "raise the token budget or split the issue, then re-run `/work {issue} --restart`",
    kindDriven: true,
  },
  // The planner's report_workstream results never reached the driver.
  "workstream-results-unreadable": {
    cls: "pi-rukas",
    reason: "the driver could not read the planner's workstream results (a driver defect)",
    action: null,
  },
  "worktree-listing-unreadable": {
    cls: "pi-rukas",
    reason: "the driver could not read git's worktree listing, so it could not check for residue",
    action: null,
  },
};

/** Template families. `verify-failed` is routed by evidence in work-driver-cause-class. */
export const TEMPLATE_CAP_CAUSE: Record<keyof typeof CAP_TEMPLATES, CapCause> = {
  "verify-failed": {
    cls: "change",
    reason: "the verify command failed on the cycle's own code",
    action: CHANGE_FIX,
  },
  "verify-timeout": {
    cls: "environment",
    reason: "the verify command was killed at its time bound and reached no verdict",
    action: "raise the verify timeout or reduce host load, then re-run `/work {issue}`",
  },
  "verify-env": {
    cls: "environment",
    reason: "the host refused to start a process, so the verify command never ran",
    action: ENV_CLEAR,
  },
  "verify-baseline-red": {
    cls: "environment",
    reason: "the verify command already fails on the base branch, without this change",
    action: "fix the base branch's verify failure first, then re-run `/work {issue}`",
  },
  "pr-not-open": {
    cls: "issue",
    reason: "the cycle's PR was no longer open when the step started",
    action: "decide whether the new work belongs in a new PR",
  },
  "issue-closed": {
    cls: "issue",
    reason: "a person closed the issue while the cycle was running",
    action: "reopen the issue if the work is still wanted, then re-run `/work {issue} --restart`",
  },
  "child-timeout": {
    cls: "environment",
    reason: "a child outlived its per-child run bound without finishing",
    action: "split the issue, or raise the per-child bound, then re-run `/work {issue} --restart`",
  },
  "step-failed": {
    cls: "pi-rukas",
    reason: "the step failed and the driver recorded no structured cause for it",
    action: null,
    kindDriven: true,
  },
  "driver-crash": {
    cls: "pi-rukas",
    reason: "the driver crashed inside a step handler (an unhandled error in pi-rukas)",
    action: null,
  },
  "branch-ahead": {
    cls: "issue",
    reason: "the local feature branch holds unpushed commits that a reset would destroy",
    action:
      "push the commits if they are live work, or delete the branch if stale, then re-run `/work {issue}`",
  },
};
