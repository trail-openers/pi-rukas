/**
 * public-hygiene-substitution — a publish in a command that ALSO contains a
 * shell expansion is a publish whose text this guard cannot vouch for (#1788).
 *
 * ## Why there is no longer a walker here
 *
 * An earlier shape of this module walked the raw command modelling quotes,
 * substitution depth, backticks and segment cuts, and asked its publish test of
 * each segment. Nine defects came back from the final review of that design, all
 * of one class — unquoted backslashes, `$` and backticks inside single quotes, a
 * stray `)` making the depth negative, only the head of a chain checked,
 * newlines cut inside quotes, and an apostrophe-gated tail rule. Modelling shell
 * quoting *is* the defect class: every fix is one more character bash treats
 * specially, and every miss is a publish that walks out unchecked.
 *
 * ## The quote-free rule
 *
 * Ask two things of the WHOLE command and never look at a quote:
 *
 * 1. does the command carry a publish surface (the signal
 *    `scanPublishSurfaces` already computes for gh text flags, gh api write
 *    fields and git commit messages, with the `oo`/`NAME=value` prefix skip
 *    included), and
 * 2. does its raw text contain any expansion anywhere — `$(`, a backtick, `<(`,
 *    `>(`, `${`, `$NAME`?
 *
 * Both true is one problem on the first publish surface — one per command, not
 * one per occurrence: the command text carries no information about WHERE the
 * expansion sits (that is precisely what the deleted model tried and failed to
 * work out), so a count would be a number nobody can verify. The guard refuses
 * on the first problem it holds, so one honest problem is the whole verdict.
 * The rule is sound because bash expands inside double quotes, unquoted and
 * inside backticks alike, so a command that both publishes and contains an
 * expansion cannot be shown, from its text alone, to have published the
 * expansion's result anywhere harmless.
 *
 * ## The trade-off, stated once
 *
 * A single-quoted literal that merely *contains* one of those sequences —
 * `--body 'a $(b) is mentioned above'` — is refused. Single quotes never expand,
 * so this is a false positive, and it is deliberate: round 1 already accepted
 * refusing a single-quoted `$(`, the alternative is a quote model with the nine
 * holes above, and the remedy the refusal names is cheap — pass the text with
 * `--body-file` (or `-F field=@file`). Documented in docs/troubleshooting.md
 * under the #1788 entry.
 */

/** Every sequence bash expands, as it appears in the raw command text. */
const EXPANSION = /\$\(|`|<\(|>\(|\$\{|\$[A-Za-z_]/;

/** Does this command text contain an expansion whose result nothing can read? */
export function containsShellExpansion(raw: string): boolean {
  return EXPANSION.test(raw);
}

/**
 * The problem a publishing command with an expansion earns, or `undefined` when
 * either half is missing. `publishLocation` is the caller's first publish
 * surface — the location the scan already used for its own texts — so the
 * refusal names the text at stake instead of inventing a label, and stays
 * `undefined` (never a guessed "body") when the command publishes nothing.
 */
export function shellExpansionProblem(
  raw: string,
  publishLocation: string | undefined,
  reason: string,
): { location: string; reason: string } | undefined {
  if (publishLocation === undefined) return undefined;
  if (!containsShellExpansion(raw)) return undefined;
  return { location: publishLocation, reason };
}
