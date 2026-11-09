/**
 * work-driver-merged-protected — the `/work` driver's merge-time protected-path
 * gate, as one call from `runMerged`.
 *
 * The develop-time gate (#406) halts a cycle that writes `.github/`, `.pi/`,
 * `CODEOWNERS` or `agents.json` unless the operator named those paths with
 * `--allow-protected`. Nothing at merge time knew about that grant: the `merged`
 * step asked authority, evidence and head, never what the PR changed, so a cycle
 * whose patch rewrote its own CI workflow merged itself. This gate closes that,
 * asking the same predicate the merge guard asks (`merge-protected-paths.ts`) so
 * the two cannot drift.
 *
 * Two refusals, both an `awaiting-human-merge` park with the PR left open: a
 * protected path in the PR's own diff, and an unreadable diff — because "could not
 * read it" and "nothing protected changed" must not be the same answer to a step
 * that merges on the difference. Neither honours `--allow-protected` or
 * `PI_ENSEMBLE_PROTECTED_PATHS=0`: that grant authorises a develop-time WRITE and
 * that switch disables that halt only, and neither is a statement about merging.
 *
 * The read is over freshly fetched `<remote>/<branch>` and `<remote>/<mainline>`,
 * never this tree's `HEAD` — the driver's checkout is not the PR's head and its
 * remote-tracking refs are whatever the last fetch left — which is also why the
 * branch name is validated here rather than trusted. The head OID comes from the
 * caller whenever it has one, so the gate inspects the very commit the merge lands.
 *
 * It is deliberately NOT behind `mergeAuthorityEnabled()`: that switch governs the
 * permission/evidence gate, and this is a different question that has to fail the
 * same way whether or not the authority question was asked.
 */

import { mergeProtectedPathsForBranch } from "./merge-protected-paths.ts";
import { protectedPathsSentence, protectedReadUnreadableSentence } from "./protected-paths-text.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { mergeProtectedHold } from "./work-driver-merged-hold.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

/**
 * The merge-time protected-path check for this cycle's PR: `undefined` when the
 * PR's own commits touch nothing protected and the read is trustworthy, or the next
 * state to return from `runMerged` — the same `mergeHold` the other merge refusals
 * write (so the worktree sweep and every handoff renderer read it), plus the
 * `awaiting-human-merge` cap-hit routing to handoff.
 *
 * `headOid` is the OID the caller will pin the merge to, when it has verified one:
 * passing it makes the gate's diff and the merge's target the same commit.
 */
export async function heldForProtectedPaths(
  ctx: CycleContext,
  state: WorkState,
  exec: NonNullable<CycleContext["verifyExecFn"]>,
  headOid?: string,
): Promise<WorkState | undefined> {
  const branch = state.pipelineState.branchName ?? "";
  const read = await mergeProtectedPathsForBranch(exec, ctx.repoRoot, branch, headOid);
  if (read.ok && read.paths.length === 0) return undefined;
  const who = `${branch || "this PR"} at ${headOid?.slice(0, 12) ?? "the fetched head"}`;
  const evidence = read.ok
    ? protectedPathsSentence(read.paths)
    : protectedReadUnreadableSentence(who, read.unreadable);
  trace(
    `work-driver: merge held — ${read.ok ? `${read.paths.length} protected path(s) in the PR diff` : `protected-path read failed: ${read.unreadable}`}`,
  );
  return appendEvent(mergeProtectedHold(state, evidence), {
    kind: "cap-hit",
    at: Date.now(),
    cap: "awaiting-human-merge",
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
  });
}
