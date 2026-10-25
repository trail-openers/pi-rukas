/**
 * public-hygiene-commit-reuse — the `git commit` forms whose message comes from
 * somewhere the guard will never read (#1792), split out of
 * `public-hygiene-commit-flags.ts` along the seam AGENTS.md §12 asks for (that
 * module owns the bundled-cluster grammar; this owns the reuse verbs).
 *
 * ## Two families, one refusal
 *
 * - `-c` / `-C` / `--reuse-message` / `--reedit-message` take a COMMIT whose
 *   message git copies. `commitCluster` already answers for a bundled cluster
 *   (`-ac`, `-qc`) through `CommitCluster.reuses`, and {@link commitMessageReuse}
 *   asks it rather than re-deriving letters.
 * - `--squash <commit>` / `--squash=<commit>` and `--fixup <commit>` /
 *   `--fixup=<form>:<commit>` (forms `amend`, `reword`, or bare) take their
 *   message from ANOTHER commit too — `--fixup` builds "amend! ..." /
 *   "reword! ..." out of that commit's subject, and `--squash` composes the
 *   messages of the commits being squashed. No text in the command is the
 *   message, so there is nothing to scan and no surface to name.
 *
 * Both are refused with {@link REUSED_MESSAGE_REASON}, from the one function
 * below, so the reuse rule has a single owner: a reader that asked each form
 * separately is how `-c` was refused while `--squash` published a message
 * nobody had read.
 *
 * ## Where the question is asked: AFTER the verb (#1820)
 *
 * git reads its OWN global options before the verb — `-C <dir>`, `-c k=v`,
 * `--git-dir=…`, `--work-tree …` — and two of them are spelled exactly like the
 * reuse letters. Scanning every word made `git -C /tmp commit -m hello` read as
 * `git commit -C <commit>`, so every agent's `git -C <worktree> commit -m …` was
 * refused as "message comes from another commit". The rule is now positional:
 * the words before `commit` are git's, the words after it are commit's, and this
 * reader asks only the second set. Where the verb is found is decided by
 * {@link gitVerb} — the hygiene guard's existing skipper for git's globals, the
 * one place that knows which of them take a value as a SEPARATE word (`-C <dir>`,
 * `-c k=v`) and must consume their follower. A second option parser would have
 * disagreed with it about `--git-dir`.
 *
 * Fail-closed is kept: a verb that cannot be located — an argv that is not a git
 * commit at all, or one where git's globals never terminate (`git -C`, with no
 * directory and no verb) — answers REUSE, today's answer for anything unreadable.
 * The cost of that branch is a refused command, never a publish nobody read.
 *
 * The argv a publish reader hands in begins at the PROGRAM word — the scan's
 * `publishArgv` has already stripped wrappers (`sudo`) and `NAME=value`
 * prefixes — which is the shape {@link gitVerb} expects.
 */

import { publishArgv } from "./public-hygiene-command.ts";
import { REUSED_MESSAGE_REASON, commitCluster } from "./public-hygiene-commit-flags.ts";
import { gitVerb } from "./public-hygiene-target.ts";

/** The long flags whose value is a COMMIT whose message git reuses. */
const REUSE_COMMIT_FLAGS = ["--reuse-message", "--reedit-message", "--squash", "--fixup"] as const;

/**
 * Does `w` use one of {@link REUSE_COMMIT_FLAGS}? The bare flag, the glued LONG
 * form (`--squash=abc12`, `--fixup=amend:HEAD`), and nothing shorter — a word
 * that merely starts with the flag's name is a different flag, which is why the
 * glued form is `=`-delimited.
 */
function usesReuseCommitFlag(w: string): boolean {
  for (const flag of REUSE_COMMIT_FLAGS) {
    if (w === flag || w.startsWith(`${flag}=`)) return true;
  }
  return false;
}

/**
 * Is this `git commit` argv a message-reuse form? `-c`/`-C` (bare, glued, or
 * bundled into a cluster), `--reuse-message`/`--reedit-message`, `--squash` and
 * `--fixup` all answer yes; `--no-edit` and every other `--no-*` switch do not.
 *
 * A BUNDLED cluster is NOT re-derived here — the cluster grammar in
 * `public-hygiene-commit-flags.ts` is the single owner of what a bundled word
 * means and answers through `CommitCluster.reuses`.
 */
/**
 * The words of a `git commit` that belong to the COMMIT, i.e. everything after
 * the `commit` verb, or undefined when there is no locatable `commit` verb.
 *
 * The program word is checked before the verb is sought: `commit` is an ordinary
 * word in `docker run myimage commit -m x`, and reading the words after it as
 * commit flags would be a claim about a command that never ran git.
 */
function argvAfterCommitVerb(argv: readonly string[]): string[] | undefined {
  const words = publishArgv(argv);
  const program = words[0] ?? "";
  if (!program.endsWith("git") || program === "") return undefined;
  const at = gitVerbIndex(words);
  return at === undefined ? undefined : words.slice(at + 1);
}

/** The index of the verb, i.e. the last word {@link gitVerb} skipped over. */
function gitVerbIndex(words: readonly string[]): number | undefined {
  const verb = gitVerb(words);
  if (verb === undefined) return undefined;
  // A duplicate is not a bug: the verb is the FIRST non-flag word git's own
  // skipper stopped at, and `lastIndexOf` locates exactly that word when it also
  // reappears later as an operand (`git commit commit -C HEAD`).
  return verb === "" ? undefined : words.lastIndexOf(verb);
}

export function commitMessageReuse(argv: readonly string[]): boolean {
  // Only the words AFTER the verb belong to `git commit`. Before it sit git's own
  // globals, whose `-C`/`-c` are a directory and a config pair, not reuse flags.
  const words = argvAfterCommitVerb(argv);
  if (words === undefined) return true;
  for (const w of words) {
    // `--reuse-message=<ref>` / `--squash=<ref>` are reuse; `--no-edit` and
    // every other `--no-*` switch are not, and are excluded by NAME — an
    // ordinary `git commit --amend --no-edit` reuses the CURRENT message the
    // guard has no reason to refuse, and a substring test would refuse it.
    if (usesReuseCommitFlag(w)) return true;
    if (/^--no-/.test(w)) continue;
    if (w === "-c" || w === "-C") return true;
    // `-c<ref>` glued is the one shape the cluster grammar does NOT reach: it is
    // shorter than a cluster (`-c` is two characters) and its tail is a REF, not a
    // message. Every other bundled word is answered by the cluster reader, so
    // this function asks it once instead of re-deriving what letters mean.
    if (w.length > 2 && (w.startsWith("-c") || w.startsWith("-C"))) return true;
    if (commitCluster(w)?.reuses === true) return true;
  }
  return false;
}

/**
 * The refusal a reuse form contributes to the scan. Kept as one constant in
 * `public-hygiene-commit-flags.ts` (every reader pushes the same string, and a
 * second copy would let the two halves of the rule say different things);
 * re-exported here so a caller that asks the question can name the answer.
 */
export { REUSED_MESSAGE_REASON };
