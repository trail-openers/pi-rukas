/**
 * review-accept-verb — the one reader that knows where a GIT VERB sits (#1738).
 *
 * The accept guard's arms and scope tests ask two different questions of the same word:
 * is it a program (`review-accept-arms.ts`'s `namesGit`), and is it the verb that program
 * would run (here). The second is a POSITION, not a word that happens to appear: the word
 * `apply` inside a commit message or an unterminated heredoc body is prose, and only the
 * word standing where git reads its verb is `git apply`. Matching any word refused prose
 * and, worse, let one decoy word answer for the whole command.
 *
 * There is exactly ONE reader here on purpose (#1764 fix round). The arms, the scope tests
 * and the prose mask of `review-accept-views.ts` all need the same answer — is this
 * `git commit -m "…"`, wherever the `-C <worktree>` sits — and a second implementation in
 * `review-accept-arms.ts` drifted from this one, so the sanctioned worktree commit kept
 * its prose mask in one path and lost it in the other. `gitVerbIndex` is the index form
 * the arms need (they must step OVER the selectors); `gitVerbOfSegment` is the word form
 * everyone else wants.
 *
 * Split from `review-accept-command.ts` because that module — the command-text readers —
 * is at the §12 file-size cap and this is a self-contained seam of its own.
 */

import { baseName, unquote } from "./review-accept-command.ts";

/** git's pre-verb switches — global in position, valueless, and never the verb. */
const GIT_PREAMBLE = /^(?:--no-pager|--paginate|--html-path|--man-path|--info-path)$/i;
/** git's global options whose value is a SEPARATE word: the scan steps over the value too,
 * or `git -C /repo log` would answer `/repo` where the verb belongs. */
const GIT_GLOBAL_VALUE_OPTION =
  /^(?:-c|--git-dir|--work-tree|--exec-path|--namespace|--super-prefix|--config-env)$/i;
/** The ONLY words A1 steps over on the way to its verb: the valueless switch it already
 * spells, another `git`, an empty word, and the repo-location / config selectors whose
 * VALUE `hasUnresolvedRepoSelector` has read with its target. Anything else standing
 * before the verb (`--paginate`, an unknown switch) is a word this arm has not vouched
 * for, so the arm refuses rather than step over it (#1764 fix round: the step-over audit
 * lives beside the reader, where the two cannot disagree). */
const GIT_SANCTIONED_PREVERB =
  /^(?:git|--no-pager|-c|--git-dir|--work-tree|--exec-path)(?:$|[=:/,.\-])/i;
const GIT_SANCTIONED_SPACED = /^(?:-c|--git-dir|--work-tree|--exec-path)$/i;

/**
 * The verb of ONE command segment as an INDEX into `words`, or -1 when the segment runs no
 * git or has no bare word to run: the first BARE word after the leading `git`, with the
 * pre-verb switches and the spaced global values stepped over. An option-shaped word
 * (`-a`, `-f`, `--stdin`) is a flag and the scan moves on. A QUOTED verb still counts —
 * `unquote` reads `"apply"`, and that is the spelling the shell hands git as its verb.
 *
 * The verb is a POSITION and the program is the segment HEAD, the way every arm reads it:
 * `echo patch | git apply -` is the segment `git apply -` once `armsOf` has cut it, while a
 * prose line that merely mentions `git rm` in its middle names no verb.
 */
export function gitVerbIndex(words: string[]): number {
  if (baseName(unquote(words[0] ?? "")) !== "git") return -1;
  for (let i = 1; i < words.length; i++) {
    const a = unquote(words[i] ?? "");
    if (a === "" || a === "git" || GIT_PREAMBLE.test(a)) continue;
    if (GIT_GLOBAL_VALUE_OPTION.test(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return i;
  }
  return -1;
}

/** The verb of one command segment, or undefined when the segment runs no git. */
export function gitVerbOfSegment(words: string[]): string | undefined {
  const index = gitVerbIndex(words);
  return index < 0 ? undefined : unquote(words[index] ?? "");
}

/**
 * Did the scan to `index` step over ONLY words the A1 arm vouches for? A1 admits a git
 * read whose verb sits past the selectors AGENTS.md mandates (`git -C <worktree> log`);
 * it refuses one whose verb sits past a switch it has never heard of, because an
 * unrecognised pre-verb switch is a git option this arm has not read.
 */
export function gitPreVerbCleared(words: string[], index: number): boolean {
  for (let i = 1; i < index; i++) {
    const a = unquote(words[i] ?? "");
    if (a === "") continue;
    if (GIT_SANCTIONED_PREVERB.test(a)) {
      // A selector spelled as its own word takes a value; an ATTACHED one carries its
      // own and consumed nothing. Mirrors `hasUnresolvedRepoSelector`'s step-over.
      if (GIT_SANCTIONED_SPACED.test(a)) i++;
      continue;
    }
    return false;
  }
  return true;
}
