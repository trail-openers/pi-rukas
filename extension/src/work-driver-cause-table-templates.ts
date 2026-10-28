/**
 * work-driver-cause-table-templates — the cause-class entries for the TEMPLATE
 * cap families (`verify-failed:develop`, `branch-ahead:3`, …), split out of
 * work-driver-cause-table.ts (AGENTS.md §12 file-size cap) as a pure move: the
 * fixed-literal table stays where it was and this table keeps its compile-time
 * exhaustiveness over `CAP_TEMPLATES`, so a new template family without a class
 * is still a type error. Behaviour is unchanged.
 */

import type { CAP_TEMPLATES } from "./headless/caps.ts";
import type { CapCause } from "./work-driver-cause-table.ts";

/** The generic action sentences the split table shares with the fixed one. */
const CHANGE_FIX = "fix the change the evidence names, then re-run `/work {issue} --restart`";
const ENV_CLEAR = "clear the environment fault the evidence names, then re-run `/work {issue}`";

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
  // #1439 — the template family for `push-refused:<step>`. `issue` because the remote
  // refused the CONTENT the issue asked for; the action is the operator's, not the
  // cycle's. `causeReason`/`userAction` are overridden per-refusal in
  // `pushRefusalVerdict` (work-driver-cause-class.ts), which quotes the refusal; this
  // entry is what the cap carries when it is read outside that route.
  "push-refused": {
    cls: "issue",
    reason:
      "the forge refused the push, so nothing was published and the verify command never judged this content",
    action:
      "the forge refused the push (push protection / repository rules): either allow the flagged content via the URLs in the evidence, or change the issue/fixtures so the content is not committed (e.g. build test secrets from fragments at runtime), then re-run `/work {issue} --restart`",
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
