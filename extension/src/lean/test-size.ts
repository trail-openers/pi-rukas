#!/usr/bin/env bun
/**
 * lean/test-size — the two size rules a kept acceptance test must satisfy: how
 * MANY files one criterion may end up with across the run, and how LONG each of
 * them may be, including the honest line count that makes the second one real.
 *
 * Split out of `submit-tests-cap.ts` (the boundary that applies them) because
 * they judge the CHILDREN'S work rather than the cost of the call: the numbers,
 * the count and the refusal sentences live here so the prompt that quotes them
 * (`specify-prompt.ts`) and the tests that pin them have one place to import.
 */

/**
 * How many lines one kept acceptance test may have.
 *
 * `TEST_SCOPE_CONTRACT` already asks for the smallest test that proves the criterion, and a prompt obeyed in
 * spirit and not in size still ships a thousand lines.
 *
 * 150 is a measured distribution with room above it — live adversary tests land at about 130 lines even after
 * the child has been shown the refusal reason, so a tighter cap declines real work.
 */
export const MAX_TEST_LINES = 150;

/**
 * How many test files ONE criterion may end up with across the WHOLE RUN.
 *
 * `MAX_TEST_FILES_PER_ROW` bounds one row; a child that spreads the same work over several `submit_tests`
 * calls for one criterion was bounded by nothing. One focused test per criterion is the norm.
 *
 * The bound is per RUN, not per call: a step that validates twice, or a run whose next challenge round starts
 * from what the last one froze, would otherwise multiply the cap by the number of calls. A caller that omits
 * the `frozenByCriterion` seed sees only what its own rows keep.
 */
export const MAX_TEST_FILES_PER_CRITERION = 2;

/**
 * How many BYTES one kept acceptance test may hold.
 *
 * `MAX_TEST_LINES` bounds the count, but the count is only known AFTER the bytes are in memory, and the read
 * that produces them is the one thing this rule should not be paid for on a file it is going to refuse.
 *
 * Checked on the stat the boundary already has, BEFORE the read, which makes it a bound on the CALL as well as
 * the file. Per VALIDATION, not per run: `specify-run.ts` re-checks the bytes it actually holds against this
 * same constant. The capture's own `MAX_CAPTURE_BYTES` is a different, far larger number deliberately.
 */
export const MAX_TEST_BYTES = 24_576;

/** The tail of the not-a-text refusal, shared so the two spellings cannot drift. */
const NOT_TEXT = "is not a text file (NUL byte); an acceptance test is a source file";

/**
 * Why a file the size rule cannot honestly count is not a kept test. A NUL byte is not a line-break question
 * the rule could answer: no acceptance test the harness commits is NUL-bearing, so the file is refused rather
 * than counted — which is also how a UTF-16 file is refused.
 */
export function testNotTextProblem(rel: string): string {
  return `${rel} ${NOT_TEXT}`;
}

/**
 * Lines in a captured test file — the count the size rule judges.
 *
 * `bytes.length` is not it: a 150-line file with no trailing newline has 149
 * `\n`, and the child would be refused for a byte it did not write. So a
 * non-empty final line counts as a line and an empty one does not.
 *
 * Every line break the platforms write ends ONE line — `\r\n`, a lone `\r`, a lone
 * `\n` — so a child cannot dodge the bound by choosing its separator. An empty file
 * is ZERO lines.
 *
 * A NUL byte refuses the count rather than guessing at it, and comes back as `{ notText: true }` rather than a
 * throw: the caller must tell "not a text file" (a drop) from "could not be read at all" (infrastructure).
 */
export function countTestLines(bytes: Buffer): { lines: number } | { notText: true } {
  if (bytes.includes(0)) return { notText: true };
  if (bytes.length === 0) return { lines: 0 };
  let lines = 0;
  let trailing = false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === 10) {
      lines++;
      trailing = true;
    } else if (b === 13) {
      // `\r\n` is ONE break: when the `\r` of a pair is seen, the `\n` that follows is skipped.
      lines++;
      trailing = true;
      if (bytes[i + 1] === 10) i++;
    } else trailing = false;
  }
  return { lines: trailing ? lines : lines + 1 };
}

/** Why an over-long test file is not a kept test — the sentence the boundary states. */
export function testSizeProblem(rel: string, lines: number): string {
  return `${rel} has ${lines} lines; an acceptance test is at most ${MAX_TEST_LINES} — test the criterion, not the code around it, and reuse the project's existing test helpers`;
}

/**
 * Why an oversized test file is not a kept test. Stated from the stat alone, so the file is refused without a
 * read — a rule that had to read it to reject it costs what it exists to cap.
 */
export function testBytesProblem(rel: string, bytes: number): string {
  return `${rel} is ${bytes} bytes; an acceptance test is at most ${MAX_TEST_BYTES} bytes`;
}

/** Why the third (and later) file for one criterion is not kept. */
export function testFileQuotaProblem(criterionId: string): string {
  return `criterion ${criterionId} already has ${MAX_TEST_FILES_PER_CRITERION} test files; one focused test per criterion is the norm`;
}
