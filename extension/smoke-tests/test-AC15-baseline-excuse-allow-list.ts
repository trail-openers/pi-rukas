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
 *
 * The counter/reporter boundary is pinned here too, since {@link counterFolded} is what draws
 * it: a number attached to a NON-failure counter (`3 passed`, `Tests run: 3`) is a runner
 * counting its own run and may move between the two streams; a number attached to a FAILURE
 * word (`1 failed`, `Failures: 1`) is evidence about which checks broke and is read exactly.
 */
import { classifyFailureLine } from "../src/work-driver-verify-failures.ts";
import { isKnownCleanLine } from "../src/lean/verify-baseline-allow-list.ts";
import { counterFolded } from "../src/lean/verify-baseline-counters.ts";

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
    // A tally whose FAILURE count is zero or absent counts passes, and its number may move: the
    // added-passing-tests case lives here, including the dialects whose counters sit in a
    // `Label: N` form or name something other than passes.
    "12 passed, 1 warning in 0.5s",
    // A separator.
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
    // The whole-line veto is a WORD veto and it is absolute, so it reaches a tally whose failure
    // count is ZERO: `===== 0 failed, 3 passed in 0.2s =====` reports a clean run and is still
    // refused, because the veto cannot tell `0 failed` from `9 failed` without reading the digit, and
    // a veto that could is a veto the next runner's dialect walks through. The direction is the one
    // this rule always fails on — the line hands back rather than grading green — and the tier is
    // still excused by the classifier's own reading of its failure lines. This is the veto's accepted
    // cost, stated in `docs/lean.md` and the troubleshooting entry.
    "===== 0 failed, 3 passed in 0.2s =====",
    // The same tallies in the padding a real runner prints. Each reports a NON-ZERO failure
    // count, and the counter fold leaves that count standing, so the tally arm still refuses
    // them: a moved passed-count excuses, a moved-or-not failed-count never does.
    "===== 1 failed, 5 passed in 0.3s =====",
    "Tests run: 5, Failures: 1",
    "Failures: 1",
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

// ------------------------ (counters) what the comparison fold may move, and what it may not
{
  // `counterFolded` is the looser key `baselineExcuse` falls back to, so its two directions are
  // the two halves of the rule: the fields a runner is entitled to move between two runs, and
  // everything that stays byte-for-byte. A fold that is too WIDE excuses a regression the base
  // never printed; a fold that is too NARROW refuses the PR that only added passing tests. Both
  // are pinned, on the lines real runners print.
  const MAY_MOVE: [string, string, string][] = [
    ["===== 1 failed, 3 passed in 0.2s =====", "===== 1 failed, 5 passed in 0.3s =====", "the field case: a moved PASSED count and duration beside the same 1 failed"],
    ["1 failed, 3 passed", "1 failed, 5 passed", "the bare tally, same case"],
    ["Tests run: 3, Failures: 1", "Tests run: 5, Failures: 1", "a Surefire total beside an unchanged Failures count"],
    ["a.py: 1 failed, 3 passed", "a.py: 1 failed, 5 passed", "the `named-file` dialect's own tally"],
    ["--- FAIL: TestSolo (0.02s)", "--- FAIL: TestSolo (0.05s)", "go's per-check duration"],
    ["3 passed", "5 passed", "a passing count on a line that reports no failure"],
  ];
  for (const [a, b, why] of MAY_MOVE) {
    assert(
      counterFolded(a) === counterFolded(b),
      `(fold) ${why}: "${a}" and "${b}" are one line (${counterFolded(a)} / ${counterFolded(b)})`,
    );
  }

  const MUST_DIFFER: [string, string, string][] = [
    ["===== 1 failed, 3 passed in 0.2s =====", "===== 2 failed, 3 passed in 0.2s =====", "a moved FAILED count is a check that broke"],
    ["===== 1 failed, 3 passed in 0.2s =====", "===== 1 error, 3 passed in 0.2s =====", "failed and error are different reports, however both fold"],
    ["Failures: 1", "Failures: 2", "the Surefire failure count"],
    ["Errors: 1", "Errors: 2", "the Surefire error count"],
    ["tests/x.py: 1 failed", "tests/x.py: 2 failed", "the `named-file` failure count"],
    ["tests/a.py: failed checks (1)", "tests/a.py: failed checks (2)", "the script tally's own count"],
    ["pack_release_test.sh: 36 cases, 1 failed", "pack_release_test.sh: 36 cases, 2 failed", "the comma tally's failing half"],
    ["FAILED t.py::a - assert 1 == 2", "FAILED t.py::a - assert 1 == 3", "an assertion's values are findings, not counters"],
    ["expected 3 to be 4", "expected 3 to be 5", "the same, in the assertion dialect"],
    // The TAP check index is folded by `leadingIndexFolded`, the key built for it, and NOT by this
    // one: the counter pass is reached only when the index pass has already failed for every line,
    // so a key that folded the index too would collapse two different checks onto one line here.
    ["not ok 2 - a bats check", "not ok 3 - a bats check", "a TAP check number is folded elsewhere, never by this key"],
    ["0 failed", "1 failed", "a count that moved to or from zero changed the failure report"],
    ["10 failed", "11 failed", "a multi-digit failure count keeps its digits"],
    ["version 1.2.3", "version 1.2.4", "a version is not a counter"],
  ];
  for (const [a, b, why] of MUST_DIFFER) {
    assert(
      counterFolded(a) !== counterFolded(b),
      `(fold) ${why}: "${a}" and "${b}" stay two lines (${counterFolded(a)})`,
    );
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);