#!/usr/bin/env bun
/**
 * #2064 pass 7 — NO exemption may remove a line that declares a failure.
 *
 * The excuse removes a head-only line from judgement in four places: the harness arm
 * (`isHarnessLine`), the passing-check arm (`isPassingLine`), the allow-list
 * (`isKnownCleanLine`), and the harness `Command failed:` echo (`isHarnessEchoOf`).
 * Pass 6 put {@link declaresFailure} behind two of those doors and left the other two
 * reading only their own shape, so a line opening with the harness's own marker walked
 * out regardless of what it then said: `$ not ok 1 - t/brand_new.t - boom` is excused by
 * the `$ ` arm, and `$ ===== 999 failed, 0 passed =====` by the same arm, while
 * `not ok 5 - brand new check 9 passed` is excused by the pass-count arm of the classifier.
 *
 * So the rule is one INVARIANT rather than one more arm, and it is enforced where every
 * exemption is applied — {@link judgeableLines} and the echo check — as the FIRST test:
 * a line whose own text declares a failure stays judgeable, whatever exemption it opens
 * like. A future arm cannot bypass it, because the arms are consulted after it.
 *
 * The vocabulary of "declares a failure" gained the two verdict spellings this class of
 * line is actually printed in — TAP's `not ok` and go's `--- FAIL` — so a runner's own
 * verdict line counts as declaring failure wherever the invariant is asked.
 *
 *   (refuse) a harness-prefixed line that declares a failure refuses, in every dialect,
 *     pinned through `baselineExcuse` — what a green is graded on — and through
 *     {@link judgeableLines}, which is the door the exemption is applied at;
 *   (refuse) the classifier-blind form `not ok 5 - brand new check 9 passed` refuses: the
 *     classifier reads it as SUCCESS on its `\d+ passed` arm, and pass 6's tally shape must not
 *     vouch for a TAP verdict;
 *   (refuse) THE SECOND DOOR THIS PASS FOUND, and the half it could not close from this seam: a
 *     head-only line the classifier does not read at all is dropped by `failureLines` BEFORE the
 *     exemption seams run, so it never becomes a head-only line and the tier excuses. `$ not ok 1
 *     - t/brand_new.t - boom` is such a line — the harness's wrapper arm unwraps the trace prefix,
 *     finds `not ok 1 - …`, and the classifier's own success arm reads it as a passing tally. So
 *     each refusal below is pinned in a dialect the classifier DOES read, where the invariant can
 *     decide a verdict, and the classifier-blind form is pinned as the open half and reported to
 *     PM rather than papered over with an arm in the wrong module;
 *   (refuse) the echo arm does not vouch for an echo that declares a failure unless the
 *     BASE printed that identical echo — the base-vouch is the only vouchsafe left;
 *   (control) the command echo the tier really ran still excuses, with and without a
 *     failure word in its own text;
 *   (control) everything the excuse exists to excuse still excuses: `bats t/` as a plain
 *     command echo, `pytest -v`'s new PASSED line, the dots-only progress row, TAP `ok`
 *     lines, `go test -v`'s run banner and PASS line, and the moved passed-count summary.
 */
import { isKnownCleanLine, judgeableLines } from "../src/lean/verify-baseline-allow-list.ts";
import { isHarnessEchoOf } from "../src/lean/verify-baseline-harness.ts";
import { declaresFailure } from "../src/lean/verify-baseline-counters.ts";
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC17c-baseline-excuse-no-exemption-declares-failure.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
const HEAD_ROOT = "/tmp/pi-rukas-2064-invariant/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-invariant/repo.baseline-lean-verify-9";
const TIER_CMD = "sh -c 'the tier'";

function excuseOf(headLines: string[], baseLines: string[], cmd: string = TIER_CMD) {
  return baselineExcuse({
    tierName: "fast",
    cmd,
    baseSha: "b".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

/** A recognised failure line every case uses as its excusable spine. */
const RED_LINE = "FAILED tests/x_test.py::test_a - AssertionError";

/** The stream-level answer for one head-only line: does the excuse survive it? */
function survives(line: string): boolean {
  return excuseOf([RED_LINE, line], [RED_LINE]).kind === "excused";
}

// --------- (refuse) the classifier's own arm may not read a `not ok` verdict as a passing tally
{
  // The class the pass-7 report named, in the dialect the classifier DOES read, so the invariant
  // is asked where it can decide a verdict. `\b\d+\s+passed\b` is an unanchored substring search,
  // so a TAP check whose NAME counts passes is read as SUCCESS and the classifier's answer vouches
  // for a failed check. The classifier's table is shared by every verify reader in the driver, so
  // it is not this seam's to correct, and it is registered as the open half of this pass in the PM
  // report; what IS pinned here is that no exemption of this seam vouches for such a line.
  const TAP_READ_AS_SUCCESS = "$ not ok 5 - brand new check 9 passed";
  assert(
    declaresFailure(TAP_READ_AS_SUCCESS),
    `(veto) "${TAP_READ_AS_SUCCESS}" declares a failure (${declaresFailure(TAP_READ_AS_SUCCESS)})`,
  );
  assert(
    judgeableLines(TAP_READ_AS_SUCCESS).length === 1,
    `(veto) "${TAP_READ_AS_SUCCESS}" stays judgeable — the invariant holds it there even though the classifier reads it as SUCCESS (${judgeableLines(TAP_READ_AS_SUCCESS).length})`,
  );
  assert(
    !isKnownCleanLine(TAP_READ_AS_SUCCESS),
    `(veto) and the allow-list does not vouch for it (${isKnownCleanLine(TAP_READ_AS_SUCCESS)})`,
  );
}

// --------- (refuse) the harness arms may not remove a line that declares a failure
{
  // Each of these opens with the harness's own marker — the executor's `$ ` trace, or the
  // `Command failed:` echo — and goes on to print a runner's failure verdict. The marker is
  // evidence about WHO wrote the prefix, never about what the rest of the line reports.
  const HARNESS_PREFIXED_FAILURES = [
    "$ not ok 1 - t/brand_new.t - boom",
    "$ FAILED tests/new_test.py::test_new - assert 1 == 2",
    "$ --- FAIL: TestBrandNew (0.3s)",
    "$ ===== 999 failed, 0 passed =====",
    "Command failed: not ok 1 - t/brand_new.t - boom",
  ];
  for (const line of HARNESS_PREFIXED_FAILURES) {
    assert(
      declaresFailure(line),
      `(veto) "${line}" declares a failure on its own text (${declaresFailure(line)})`,
    );
    assert(
      judgeableLines(line).includes(line),
      `(veto) "${line}" stays judgeable — no exemption removes it (${judgeableLines(line).length})`,
    );
    // And the excuse must actually see it: a line the classifier does not read is dropped by
    // `failureLines` before either gate runs, so it cannot make a head-only line and the tier
    // excuses. That is the second door this pass found, upstream of the exemption seams, and it is
    // why the head stream below carries the line in a dialect the classifier DOES read — the
    // invariant is pinned where it can decide a verdict.
    assert(
      !survives(line),
      `(veto) head-only "${line}" refuses the excuse (${excuseOf([RED_LINE, line], [RED_LINE]).kind})`,
    );
  }

  // The shells' own `+`/`$` trace prefixes, in the TAP dialect: the marker is the shell's,
  // the verdict is the runner's, and neither makes the other harness writing. The `[FAIL]` form is
  // the same verdict in a dialect the classifier reads, which is the form that can decide a verdict
  // while the classifier's own success arm still drops the bare one (see the block above).
  for (const line of ["+ not ok 1 - x", "$ not ok 1 - x", "$ [FAIL] not ok 1 - brand_new.t"]) {
    assert(
      declaresFailure(line) && judgeableLines(line).length === 1,
      `(trace) "${line}" declares a failure and stays judgeable (${declaresFailure(line)} / ${judgeableLines(line).length})`,
    );
    assert(
      !survives(line),
      `(trace) head-only "${line}" refuses the excuse (${excuseOf([RED_LINE, line], [RED_LINE]).kind})`,
    );
  }
}

// ------------------ (refuse) a TAP verdict wearing a pass count is not a passing line
{
  // The classifier reads this line as SUCCESS — its `\d+\s+passed` arm is an unanchored
  // substring search that fires on the check's NAME — so the passing-check door is the one that
  // used to let it out. The pass-count tally arm shares the door and shares the veto. The `+`
  // form is the same line in the dialect the pass-7 report named.
  const TAP_WEARING_A_PASS_COUNT = "not ok 5 - brand new check 9 passed";
  const TAP_WEARING_A_PASS_COUNT_TRACED = "+ not ok 5 - brand new check 9 passed";
  void 0;
  for (const line of [TAP_WEARING_A_PASS_COUNT, TAP_WEARING_A_PASS_COUNT_TRACED]) {
    assert(
      declaresFailure(line),
      `(veto) "${line}" declares a failure (${declaresFailure(line)})`,
    );
    assert(
      !isKnownCleanLine(line),
      `(veto) the allow-list does not vouch for "${line}" (${isKnownCleanLine(line)})`,
    );
  }
  assert(
    judgeableLines(TAP_WEARING_A_PASS_COUNT_TRACED).length === 1,
    `(veto) "${TAP_WEARING_A_PASS_COUNT_TRACED}" stays judgeable (${judgeableLines(TAP_WEARING_A_PASS_COUNT_TRACED).length})`,
  );
  assert(
    !survives(TAP_WEARING_A_PASS_COUNT_TRACED),
    `(veto) head-only "${TAP_WEARING_A_PASS_COUNT_TRACED}" refuses the excuse (${excuseOf([RED_LINE, TAP_WEARING_A_PASS_COUNT_TRACED], [RED_LINE]).kind})`,
  );
}

// ------------------ (echo) an echo is evidence about the INVOCATION, never the VERDICT
{
  const echoedFailure = "Command failed: sh -c 'pnpm run test -- --fail-fast'";
  // An echo records that the harness INVOKED a command, not what the run found, so a failure word
  // inside the invoked command string is a word the tier was TOLD to print — the shape every
  // `pytestFailTier` fixture has. The caller's own command still vouches for its echo.
  assert(
    isHarnessEchoOf(echoedFailure, [], "sh -c 'pnpm run test -- --fail-fast'"),
    "(echo) the tier's own command still vouches for its echo, failure word or not",
  );
  // What the veto does govern at this door is an echo nobody asked for: it vouches for itself by its
  // own name on no evidence, so only the base's identical line lets it out.
  assert(
    !isHarnessEchoOf("Command failed: sh -c 'rm -rf / --failed-early'", [], "pytest"),
    "(echo) a head-only echo of a command the caller never named is not vouched by its own text",
  );
  // The base printed the identical echo, so the harness really wrote that line in both runs.
  assert(
    isHarnessEchoOf(echoedFailure, [echoedFailure], "pytest"),
    "(echo) the base's identical echo still vouches for an echo that declares a failure",
  );
  assert(
    survives(echoedFailure) === false,
    `(echo) head-only, it refuses the excuse (${excuseOf([RED_LINE, echoedFailure], [RED_LINE]).kind})`,
  );
  assert(
    excuseOf([RED_LINE, echoedFailure], [RED_LINE, echoedFailure]).kind === "excused",
    `(echo) and with the base's identical echo it excuses (${excuseOf([RED_LINE, echoedFailure], [RED_LINE, echoedFailure]).kind})`,
  );
}

// ------------------------ (control) the echoes and clean lines the excuse exists for
{
  // A command echo that names no failure is still the harness's writing, in both arms.
  assert(
    isHarnessEchoOf("Command failed: bats t/", [], "bats t/"),
    "(control) the tier's own command echo — no failure word — still vouches",
  );
  assert(
    judgeableLines("$ bats t/").length === 0,
    `(control) "$ bats t/" is still exempt as a command echo (${judgeableLines("$ bats t/").length})`,
  );
  assert(
    survives("$ bats t/"),
    `(control) head-only "$ bats t/" still excuses (${excuseOf([RED_LINE, "$ bats t/"], [RED_LINE]).kind})`,
  );
  assert(
    survives(`Command failed: ${TIER_CMD}`),
    `(control) the tier's own echo still excuses (${excuseOf([RED_LINE, `Command failed: ${TIER_CMD}`], [RED_LINE]).kind})`,
  );

  // The must-excuse set: a PR that ADDS PASSING TESTS prints these, and an invariant that
  // ate any of them would refuse the case the excuse exists to grant.
  const CLEAN = [
    "PASSED tests/new_test.py::test_new",
    "tests/new_test.py ..  [100%]",
    "..s.                                      [ 50%]",
    "ok 1 - a passing check",
    "ok 5 - t/x.t # skip reason",
    "=== RUN   TestBrandNew",
    "--- PASS: TestBrandNew (0.00s)",
    "1..9",
    "collected 14 items",
  ];
  for (const line of CLEAN) {
    // These are vouched at the ALLOW-LIST door, not the stream door: a clean line is excused by
    // its shape, so it stays in the judgeable set and is refused nothing by being there. What must
    // hold is that the allow-list vouches for it and the invariant does not veto it.
    assert(
      isKnownCleanLine(line) && !declaresFailure(line),
      `(control) "${line}" excuses as a clean line (${isKnownCleanLine(line)})`,
    );
  }

  const FULL = {
    base: [
      "collected 12 items",
      "tests/x_test.py .....                    [ 50%]",
      "PASSED tests/x_test.py::test_a",
      "ok 1 - a passing check",
      RED_LINE,
      "===== 1 failed, 3 passed in 0.21s =====",
    ],
    head: [
      "collected 14 items",
      "tests/x_test.py .....                    [ 50%]",
      "tests/new_test.py ..                     [100%]",
      "PASSED tests/x_test.py::test_a",
      "PASSED tests/new_test.py::test_new",
      "ok 1 - a passing check",
      "ok 2 - a brand new passing check",
      "=== RUN   TestBrandNew",
      "--- PASS: TestBrandNew (0.00s)",
      RED_LINE,
      "===== 1 failed, 5 passed in 0.34s =====",
    ],
  };
  const r = excuseOf(FULL.head, FULL.base);
  assert(
    r.kind === "excused",
    `(control) the full added-passing-tests stream — new pass lines, new progress row, moved passed count and total — still excuses (${r.kind})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
