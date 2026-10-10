/**
 * The mode-independent guard registration block shared by the two child
 * entry points: registerSubagentGuard (the full pi-rukas extension in
 * strict/headless mode) and child-guards.ts (the companion loaded into every
 * trust-mode child, #926). Extracted VERBATIM from
 * permission-subagent-guard.ts (#926) so the call order, comments and
 * placement-before-every-bypass stay byte-identical in both children.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIssueCreationGuard } from "./issue-creation-guard.ts";
import { registerMergeGuard } from "./merge-guard.ts";
import { registerDestructiveGitGuard } from "./permission-subagent-guard.ts";

export function registerModeIndependentGuards(pi: ExtensionAPI): void {
  // BEFORE every bypass below. Trust mode is the default on an interactive
  // host and sandbox mode is the default in a container, so a guard placed
  // after them would, in practice, never run — which is exactly the state that
  // let a subagent `git checkout` away an uncommitted deliverable and silently
  // revert two reviewed defect fixes.
  //
  // This is not a permission. The permission layers answer "is this role
  // allowed to run git?", and the answer is yes. This answers "may anything
  // destroy work the harness has not captured yet?", and the answer is no,
  // whatever the trust level — the container fence and the operator's trust
  // both protect the HOST, and neither protects the developer's own diff.
  registerDestructiveGitGuard(pi);
  // #598 — same mode-independence for the second un-gated door: PM filed
  // three non-trivial issues inline in one session (#591/#592/#594) through a
  // self-judged "triviality test" with no oracle. A subagent that discovers a
  // missing ticket must report it to PM, not open the door itself. The guard
  // is shared with the parent guard (permission-guard.ts) so both layers
  // stay byte-identical.
  registerIssueCreationGuard(pi);
  // #912 — same mode-independence for the merge door: an ops subagent
  // holding an `gh pr merge*` grant could merge on a developer's
  // self-report plus CI in trust/sandbox mode. The review ledger is the
  // structural floor; the guard fires before every bypass.
  registerMergeGuard(pi);
}
