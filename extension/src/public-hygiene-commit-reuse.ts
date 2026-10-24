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
 */

import { REUSED_MESSAGE_REASON, commitCluster } from "./public-hygiene-commit-flags.ts";

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
export function commitMessageReuse(argv: readonly string[]): boolean {
  for (const w of argv) {
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
