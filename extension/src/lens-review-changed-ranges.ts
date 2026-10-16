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
import { changedLineRanges } from "./review-diff.ts";

const execFileP = promisify(execFile);

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
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "diff", `${b}...${head}`], {
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, ranges: changedLineRanges(stdout) };
  } catch (err) {
    const why = ((err as Error)?.message ?? String(err)).slice(0, 200);
    return { ok: false, reason: `git diff ${b}...${head} failed: ${why}` };
  }
}

/** The base the review's own diff was computed against, when it knows one: the
 * automatic/explicit delta's `since`, which IS the base of the range it covers.
 * Undefined for a caller-supplied diff string or a full-branch review, where
 * the review carries no base to hand on. */
export function diffBaseOf(resolved: { kind: string; delta?: { since?: string } }):
  | string
  | undefined {
  return resolved.kind === "ok" ? resolved.delta?.since : undefined;
}
