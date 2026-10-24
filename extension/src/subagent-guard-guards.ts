/**
 * The mode-independent guard registration block shared by the two child
 * entry points: registerSubagentGuard (the full pi-rukas extension in
 * strict/headless mode) and child-guards.ts (the companion loaded into every
 * trust-mode child, #926). Extracted VERBATIM from
 * permission-subagent-guard.ts (#926) so the call order, comments and
 * placement-before-every-bypass stay byte-identical in both children.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDeveloperPushGuard } from "./developer-push-guard.ts";
import { registerIssueCreationGuard } from "./issue-creation-guard.ts";
import { registerMemoryWriteGuard } from "./memory-write-guard.ts";
import { registerMergeGuard } from "./merge-guard.ts";
import { registerPublicHygieneGuard } from "./public-hygiene-guard.ts";
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
  // holding a merge grant (none since #962) could merge on a developer's
  // self-report plus CI in trust/sandbox mode. The review ledger is the
  // structural floor; the guard fires before every bypass.
  registerMergeGuard(pi);
  // #1113 — the developer push ban, and the one guard in this list that is
  // ROLE-scoped rather than universal: it refuses `git push` only when
  // PI_ENSEMBLE_ROLE is `developer` (read in the hook body, so the parent and
  // every other role are untouched). The permission layer granted it —
  // agents.json had `"git push*": "allow"` for developer — and trust/sandbox
  // mode consult neither, which is how PM-authored "push your branch" briefs
  // reached the remote on 2026-10-11. Same placement reasoning as above: after
  // the bypasses it would never run.
  registerDeveloperPushGuard(pi);
  // #1666 — a destructive vipune write (`vipune update -t`) is refused here too.
  // Before this block it was refused only through the agents.json verdict, which
  // trust-mode children never consult, so a /work child could rewrite a memory row.
  registerMemoryWriteGuard(pi);
  // #1788 — a publish whose text carries a private term is refused here. The
  // repository is public and the check must run in the modes that are the
  // default, so it sits with the others rather than after them. This is its
  // ONLY registration: the block is reached by the companion (trust children),
  // by registerSubagentGuard (strict/headless children) and by the parent
  // through registerPermissionGuard, so one call here is one hook per process
  // — a second one would run the push scan's git calls twice per push.
  registerPublicHygieneGuard(pi);
}
