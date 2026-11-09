/**
 * merge-guard-protected — the merge guard's half of the protected-path gate: the
 * read plus the refusal a held `gh pr merge` / `glab mr merge` shows the agent.
 *
 * Split from `merge-guard.ts` for the 500-line file cap (AGENTS.md §12): the
 * predicate answers, this module phrases, and the hook calls one function — so
 * the guard's body keeps the review/ledger reads it is organised around.
 */

import { type ProtectedMergeRead, committedProtectedPaths } from "./merge-protected-paths.ts";
import type { MergeExecFn } from "./merge-target.ts";
import { protectedPathsSentence, protectedReadUnreadableSentence } from "./protected-paths-text.ts";

/** What the guard hands back when the merge must not go ahead. */
export type ProtectedMergeRefusal = { block: true; reason: string } | undefined;

/**
 * Ask the shared predicate for the PR's own diff and render the refusal.
 *
 * `{ ok: false }` is a refusal, not a pass. Both OIDs are the ones the caller
 * already verified, so the guard inspects the commit it is about to merge rather
 * than whatever the ref points at now. No escape hatch is offered here: the
 * remedy is that the operator merges this PR.
 */
export async function protectedMergeRefusal(
  execFn: MergeExecFn,
  cwd: string,
  headOid: string,
  baseOid: string,
): Promise<ProtectedMergeRefusal> {
  const read: ProtectedMergeRead = await committedProtectedPaths(execFn, cwd, headOid, baseOid);
  if (read.ok && read.paths.length === 0) return undefined;
  return {
    block: true,
    reason: `merge refused: ${
      read.ok
        ? protectedPathsSentence(read.paths)
        : protectedReadUnreadableSentence(`head ${headOid.slice(0, 12)}`, read.unreadable)
    }`,
  };
}
