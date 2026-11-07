/**
 * The allow-list the default-refuse rule reads, asked DIRECTLY.
 *
 * #2064 round 2. `isKnownCleanLine` is the whole of what a head-only line may be and still
 * be excused, and its contract is one-directional — that direction is the point: a line it
 * calls clean cannot declare a failure, and a line it has never heard of is REFUSED, which
 * costs a hand-back and never a green. So this file pins both halves: the shapes it must
 * admit (a PR's own passing lines, counters and banners) and the shapes it must not (every
 * failure line produced from a real runner's vocabulary, and every line the shared
 * classifier reads as a failure).
 *
 * It asks the allow-list ITSELF rather than through `baselineExcuse`, because the whole
 * point of the reversal is that a new failure line no longer needs an entry anywhere to be
 * caught — a test that only goes through the excuse cannot tell "refused because the table
 * knows it" from "refused because nothing vouched for it", and the second is the rule.
 */
import { classifyFailureLine } from "../src/work-driver-verify-failures.ts";
import { isKnownCleanLine } from "../src/lean/verify-baseline-allow-list.ts";

const SELF = "test-AC15-baseline-excuse-allow-list.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${SELF}: ${msg}`);
    exit = 1;
  }
}

// -------------------------------------- the shapes the rule must admit (a PR's own lines)
{
  const CLEAN = [
    // Pass markers, in the dialects the brief names.
    "ok 1 - a passing check",
    "ok 12 - t/x.t",
    "ok 5 - t/x.t # skip reason",
    "PASS",
    "PASSED",
    "PASSED tests/new_test.py::test_new",
    "PASS pkg/foo",
    "\u2713 x",
    "3 passed",
    "4 passed in 0.12s",
    "===== 12 passed in 0.2s =====",
    "Tests: 5 passed, 5 total",
    // go test -v: the run line and the passing verdict.
    "=== RUN   TestNew",
    "--- PASS: TestNew (0.01s)",
    "  --- PASS: TestBar (0.00s)",
    // pytest's default progress output, and a collection count.
    "tests/new_test.py ..  [100%]",
    "..s.                                      [ 50%]",
    "collected 25 items",
    // A TAP plan — how many checks the runner intends to print, not a verdict.
    "1..9",
    "1..10",
    // Separators.
    "=====",
    "-----",
    "#######",
  ];
  for (const line of CLEAN) {
    assert(
      isKnownCleanLine(line),
      `(clean) "${line}" is on the allow-list (${isKnownCleanLine(line)})`,
    );
  }
}

// ------------------------------- the shapes the rule must refuse (a failure in any dialect)
{
  // None of these is on the allow-list, and NONE needed to be recognised by a table entry
  // to be refused — that is the whole of the reversal this round makes. Each is what a real
  // runner prints, or what a harness prints, for something that failed.
  const NOT_CLEAN = [
    "Exit code: 1 - brand new check",
    "killed - brand new check",
    "1..9 - brand new check",
    "brand new check ... FAILED",
    "FAILURES!",
    "== FAILURES ==",
    "[FAIL] x",
    "\u2717 x",
    "\u00d7 x",
    "Failure: x",
    "AssertionError: expected 3 to be 4",
    "Tests run: 1, Failures: 1",
    "1) brand new check",
    // A tally whose counts name failures is a line about them, and the classifier reads it
    // that way — so the tally arm must not admit it either.
    "===== 5 failed, 1 passed in 0.44s =====",
    "1 failed, 5 passed",
    "1 error, 5 passed",
    // Words that merely CONTAIN a pass marker: the arms are anchored, so they do not pass.
    "okay we are fine",
    "token ok maybe",
    "passage of arms",
  ];
  for (const line of NOT_CLEAN) {
    assert(
      !isKnownCleanLine(line),
      `(refuse) "${line}" is NOT on the allow-list (${isKnownCleanLine(line)})`,
    );
  }

  // Everything the classifier reads as a failure is refused FIRST, whatever it resembles —
  // which is what lets the arms be anchored words rather than a complete vocabulary. Each
  // line below is asserted to be a failure line by the classifier AND refused by the
  // allow-list, so the ordering (classifier first) is what carries them, not their shape.
  const READ_AS_FAILURE = [
    "not ok 1 - x",
    "not ok 7 - a check the base never printed",
    "--- FAIL: TestSolo (0.01s)",
    "FAIL a_test.sh: boom",
    "FAILED tests/new_test.py::test_new - assert 1 == 2",
  ];
  for (const line of READ_AS_FAILURE) {
    assert(
      classifyFailureLine(line) !== undefined,
      `(refuse) the classifier reads "${line}" as a failure line`,
    );
    assert(!isKnownCleanLine(line), `(refuse) so "${line}" is never clean`);
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
