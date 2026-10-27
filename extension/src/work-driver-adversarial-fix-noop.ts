/**
 * work-driver-adversarial-fix-noop — the fix pass's "did it change anything"
 * check, split from `work-driver-adversarial-fix-scope.ts` (which owns the
 * admission ladder and the ceiling). Its own file because it is the FIRST
 * post-pass question and the only one with no fence input: an empty answer here
 * makes every later check moot.
 */

import type { TreeChanges } from "./work-driver-adversarial-fix-git.ts";
import type { PassPlan } from "./work-driver-adversarial-fix-scope.ts";

/**
 * The no-op check: a pass whose post-pass tree is byte-identical to what each
 * workstream had before it ran fixed nothing (#1137's family). Both the diff and
 * the untracked list are compared — a pass that created and then deleted a file
 * leaves the diff alone but not the untracked set, and either difference is
 * evidence of work.
 *
 * Returns the workstream ids that produced nothing; the caller turns a non-empty
 * list into the park reason, whose wording matters (the handoff distinguishes a
 * no-op pass from a fence refusal).
 */
export function unchangedPlans(
  plans: readonly PassPlan[],
  after: readonly TreeChanges[],
): string[] {
  return plans
    .filter(
      (p, i) =>
        after[i]?.diff === p.before.diff &&
        after[i]?.untracked.join("\n") === p.before.untracked.join("\n"),
    )
    .map((p) => p.id);
}
