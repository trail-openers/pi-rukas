/**
 * work-driver-merged-repo — #1533: the one question the merged step asks about
 * the repository before it spends a network fetch on the head verification:
 * *is there a git repository here at all?*
 *
 * The head verification reads the review ledger from the clone's git common
 * dir. A caller with no repository to read it from has no reviewed identity to
 * compare against, and parking such a cycle on "no git remote found" would be
 * the driver inventing a fault the cycle never had — the shape that made a
 * resumed or hand-built state file look like a broken issue. So the merged
 * step asks first, cheaply, and pins without the comparison when the answer is
 * no (the refusal note says so, and the pin still applies).
 *
 * A leaf: one `node:fs` probe, no git call, no executor. It deliberately does
 * NOT ask "is this a clone with a remote" — that is the identity check's own
 * first refusal, and a cycle whose repository is real but has no remote SHOULD
 * park, because there is nothing to have reviewed.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Does this path hold a git repository (or a worktree's `.git` file)?
 *
 * `existsSync` rather than a git call: the caller has a bounded executor it
 * would rather spend on the real reads, and "is there a `.git` here" has one
 * answer that does not need a subprocess. A `.git` FILE counts — a linked
 * worktree has one, and the driver runs its workstreams in exactly those.
 */
export function hasGitDir(repoRoot: string): boolean {
  if (!repoRoot) return false;
  const dot = path.join(repoRoot, ".git");
  try {
    return existsSync(dot);
  } catch {
    // An unreadable path is not a repository; the caller degrades to the pin
    // alone rather than refusing a merge it cannot substantiate.
    return false;
  }
}
