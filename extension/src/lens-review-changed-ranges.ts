/**
 * lens-review-changed-ranges — reading the PR's changed LINES for the advisory
 * split (lens-review-advisory.ts, #1125 decision 1), split out so the split
 * module stays a rule and not a git wrapper.
 *
 * The range is `git diff <base>...<head>`. The base arrives from the review —
 * its explicit `base`, or the base the diff itself was computed against — and
 * only when NEITHER is known does this ask for the mainline: that resolution
 * shells out to the forge CLI, so it is the last resort, not the first, and an
 * environment where it is unavailable must not turn every round fail-closed.
 * The raw diff text goes to `changedLineRanges` (review-diff.ts), the same
 * parser the delta path uses, so both read one definition of "changed line".
 * The caller may instead hand the split the DIFF THE REVIEW COMPUTED ITSELF (the
 * #859 rule: the value the lenses saw is the value the split judges — but only
 * when the review produced it, never a string a caller pasted; see
 * lens-review-advisory.ts), and the git read below is the source for every other
 * shape: a pasted diff, a delta's own range, or a review with no diff string, the
 * range then being the one that diff was computed from.
 *
 * RENAME HANDLING IS ONE RULE FOR BOTH PATHS. `RANGE_ARGS` passes `--no-renames`
 * and the review's own computed diff (`computeRangeDiff` in review-diff.ts)
 * passes no rename flag either, so git's default rename detection already splits
 * a rename into a deletion plus an addition on BOTH reads — the git range and the
 * diff the review computed. A pure rename therefore contributes no changed lines
 * on the new side whichever source the split used; the two paths cannot disagree
 * about a renamed file. `test-lens-review-advisory.ts` pins the shape against
 * real git rather than against a pasted string.
 *
 * A ref beginning with `-` would be parsed by git as an option, so such a name
 * is refused as unreadable rather than passed on the argv. Failure is
 * discriminated, never swallowed: the caller distinguishes "the range says X"
 * from "the range could not be read", because the second must fail closed
 * (every finding blocks) while the first may discount.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveMainlineBase } from "./review-delta-hunks.ts";
import { DIFF_MAX_BUFFER, changedLineRanges, diffOverflow } from "./review-diff.ts";

const execFileP = promisify(execFile);

/** The read every range gets: `-U0` (the split wants hunk headers, not
 * context), and no rename/collision/ext-diff rewriting, so the paths and the
 * line numbers are the ones the findings cite. Bounded and timed like the
 * review's own diff reads — a hung git is a failed read, never a hung round. */
const RANGE_ARGS = ["-U0", "--no-renames", "--no-color", "--no-ext-diff"];
const RANGE_TIMEOUT_MS = 30_000;

/** The changed LINES a `git diff <range>` produced, or the reason they could
 * not be read. Shared by the fallback range read below and by the caller that
 * already holds the diff the review ran (lens-review-advisory.ts), so both
 * discriminate the same three failures the same way: unreadable refs, a cut
 * tail, and a diff that yields no file sections. */
export function rangesFromDiff(
  stdout: string,
  range: string,
): { ok: true; ranges: Map<string, Array<[number, number]>> } | { ok: false; reason: string } {
  const ranges = changedLineRanges(stdout);
  if (ranges.size === 0) {
    // Neither shape is "nothing changed": an EMPTY diff is a read that produced
    // no evidence (a full review blocks on an empty range, #384, so one never
    // legitimately reaches the split), and a non-empty diff with no file sections
    // is a diff this parser could not read — the `unparseable` rule of
    // review-delta-hunks.ts, applied to the same shape. Both fail closed.
    return { ok: false, reason: `the range diff (${range}) yielded no changed lines` };
  }
  return { ok: true, ranges };
}

/** The PR's changed line ranges, or the reason they could not be read. */
export async function changedRanges(
  cwd: string,
  base: string | undefined,
  head: string | undefined,
): Promise<
  { ok: true; ranges: Map<string, Array<[number, number]>> } | { ok: false; reason: string }
> {
  const b = base ?? (await resolveMainlineBase(cwd));
  if (!b) return { ok: false, reason: "no base ref resolves (no explicit base, no mainline)" };
  if (!head) return { ok: false, reason: "the reviewed head did not resolve to a commit" };
  // A ref beginning with '-' would be parsed by git as an option (argument
  // injection); such a name is never a legitimate ref here.
  if (b.startsWith("-") || head.startsWith("-")) {
    return { ok: false, reason: `ref "${b.startsWith("-") ? b : head}" starts with '-'` };
  }
  const range = `${b}...${head}`;
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "diff", ...RANGE_ARGS, range], {
      maxBuffer: DIFF_MAX_BUFFER,
      timeout: RANGE_TIMEOUT_MS,
    });
    return rangesFromDiff(stdout, range);
  } catch (err) {
    const e = err as Error & { stderr?: string };
    // A tail cut at the cap is a truncated diff, and a truncated diff would
    // silently discount the findings past the cut. It is a failed read.
    if (diffOverflow(e?.stderr ?? "")) {
      return { ok: false, reason: `git diff ${range} exceeded the ${DIFF_MAX_BUFFER} byte cap` };
    }
    return {
      ok: false,
      reason: `git diff ${range} failed: ${(e?.message ?? String(err)).slice(0, 200)}`,
    };
  }
}

/** The base the review's own diff was computed against, when it knows one: the
 * automatic/explicit delta's `since`, which IS the base of the range it covers.
 * Undefined for a caller-supplied diff string or a full-branch review, where
 * the review carries no base to hand on. */
export function diffBaseOf(resolved: {
  kind: string;
  base?: string;
  delta?: { since?: string };
}): string | undefined {
  return resolved.kind === "ok" ? (resolved.delta?.since ?? resolved.base) : undefined;
}

/** The range a round's changed lines are ABOUT, in the reason text: always the
 * PR's three-dot `base...head`, including on a delta round — blocking is
 * measured against the whole PR, never against the delta's own range. */
export function rangeLabel(
  cwd: string,
  base: string | undefined,
  head: string | undefined,
): string {
  return `${base ?? "<mainline>"}...${head ?? "<unresolved head>"} (in ${cwd})`;
}
