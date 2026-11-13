/**
 * merge-guard-author-text — the shared wording for the merge-author gate's
 * refusals on the escape-hatch path (`authorGateOnly` in merge-guard-author.ts).
 *
 * One module because the sentence that names the hatch is the one thing this path
 * must say and the one thing the gate's own module must not contain: the #2181
 * invariant (`test-merge-author-invariants.ts`) scans merge-guard-author.ts for
 * the hatch knob's name, comment-stripped, to prove no override reaches the author
 * rule. A refusal that quotes the knob to the operator is wording, not a read of
 * it, so it lives here — the same seam `protected-paths-text.ts` is for the
 * protected-path refusals, and for the same reason.
 */

/** The clause every hatch-path refusal opens with: the hatch does not reach this gate. */
export const AUTHOR_HATCH_SENTENCE =
  "the merge-author gate is not waived by PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE";

/** A merge whose PR number never resolved; names the repo it was looked up in. */
export function authorUnresolvedPrSentence(repo: string | undefined): string {
  return `the PR/MR to be merged could not be identified from the command or the current branch (repo: ${repo ?? "none"}), so its author could not be checked. Name the number in the merge command.`;
}

/** A PR whose record could not be read, so no author could be read with it. */
export function authorUnreadableTargetSentence(reason: string): string {
  return `the pull request to be merged could not be read to check its author (${reason})`;
}

/** A merge aimed at the other forge than the one whose PR was just read. */
export function authorUnreadableForgeSentence(commandForge: string, repoForge: string): string {
  const merging = commandForge === "gitlab" ? "glab mr merge" : "gh pr merge";
  return `\`${merging}\` merges on ${commandForge} while this repo's forge is ${repoForge} — the author of the PR actually merged could not be checked`;
}

/** No remote to read the allowlist's base commit from. */
export function authorUnreadableRemoteSentence(allowlistFile: string): string {
  return `no git remote (origin/upstream/first) was found to read ${allowlistFile} at`;
}
