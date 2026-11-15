/**
 * lens-review-full-context — the full-branch orientation block a DELTA review
 * shows its lenses (#973, bounded for #2261).
 *
 * A delta review that is also given an explicit base + head wants the whole
 * `git diff <base>...<head>` range for orientation. That block is diff text
 * wearing a context label, and the measured field shape this module exists for
 * was a delta that fit its own bound and still blew six children's context
 * windows, because a ~100 KB branch block rode in BEHIND the bound the review
 * believed it had. A field-local cap cannot bound a prompt: the field stays
 * inside its limit while the prompt does not.
 *
 * So the block is produced as its OWN string rather than appended to the caller's
 * context. `lensPromptFor` receives it and folds it into the prompt's ONE budget
 * beside the delta (`lens-diff-bound.ts`), where what the prompt cannot afford is
 * cut with a notice. `FULL_CONTEXT_CAP` below is the block's own ceiling — a cap
 * on the block, not on the prompt, and the block is cut a second time by the
 * prompt's bound when the two together are too large.
 *
 * Split from `lens-review-diff.ts` for the 500-line gate and because the rule is
 * about how much of a diff a prompt may carry, which is that other module's
 * subject, not the diff-resolution one's.
 */

import { computeRangeDiff } from "./review-diff.ts";

/** The block's own ceiling, kept as the shape the caller used to apply inline. */
export const FULL_CONTEXT_CAP = 100 * 1024;

/**
 * The orientation block, or "" when the range could not be read (a delta review
 * still reviews its delta — orientation is not a precondition).
 *
 * `auto` labels the banner accurately (design decision 6): the delta base is
 * EITHER the automatic one (the latest lens ledger entry's `headSha`) OR an
 * operator-supplied `since`, and the banner must say which — a lens told the base
 * was automatic reasons about what it is missing differently than one told the
 * operator named it.
 */
export async function buildDeltaFullContext(
  cwd: string | undefined,
  base: string,
  head: string,
  since: string,
  auto: boolean,
): Promise<string> {
  const full = await computeRangeDiff(cwd ?? process.cwd(), base, head);
  if (!full.ok) return "";
  const fullDiff =
    full.diff.length > FULL_CONTEXT_CAP
      ? `${full.diff.slice(0, FULL_CONTEXT_CAP)}\n… (truncated — the full branch diff exceeds ${String(FULL_CONTEXT_CAP)} bytes; the findings below cover the delta only)`
      : full.diff;
  const sinceLabel = auto ? "auto: latest lens ledger headSha" : "operator-supplied since";
  return `FULL BRANCH DIFF (context only — the findings below cover the delta since ${since} (${sinceLabel})):\n${fullDiff}`;
}
