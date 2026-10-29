#!/usr/bin/env bun
/**
 * lean/submit-tests-cap — the two bounds a `submit_tests` call carries, and
 * the per-call memo the base-commit newness probe runs through.
 *
 * Split out of `specify-tree.ts` because both halves exist for one reason: the
 * rule set over a submitted path is cheap, but the newness rule is a git read,
 * and both the number of names in a row and the number of rows in a call come
 * from an untrusted child. `validateSubmitRows` applies the rules; this module
 * owns what the call is allowed to spend answering them.
 */

/**
 * How many test files one submitted row may name.
 *
 * The boundary runs its whole rule set — including a git read per path — over
 * every name a row carries, and a row comes from an untrusted child. An
 * unbounded list is an unbounded number of git calls from one tool call, so the
 * row is refused outright rather than processed: a criterion genuinely needs a
 * handful of files, and the cap is not close to that.
 *
 * It counts the files of ONE row (one `submit_tests` call for one criterion),
 * not the files a criterion ends up with: a child that legitimately needs more
 * makes more calls, and each row is judged on its own.
 */
export const MAX_TEST_FILES_PER_ROW = 8;

/**
 * How many DISTINCT test paths one `submit_tests` call may get probed for.
 *
 * The row cap bounds one row; it does not bound the call, and a call carries
 * any number of rows. The newness rule costs one git read per distinct path,
 * so 3,000 rows of 8 names would be 24,000 git reads from a single tool call.
 * The memo's size is the count that matters: git is asked about each distinct
 * normalised path once, so the call is bounded where the work actually costs.
 * A real submission names a handful of files for a handful of criteria; once
 * the call passes this many distinct paths the surplus is refused without a
 * probe, so exceeding the bound is free.
 */
export const MAX_TEST_FILES_PER_CALL = 32;

/**
 * A memoised `existsAtBase` for ONE boundary call, plus the count of distinct
 * paths it has actually asked git about.
 *
 * One git read per distinct path per call, not per mention: two rows (or one
 * row twice) naming `tests/AC1-x.test.ts` used to ask the base twice about the
 * same name. The answer is a fact about (base, rel), so one call's cache is
 * exactly as fresh as the tree it reads — and it must not outlive the call,
 * because between two calls the step may have committed, and a stale "new" is
 * the fraud the rule exists to refuse.
 *
 * `probed` is what the call cap counts against: `has(rel)` distinguishes a
 * name already asked about (free, and must stay free) from a new one, which is
 * only allowed while `probed` sits under `MAX_TEST_FILES_PER_CALL`.
 */
export function baseProbe(existsAtBase: ((rel: string) => Promise<boolean>) | undefined): {
  ask: ((rel: string) => Promise<boolean>) | undefined;
  has: (rel: string) => boolean;
  probed: () => number;
} {
  const answers = new Map<string, Promise<boolean>>();
  return {
    ask:
      existsAtBase === undefined
        ? undefined
        : (rel: string): Promise<boolean> => {
            const hit = answers.get(rel);
            if (hit !== undefined) return hit;
            const asked = existsAtBase(rel);
            answers.set(rel, asked);
            return asked;
          },
    has: (rel: string) => answers.has(rel),
    probed: () => answers.size,
  };
}
