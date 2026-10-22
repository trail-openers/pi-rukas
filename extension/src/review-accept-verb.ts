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

/**
 * ONE table of git's pre-verb value-taking options. Three questions are asked of it and
 * they MUST agree, which is why they are not three regexes (#1764 fix round 3, H3):
 *
 *  - `gitVerbIndex` steps over the option AND its value, or `git -C /repo log` answers
 *    `/repo` where the verb belongs;
 *  - `gitPreVerbCleared` decides whether the A1 read arm may step over it at all;
 *  - `hasUnresolvedRepoSelector` (in `review-accept-selector.ts`) decides whether its
 *    value can be CLEARED — read well enough to name the repository the run uses.
 *
 * The defect this closes was the first two lists carrying `--namespace`, `--super-prefix`
 * and `--config-env` while the third never heard of them: the verb scan stepped over an
 * unresolved `--namespace $NS` value, and the audit that was supposed to keep such an
 * option in scope had no rule for it.
 */
export interface GitOptionSpec {
  /** The bare spelling, matched case-insensitively against the option word. */
  readonly name: string;
  /** Does the spaced spelling take the NEXT word as its value? */
  readonly takesValue: boolean;
  /** May the guard ever CLEAR this option — read its value well enough to vouch for it?
   * `false` is the conservative answer: the option keeps the command in scope and keeps
   * the read arm from admitting it, whatever its value spells. */
  readonly clearable: boolean;
}

export const GIT_OPTIONS: readonly GitOptionSpec[] = [
  // `-C <path>` is the worktree form AGENTS.md mandates and its value is a path the target
  // test reads; `-c key=value` is a config the program then RUNS, which the selector's own
  // value test refuses. One row, because git spells them alike once the segment is folded.
  { name: "-c", takesValue: true, clearable: true },
  // The three repo-location selectors: they move the object store / work tree the read
  // runs against, or shadow `git-shell`, and are never cleared (#1643 Decision 1).
  { name: "--git-dir", takesValue: true, clearable: false },
  { name: "--work-tree", takesValue: true, clearable: false },
  { name: "--exec-path", takesValue: true, clearable: false },
  // Three more git options whose value the guard reads the same way it reads a `-C`
  // target: a ref namespace, a super-prefix that rewrites every path git reports, and a
  // config value named by an ENVIRONMENT variable. A value the guard can resolve into a
  // plain word clears (`git --namespace refs/heads/x log` is a branch, not a path); an
  // unresolved one — an expansion, a glob, a `..`, anything reaching `.git`, or a
  // `key=value` config the program then runs — keeps the command in scope and keeps the
  // read arm from admitting it. Before this table they were stepped over by the verb scan
  // and unknown to the audit, which is how `git --namespace $NS log` read as a plain log.
  { name: "--namespace", takesValue: true, clearable: true },
  { name: "--super-prefix", takesValue: true, clearable: true },
  { name: "--config-env", takesValue: true, clearable: true },
];

/** The option names the table knows, in regex-alternation form. Exported so
 * `review-accept-selector.ts` builds its own two regexes from the SAME rows — the audit
 * and the step-over are one table or they are two chances to disagree (#1764 H3). */
export function gitOptionNames(where: (spec: GitOptionSpec) => boolean): string {
  return GIT_OPTIONS.filter(where)
    .map((spec) => spec.name)
    .join("|");
}

/** git's global options whose value is a SEPARATE word: the scan steps over the value too,
 * or `git -C /repo log` would answer `/repo` where the verb belongs. */
const GIT_GLOBAL_VALUE_OPTION = new RegExp(`^(?:${gitOptionNames((s) => s.takesValue)})$`, "i");
/** The ONLY words A1 steps over on the way to its verb: the valueless switch it already
 * spells, another `git`, an empty word, and the repo-location / config selectors whose
 * VALUE `hasUnresolvedRepoSelector` has read with its target. Anything else standing
 * before the verb (`--paginate`, an unknown switch, a selector no value can clear) is a
 * word this arm has not vouched for, so the arm refuses rather than step over it (#1764
 * fix round: the step-over audit lives beside the reader, where the two cannot disagree). */
const GIT_SANCTIONED_PREVERB = new RegExp(
  `^(?:git|--no-pager|${gitOptionNames((s) => s.clearable)})(?:$|[=:/,.\-])`,
  "i",
);
/** Among the sanctioned words, the ones whose value is the NEXT word — the step-over the
 * audit mirrors, derived from the same `takesValue` column the verb scan reads. */
const GIT_SANCTIONED_SPACED = new RegExp(
  `^(?:${gitOptionNames((s) => s.clearable && s.takesValue)})$`,
  "i",
);

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
