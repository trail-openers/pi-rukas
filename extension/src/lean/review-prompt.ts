/**
 * lean/review-prompt — the briefs the review step composes.
 *
 * Both exist because lean has no caller to hand the step a context string. The
 * adversarial loop and the six-lens pass each take one free-text `context`, and
 * in the frozen driver the driver composed it; here the step is the caller, so
 * the framing is this module's. It is short on purpose: the diff, the issue body
 * and the finding lists are the substance, and the loop and the lens roster
 * already say what to do with them.
 *
 * The fix brief is the other half, and the more important one. A fixer handed
 * findings without a diff, an issue or a tree re-derives a solution from
 * scratch — the frozen driver's fix-developer got the reviewer's entire reply as
 * "findings" and no diff at all (#664), which is how a fix round undid a fix. So
 * the finding text arrives fenced and bounded (the `text-fence.ts` rule, one
 * implementation), the diff arrives as the command the step actually ran, and
 * the frozen acceptance tests are named as untouchable — the same claim
 * `build-prompt` makes, because the fixer is the second model that gets a
 * worktree with the contract's tests in it.
 */

import { fenceText } from "./text-fence.ts";

/** The framing the adversarial reviewer is dispatched with. */
export function adversarialContext(issue: number, round: number, maxRounds: number): string {
  return `/work-lean issue #${String(issue)}: gating the run's committed head before it merges (review step, round ${String(round)} of ${String(maxRounds)}).`;
}

/**
 * The framing every lens is dispatched with.
 *
 * Two optional blocks, both of which the frozen driver's lens pass carries and a
 * lens cannot reconstruct from a diff: findings the adversarial gate passed on
 * without blocking (this gate owns the severity bar, so it decides whether they
 * matter), and the delta the last fix pass moved, which a lens reads FIRST and
 * weighs specifically for what the fix broke beside the line it repaired.
 */
export function lensContext(
  issue: number,
  round: number,
  extra: { carried?: string; fixDelta?: string } = {},
): string {
  const parts = [`/work-lean issue #${String(issue)}, lens-review round ${String(round)}`];
  const carried = extra.carried?.trim();
  if (carried !== undefined && carried !== "")
    parts.push(
      `OUTSTANDING FROM THE ADVERSARIAL GATE (non-blocking there — judge them yourself):\n${carried}`,
    );
  const delta = extra.fixDelta?.trim();
  if (delta !== undefined && delta !== "") parts.push(delta);
  return parts.join("\n\n");
}

/**
 * What the fixer is told about the tree it works in.
 *
 * The child's cwd is the worktree, but a model that has to infer which directory
 * is its own will write somewhere else, so the three git facts it needs are
 * stated: where, on what branch, against what base. `head` is the commit the
 * review read — the tree the findings describe. A fixer given only the branch
 * cannot tell whether it sits at the reviewed commit or one behind it.
 */
export interface ReviewFixArgs {
  issue: number;
  round: number;
  /** Which gate produced the findings; names the list in the brief. */
  gate: string;
  findings: string;
  /** Absolute path of the disposable tree the child works in. */
  worktree: string;
  branch: string;
  base: string;
  head: string;
  /** The frozen acceptance test paths — the child may not edit these. */
  frozenPaths: string[];
}

export function fixPrompt(opts: ReviewFixArgs): string {
  const frozenList =
    opts.frozenPaths.length === 0
      ? "(none — this run froze no tests)"
      : opts.frozenPaths.map((p) => `- \`${p}\``).join("\n");
  return `You are fixing the findings one review gate raised against this run's work (issue #${String(
    opts.issue,
  )}, review step, round ${String(opts.round)}, gate: ${opts.gate}).

## The findings

${fenceText(opts.findings, 20_000)}

## The tree

- Worktree: \`${opts.worktree}\` — work ONLY here.
- Branch: \`${opts.branch}\`
- Reviewed commit: \`${opts.head}\` (base \`${opts.base}\`)

Read the diff you are changing with \`git diff ${opts.base}...${opts.head}\` before you edit anything: these findings describe that tree, not the whole repository.

## Untouchable

These files are the run's acceptance contract — frozen, and proved red before the implementation existed. Do NOT edit, rename or delete any of them, and do not add a new test file:

${frozenList}

A fix that turns a frozen test green by changing it has destroyed the only evidence this run has. If a finding can only be resolved by changing one of these, leave it and say so in your reply.

## What to do

Fix every finding you can without widening the change: no guards for inputs that cannot occur, no refactors beside the fix, no comments narrating this round. Check your own work by running the frozen tests and the project's fast typecheck and lint — **do not run the project's full test suite**, the verify step runs it.

Commit what you changed (do not push, do not amend, do not rebase). If a finding is wrong or out of scope, leave it and say why in your reply rather than arguing with it in code.`;
}
