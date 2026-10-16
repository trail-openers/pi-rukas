/**
 * merge-refusals — the texts the merge guard shows when it will NOT run a
 * merge command, split out of merge-allowlist.ts to keep that module a
 * classifier rather than a 500-line module with prose in it.
 *
 * Two families of text live in this area, and #1417 is the reason they are
 * kept apart:
 *
 *   - a MERGE refusal (these two constants): the command really is a merge,
 *     the guard checked it and refused. These name the accepted form, the
 *     condition that failed, and `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE` —
 *     an operator who reviewed by other means has a real decision to make.
 *   - a HOLD (`renderHold` in merge-guard-reads.ts): the guard could not read
 *     the command as a merge at all. Nothing merged, no review was skipped,
 *     so the hold NEVER names the hatch. An agent that hits a hold on a
 *     `gh api` READ and is told "issue the merge as a plain `gh pr merge`, or
 *     set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1" — the old single text, sent
 *     twelve times across two parked cycles — follows it and weakens merge
 *     protection to unblock a read. That is the bug #1417 closes.
 */

/** The one merge shape the guard will check, quoted verbatim in every refusal. */
export const ACCEPTED_MERGE_FORM =
  "`gh [-R OWNER/REPO] pr merge [N] [flags]` or `glab [-R GROUP/REPO] mr merge [N] [flags]`, run on its own";

/** The shapes the accepted form excludes — the "what to change" half. */
const HOLD_FORM_TEXT = `the guard checks exactly one shape: ${ACCEPTED_MERGE_FORM}: no pipes, chains, substitutions, variables, wrappers (env/sudo/nice/time/exec/oo), \`bash -c\`, \`eval\`, \`gh api\`/curl REST or GraphQL merges, no request body read from a file, stdin or a shell expansion, no deferred \`--auto\` merge`;

/** The refusal for a glab merge that does not opt out of deferred auto-merge. */
export const GLAB_AUTO_MERGE_REFUSAL =
  "merge refused: `glab mr merge` without `--auto-merge=false` queues a deferred auto-merge when the pipeline is still running, so it can merge commits pushed after the review. Use the accepted form, run on its own: `glab mr merge <N> --auto-merge=false` (or `glab -R GROUP/REPO mr merge <N> --auto-merge=false`). Operator override: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1";

/** The guard's merge refusal for a triggered command outside the grammar. */
export const MERGE_FORM_REFUSAL = `merge refused: the merge guard checks only one plain merge command — ${HOLD_FORM_TEXT}. A command that names gh/glab/curl/an interpreter and the word \`merge\` anywhere (even in prose) is held to this form: put a PR or comment body in a file (\`--body-file <file>\`) and a commit message in \`git commit -F <file>\`. Operator override: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1`;

/**
 * The merge refusal, with the reason code and the clause that says what to
 * change (#1417: the bare code was truncated in the console and never
 * explained itself, so `[reason: body-ind…]` taught nobody anything).
 */
export function mergeFormRefusal(reason?: string, detail?: string): string {
  if (reason === undefined) return MERGE_FORM_REFUSAL;
  const why = detail === undefined || detail.length === 0 ? heldHow(reason) : detail;
  return `${MERGE_FORM_REFUSAL} [reason: ${reason} — ${why}]`;
}

/**
 * How a reason code got its name, for a refusal that carries no per-command
 * detail. The codes stay the stable names tests and docs cite; the clause
 * after the dash is what the reader needs in order to change the command.
 */
function heldHow(code: string): string {
  switch (code) {
    case "expansion-command-word":
      return "the command word is an expansion, quote or escape, so the tool bash would exec is not readable here";
    case "body-indirect":
      return "a forge/HTTP request reads its body from a file, stdin or a shell expansion, so the guard cannot see what it sends";
    case "brace-expansion":
      return "a brace pattern bash would expand sits beside a forge word, so the verb is not readable here";
    case "not-a-forge-command":
      return "a forge word and a merge word appear together but the command does not begin with `gh` or `glab`, so it is not a merge the guard can check";
    case "glab-auto-merge":
      return "the merge is a deferred auto-merge";
    case "quote-unbalanced":
      return "an unbalanced quote";
    case "control-or-non-ascii":
      return "a control or non-ASCII character";
    default:
      return `its shape is outside the merge grammar (${code})`;
  }
}

/** What a `lex` failure code means, for the refusal that names it. */
export function lexedWhy(code: string): string {
  if (code === "quote-unbalanced") return "an unbalanced quote";
  if (code === "control-or-non-ascii") return "a control or non-ASCII character";
  return `a character the strict merge grammar forbids (${code})`;
}
