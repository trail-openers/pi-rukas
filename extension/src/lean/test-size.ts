#!/usr/bin/env bun
/**
 * lean/test-size — the two size rules a kept acceptance test must satisfy: how
 * MANY files one criterion may end up with across the run, and how LONG each of
 * them may be, including the honest line count that makes the second one real.
 *
 * Split out of `submit-tests-cap.ts` (the boundary that applies them) because
 * they judge the CHILDREN'S work rather than the cost of the call: what a run
 * freezes is a property of the tests, and a thousand lines of them is the
 * failure these rules exist to refuse. The boundary keeps the rule set over a
 * submitted path; the numbers, the count and the three refusal sentences live
 * here, so the prompt that quotes them (`specify-prompt.ts`) and the tests that
 * pin them have one place to import.
 */

/**
 * How many lines one kept acceptance test may have.
 *
 * A real trial froze ~1,000 lines of tests for a 15-line change, in four files
 * of ~100 lines each that re-implemented the same harness. The tests were
 * correct and the PR was unmergeable, which is what a deterministic rule is
 * for: `TEST_SCOPE_CONTRACT` already asks for the smallest test that proves the
 * criterion, and a prompt that is obeyed in spirit and not in size still ships
 * a thousand lines. 120 is the size of a focused test of one criterion written
 * against the project's own helpers; a file past it is testing the code around
 * the criterion.
 */
export const MAX_TEST_LINES = 120;

/**
 * How many test files ONE criterion may end up with across the WHOLE RUN.
 *
 * `MAX_TEST_FILES_PER_ROW` bounds one row; a child that spreads the same work
 * over several `submit_tests` calls for one criterion was bounded by nothing.
 * The rows are judged together here, which is the number that matters: a
 * criterion has one criterion, and one focused test per criterion is the norm.
 *
 * The bound is per RUN, not per call: a `submit_tests` call is not the unit the
 * rule is about, and a step that validates twice — or a run whose next challenge
 * round starts from what the last one froze — would otherwise multiply the cap
 * by the number of calls. `validateSubmitRows`' `frozenByCriterion` opt seeds
 * each criterion's count from what the run already holds, so the frozen files
 * consume the quota and a criterion that is full from the record keeps nothing
 * new. A caller that omits the seed sees only what its own rows keep, which is
 * what a unit test with no run behind it has.
 */
export const MAX_TEST_FILES_PER_CRITERION = 2;

/**
 * How many BYTES one kept acceptance test may hold.
 *
 * `MAX_TEST_LINES` bounds the count, but the count is only known AFTER the
 * bytes are in memory, and the read that produces them is the one thing this
 * rule should not be paid for on a file it is going to refuse. A line count is
 * not a size: 120 lines of 200 characters is 24 KiB, and the trial that froze a
 * thousand lines of test froze them in files nobody could read in one screen.
 * 16 KiB is a focused test of one criterion written against the project's own
 * helpers — comfortably above any file that fits the line bound honestly.
 *
 * The bound is checked on the stat the boundary already has, BEFORE the read,
 * which is what makes it a bound on the CALL as well as on the file: at most
 * `MAX_TEST_FILES_PER_CRITERION` files per criterion are ever read, each at
 * most this many bytes, so one validation reads no more than that product in
 * total. The capture's own `MAX_CAPTURE_BYTES` is a different, far larger
 * number, and deliberately so: that one bounds what a run keeps, this one what
 * a rule will even look at.
 */
export const MAX_TEST_BYTES = 16_384;

/** The tail of the not-a-text refusal, shared so the two spellings cannot drift. */
const NOT_TEXT = "is not a text file (NUL byte); an acceptance test is a source file";

/**
 * Why a file the size rule cannot honestly count is not a kept test.
 *
 * A NUL byte is not a line-break question the rule could answer: no acceptance
 * test the harness commits is a NUL-bearing file, so the file is refused rather
 * than counted — which is also how a UTF-16 file is refused. Its line breaks
 * (`0x0A 0x00`) would count as far too few lines, and an honest count is the
 * only thing this rule is worth.
 */
export function testNotTextProblem(rel: string): string {
  return `${rel} ${NOT_TEXT}`;
}

/**
 * Lines in a captured test file — the count the size rule judges.
 *
 * `bytes.length` is not it: a 120-line file with no trailing newline has 119
 * `\n`, and the child would be refused for a byte it did not write. So a
 * non-empty final line counts as a line, and an empty one does not.
 *
 * Every line break the platforms write is counted: `\r\n`, a lone `\r` (a
 * Classic-Mac / some-editor file) and a lone `\n` each end ONE line, so a child
 * cannot dodge the bound by choosing its separator. A file with no break at all
 * is one line (`a` — one non-empty line, and the size rule's own rule that a
 * non-empty final line without its terminator still counts), and an empty file
 * is ZERO lines: nothing to count, and a rule that reported 1 would call an
 * empty file the smallest legal test (the capture refuses an empty file on its
 * own `fstat` size check; this is not that check's job, only the count must not
 * lie about it).
 *
 * A NUL byte anywhere refuses the count rather than guessing at it: the file is
 * not one the rule can honestly count. It comes back as `{ notText: true }`
 * rather than a throw — the caller has to be able to tell "this file is not a
 * text file" (a verdict on the child's work, and a drop) from "this file could
 * not be read at all" (infrastructure, and a throw). A rule that reported both
 * by throwing makes the boundary guess, and the guess it would make is the one
 * that reports a broken toolchain as an adversary that wrote nothing.
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
      // `\r\n` is ONE break: when the `\r` of a pair is seen, the `\n` that
      // follows is skipped, so neither half counts twice.
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
 * Why an oversized test file is not a kept test.
 *
 * Stated from the stat alone, so the file is refused without a read: the whole
 * point of the byte bound is that a file this big never becomes bytes in
 * memory, and a rule that had to read it to reject it is a rule that costs what
 * it exists to cap.
 */
export function testBytesProblem(rel: string, bytes: number): string {
  return `${rel} is ${bytes} bytes; an acceptance test is at most ${MAX_TEST_BYTES} bytes`;
}

/** Why the third (and later) file for one criterion is not kept. */
export function testFileQuotaProblem(criterionId: string): string {
  return `criterion ${criterionId} already has ${MAX_TEST_FILES_PER_CRITERION} test files; one focused test per criterion is the norm`;
}
