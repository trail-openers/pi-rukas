#!/usr/bin/env bun
/**
 * lean/submit-tests-size — the size rules the `submit_tests` boundary applies to
 * ONE candidate file, and the `lstat` it judges the byte bound from.
 *
 * Split out of `submit-tests-cap.ts` because the rules are a self-contained
 * question — is this file small enough to be an acceptance test — asked once per
 * candidate, with no knowledge of rows, criteria or quotas. The constants and the
 * refusal sentences they build live in `test-size.ts`, where the prompt that
 * quotes the numbers and the tests that pin them have one place to import from;
 * this module is the only caller that turns an answer into a verdict, and
 * `submit-tests-cap.ts` is the only caller of THAT.
 *
 * The seam `statSize` exists for the shapes a real filesystem cannot be asked to
 * produce on command: a stat that throws, or a size no fixture should pay for.
 *
 * The bound here is a bound on ONE VALIDATION. `validateSubmitRows` calls
 * `sizeJudgement` once per candidate, so at most `MAX_TEST_FILES_PER_CRITERION`
 * files per criterion, each at most `MAX_TEST_BYTES`, are read in one pass of the
 * boundary. What a run finally HOLDS is bounded separately, at the capture: a
 * file that grew past the bound in the window between the two is re-checked
 * there (`specify-run.ts`, step 2) before a byte of it is rewritten.
 */

import { lstatSync } from "node:fs";
import { readOneDescriptor } from "./specify-capture.ts";
import {
  MAX_TEST_BYTES,
  MAX_TEST_LINES,
  countTestLines,
  testBytesProblem,
  testNotTextProblem,
  testSizeProblem,
} from "./test-size.ts";

/**
 * The size of the file at `abs`, asked the way `fileProblem` asks about a path:
 * `lstat`, so a symlink is measured as a link and not as whatever it points at.
 * A test drives the seam to prove a file is refused on size without paying for
 * the fixture, or to prove a stat that will not answer is infrastructure.
 */
export function statSizeOf(abs: string): number {
  return Number(lstatSync(abs).size);
}

/**
 * What the size rules say about one candidate, or the fact that they cannot say.
 *
 * Three answers, and the third is the one a caller must not fold into the
 * second: `drop` is a verdict on the child's file (the row leaves, its criterion
 * goes uncovered, the run keeps going); `infra` is the toolchain failing to
 * answer, which the caller turns into `SpecifyInfraError` rather than a report
 * about work nobody looked at. `kept` carries nothing: the caller keeps the
 * PATH and never reads a size or a line count off this answer, and a field
 * nobody consumes is a field that can only drift from the truth. The capture
 * re-measures the file when it holds the bytes.
 */
export type SizeJudgement = { kind: "kept" } | { kind: "drop"; reason: string } | { kind: "infra" };

/**
 * The `code` of a stat or read error, when the runtime attached one.
 *
 * `ENOENT` / `ENOTDIR` / `ELOOP` are all statements about the NAME the child
 * submitted: no such file, a component of it is not a directory, or the link it
 * is does not resolve. The capture reads the same name and would refuse it for
 * the same fact, so this rule says so too — it is a verdict on the child's work.
 * Anything else (EIO, EMFILE, EACCES, ENOMEM) is the filesystem declining to
 * answer, and folding it into a drop reports a broken toolchain as an adversary
 * that wrote nothing.
 *
 * Only `err.code` is consulted. A message is never parsed for an errno: it is the
 * runtime's prose, not a contract, and it carries an absolute path the operator
 * has no use for. So a failure that arrives without a `code` — every `{ why }`
 * refusal from `readOneDescriptor` — is classified by what it IS (a verdict on
 * the file) and never by what its sentence happens to mention.
 */
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

function missingPathCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && MISSING_PATH_CODES.has(code) ? code : undefined;
}

/**
 * The size rules, applied to one candidate in the order that costs least.
 *
 * The stat comes first: the byte bound is judged on the size the filesystem
 * already handed the boundary, so an oversized file never becomes bytes in
 * memory. That is the whole reason a byte bound sits beside the line bound — a
 * line cap alone cannot bound a read, since 120 lines of 200 characters is
 * 24 KiB, and the boundary would pay for all of it to learn the file was one
 * line under the cap. Only a file the stat admits is read, through
 * `readOneDescriptor`, the capture's own descriptor read.
 *
 * A stat or a read that THROWS is classified by its `code` alone (see
 * `missingPathCode`): a missing-path code is a DROP on the child's name, worded
 * with the code and no message; anything else is `infra`. A stat that returns
 * something that is not a non-negative safe integer is `infra` too — a size of
 * `NaN`, `-1` or past `MAX_SAFE_INTEGER` is not evidence about a file, and
 * reasoning from one would let a broken seam decide what the rule saw.
 *
 * A read that returns its own `{ why }` IS a drop, in the capture's words: that
 * refusal comes from the file (a link swapped in after `fileProblem`, an empty
 * file, a fifo, a name that would not open), and `captureTestBytes` words it
 * identically, so the two cannot drift.
 */
export function sizeJudgement(
  abs: string,
  rel: string,
  statOf: (abs: string) => number = statSizeOf,
): SizeJudgement {
  let size: number;
  try {
    size = statOf(abs);
  } catch (err) {
    const code = missingPathCode(err);
    return code === undefined
      ? { kind: "infra" }
      : { kind: "drop", reason: `test ${rel} could not be read (${code})` };
  }
  // A size that is not a whole, countable, non-negative number is not a size:
  // no file has one, so nothing here may reason from it — neither the byte
  // bound nor the read that follows it.
  if (!Number.isSafeInteger(size) || size < 0) return { kind: "infra" };
  if (size > MAX_TEST_BYTES) return { kind: "drop", reason: testBytesProblem(rel, size) };
  let read: ReturnType<typeof readOneDescriptor>;
  try {
    read = readOneDescriptor(abs);
  } catch (err) {
    const code = missingPathCode(err);
    return code === undefined
      ? { kind: "infra" }
      : { kind: "drop", reason: `test ${rel} could not be read (${code})` };
  }
  if ("why" in read) return { kind: "drop", reason: `test ${rel} ${read.why}` };
  const counted = countTestLines(read.bytes);
  if ("notText" in counted) return { kind: "drop", reason: testNotTextProblem(rel) };
  if (counted.lines > MAX_TEST_LINES)
    return { kind: "drop", reason: testSizeProblem(rel, counted.lines) };
  return { kind: "kept" };
}
