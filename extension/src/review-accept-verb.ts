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
 * Split from `review-accept-command.ts` because that module — the command-text readers —
 * is at the §12 file-size cap and this is a self-contained seam of its own: no arm and no
 * scope test composes the two questions, and neither imports the other through here.
 */

import { baseName, unquote } from "./review-accept-command.ts";

/** git's pre-verb switches — global in position, valueless, and never the verb. */
const GIT_PREAMBLE = /^(?:--no-pager|--paginate|--html-path|--man-path|--info-path)$/i;
/** git's global options whose value is a SEPARATE word: the scan steps over the value too,
 * or `git -C /repo log` would answer `/repo` where the verb belongs. */
const GIT_GLOBAL_VALUE_OPTION =
  /^(?:-c|--git-dir|--work-tree|--exec-path|--namespace|--super-prefix|--config-env)$/i;

/**
 * The verb of ONE command segment, or undefined when the segment runs no git: the first BARE
 * word after the leading `git`, with the pre-verb switches and the spaced global values
 * stepped over. An option-shaped word (`-a`, `-f`, `--stdin`) is a flag and the scan moves
 * on. A QUOTED verb still counts — `unquote` reads `"apply"`, and that is the spelling the
 * shell hands git as its verb.
 *
 * The verb is a POSITION and the program is the segment HEAD, the way every arm reads it:
 * `echo patch | git apply -` is the segment `git apply -` once `armsOf` has cut it, while a
 * prose line that merely mentions `git rm` in its middle names no verb.
 */
export function gitVerbOfSegment(words: string[]): string | undefined {
  if (baseName(unquote(words[0] ?? "")) !== "git") return undefined;
  for (let i = 1; i < words.length; i++) {
    const a = unquote(words[i] ?? "");
    if (GIT_PREAMBLE.test(a)) continue;
    if (GIT_GLOBAL_VALUE_OPTION.test(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}
