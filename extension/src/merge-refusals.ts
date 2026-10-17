/**
 * merge-refusals — everything the merge guard says when it will NOT run a
 * command, split out of merge-allowlist.ts to keep that module a classifier
 * rather than a 500-line module with prose in it.
 *
 * Two families of text live here, and #1417 is the reason they are kept
 * apart:
 *
 *   - a MERGE refusal (the constants + `mergeFormRefusal`): the command really
 *     is a merge, the guard checked it and refused. These name the accepted
 *     form, the condition that failed, and `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`
 *     — an operator who reviewed by other means has a real decision to make.
 *   - a HOLD (`renderHold` + `holdReasonText`): the guard could not read the
 *     command as a merge at all. Nothing merged, no review was skipped, so the
 *     hold NEVER names the hatch. An agent that hits a hold on a `gh api` READ
 *     and is told "issue the merge as a plain `gh pr merge`, or set
 *     PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1" — the old single text, sent twelve
 *     times across two parked cycles — follows it and weakens merge protection
 *     to unblock a read. That is the bug #1417 closes.
 *
 * Both families are here because both are refusal PROSE. The module
 * `renderHold` used to sit in (merge-guard-reads.ts) is about the forge READS
 * the round-cap path performs; a hold is not a read.
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
 *
 * #1417 LOW — `reason` is the BARE code and `detail` its prose, matching
 * `MergeCommand`'s split fields. Callers pass them separately; the `[reason:
 * code — detail]` shape is composed here and nowhere else.
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
    case "too-large":
      return "the command is longer than the bound the guard will read, so nothing in it was analysed";
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

/**
 * Why the guard held a command it could not read as a merge (#1417).
 *
 * `form` — the classifier refused it outright (a trigger it will not read,
 * or a shape outside the merge grammar).
 * `not-a-merge` — the command read like the accepted merge form, but a step
 * before the merge could be confirmed failed (the PR number would not
 * resolve). Nothing has been shown to merge, so this is a hold too.
 */
export type HoldKind = "unanalysable" | "form" | "not-a-merge";

/** The guard's own hold, carrying the text that explains it. */
export interface HoldDetails {
  kind: HoldKind;
  /** What was held, already rendered to prose — never a bare reason code. */
  reasonText: string;
}

/**
 * #1417 — what an agent and an operator actually learn from a hold. Three
 * questions, all answered in the text: what was held, that no review gate
 * was applied, and what to do instead. The escape hatch is NOT among them:
 * `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE` governs the reviews a MERGE must
 * have, and an operator following it to unblock a blocked READ would weaken
 * merge protection to fix something the merge gate was never protecting.
 * The hatch appears in guard refusals only where the command really is a
 * merge (see the constants above and the post-`readMergeTarget` refusals).
 *
 * The held text is clamped at the source rather than left to the console:
 * truncation is exactly what made `[reason: body-ind…]` useless, so nothing
 * load-bearing may depend on a terminal rendering the whole string.
 */
export function renderHold(details: HoldDetails, held: string): { block: true; reason: string } {
  const quote = held.length > 160 ? `${held.slice(0, 160)}…` : held;
  const what =
    details.kind === "unanalysable"
      ? "the merge guard could not read this command at all"
      : details.kind === "not-a-merge"
        ? "the merge guard held this command before confirming it merges anything"
        : "the merge guard held this command because it could not read it as a merge";
  const why =
    details.kind === "unanalysable"
      ? "nothing ran, because a command the guard cannot analyse is refused by default"
      : "nothing was merged, and no review gate was applied to it";
  const how =
    details.kind === "unanalysable"
      ? "split it into simple commands, or run the forge read on its own"
      : details.kind === "not-a-merge"
        ? "name the PR/MR number in the merge command (`gh pr merge <N>` / `glab mr merge <N> --auto-merge=false`); a read needs nothing from the guard"
        : "run the merge as one plain `gh pr merge <N>` / `glab mr merge <N> --auto-merge=false`, on its own; run a read on its own";
  return {
    block: true,
    reason: `command held (not a merge): ${what} — ${details.reasonText}. ${why}; this hold is not a review gate, and the merge escape hatch would not unblock it. ${how}. The shape the guard does check is ${ACCEPTED_MERGE_FORM}. If this command is genuinely not a merge, report it as a false hold — the guard's classifier is the thing to fix, not the reviews. Held command: ${JSON.stringify(quote)}`,
  };
}

/**
 * #1417 LOW — the one place a classifier refusal becomes prose, so the guard
 * and the hold-text test compose the sentence the same way. `code` is the
 * bare token a test or doc cites; `detail` is what was held. A refusal whose
 * code carries its clause inline cannot be compared exactly by anything
 * downstream, which is why the two are passed to `renderHold` as separate
 * halves rather than as one string.
 *
 * A trigger whose `code` is `""` is an ordinary trigger the grammar judged,
 * not a rule that refused on its own: it has no code to name, so the detail
 * stands alone.
 */
export function holdReasonText(code: string | undefined, detail?: string): string {
  const clause = detail === undefined || detail.length === 0 ? "" : detail;
  if (code === undefined || code.length === 0) {
    return clause === ""
      ? "merge-adjacent text it could not match to the one plain merge form the guard checks"
      : clause;
  }
  const how = clause === "" ? heldHow(code) : clause;
  return `a \`${code}\` shape: ${how}`;
}
