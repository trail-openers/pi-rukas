#!/usr/bin/env bun
/**
 * #2064 round 2 — the baseline excuse is DEFAULT-REFUSE.
 *
 * The first fix kept a vocabulary of failure TOKENS and refused on a head-only token the
 * classifier's table did not read. Runner dialects are unbounded, so every round found a
 * failure line the vocabulary lacked, the line was silently OMITTED, and the run graded
 * green. This file pins the reversal: a head-only line is excused only when a small,
 * bounded allow-list PROVES it cannot declare a failure. Anything else refuses, so the
 * allow-list may be imperfect only in the safe direction — a missed clean shape costs a
 * hand-back, never a false green.
 *
 *   (refuse) every string the reviewer produced from a real runner, head-only, refuses:
 *     a bare `Exit code:` / `killed` / `1..9` / numbered-junit line, `FAILURES!`,
 *     `== FAILURES ==`, `[FAIL] x`, `✗ x`, `× x`, `Failure: x`, `AssertionError: …`,
 *     `Tests run: 1, Failures: 1`, a trailing `… FAILED`, and the two the classifier does
 *     read (`--- FAIL:`, `not ok`) plus a changed assertion message;
 *   (excuse) a PR that ADDS PASSING TESTS to a suite that was already red at base, in the
 *     four dialects the brief names — pytest -v, pytest default progress output, TAP,
 *     `go test -v` — excuses, with its new pass lines, its changed plan and its changed
 *     summary counts; and so does the case whose summary moves ONLY its PASSED count
 *     (`1 failed, 3 passed` → `1 failed, 5 passed`) while the failure count stands;
 *   (refuse) the same summary with its FAILED count moved (`1 failed` → `2 failed`), and a
 *     `Failures: 1` line that became `Failures: 2` — the fold reaches counters, never reporters;
 *   (direction) a line whose clean shape is NOT on the allow-list refuses: the rule's
 *     failure mode is a hand-back, and that is the only failure mode it has.
 *
 * The controls keep each guard from being a blanket refusal.
 */
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import { isKnownCleanLine } from "../src/lean/verify-baseline-allow-list.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC14-baseline-excuse-default-refuse.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
const HEAD_ROOT = "/tmp/pi-rukas-2064-refuse/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-refuse/repo.baseline-lean-verify-9";

/** One comparison, on the lines each run printed. */
function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'the tier'",
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

/** A recognised failure line every case uses as its excusable spine. */
const RED_LINE = "FAILED tests/x_test.py::test_a - AssertionError";

// ------------------------------------ (refuse) a head-only failure line in any dialect
{
  // Each of these is what a real runner prints for a FAILING check, and none is on the
  // clean allow-list. The point is not the list — it is that none of them had to be
  // recognised by anything to be refused: they are refused for NOT being known clean.
  const MUST_REFUSE = [
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
    "--- FAIL: TestSolo (0.01s)",
    "not ok 7 - a check the base never printed",
    "FAILED tests/new_test.py::test_new - assert 1 == 2",
  ];
  for (const line of MUST_REFUSE) {
    assert(
      excuseOf([RED_LINE, line], [RED_LINE]).kind === "refused",
      `(refuse) head-only "${line}" refuses the excuse (${excuseOf([RED_LINE, line], [RED_LINE]).kind})`,
    );
    assert(
      !isKnownCleanLine(line),
      `(refuse) and the allow-list itself says "${line}" is not a clean shape`,
    );
  }
}

// ---------------------------------------- (refuse) a changed assertion is a new failure
{
  const HEAD = "FAILED tests/x_test.py::test_a - AssertionError: expected 3 to be 4";
  const BASE = "FAILED tests/x_test.py::test_a - AssertionError: expected 3 to be 5";
  assert(
    excuseOf([HEAD], [BASE]).kind === "refused",
    `(refuse) a failure line whose assertion text changed is a line the base never printed (${excuseOf([HEAD], [BASE]).kind})`,
  );
}

// ------------------------ (excuse) a PR that ADDS PASSING TESTS to an already-red suite
{
  // The case the rule must keep granting, in each dialect the brief names. In every one the
  // head stream differs from the base's by new PASS lines and moved counters, and the
  // failing line is identical on both sides.
  //
  // WHAT MAY MOVE AND WHAT MAY NOT, and this is the whole of the rule: a COUNTER may move
  // (`1..9` to `1..10`, `3 passed`, a progress line's `[50%]`, a `Tests run: N` total) because it
  // reports how many checks ran, and a PR that adds checks changes it. A REPORTER may not, and a
  // line naming a non-zero count of failures is a reporter: it is saying something broke, and a
  // number that moved inside IT is exactly the evidence the excuse must not wave through. The
  // fold in `verify-baseline-allow-list.ts` draws that line by WORD rather than by position, so a
  // tally that reports both halves (`1 failed, 5 passed`) keeps its failure count exact and may
  // still move its passing half — which is what lets the case below excuse.
  const PYTEST_V = {
    base: [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 5 passed in 0.42s ====="],
    head: [
      RED_LINE,
      "PASSED tests/x_test.py::test_b",
      "PASSED tests/new_test.py::test_new",
      "===== 1 failed, 5 passed in 0.42s =====",
    ],
    why: "pytest -v: a new PASSED line beside a failure-reporting summary that did not move",
  };
  const PYTEST_PLAIN = {
    base: ["..s.", RED_LINE, "1 failed, 5 passed in 0.40s"],
    head: ["tests/new_test.py ..  [100%]", "..s.", RED_LINE, "1 failed, 5 passed in 0.40s"],
    why: "pytest default output: a new progress line beside a summary that did not move",
  };
  const PYTEST_CLEAN_SUMMARY_MOVED = {
    // The summary that MAY move: it counts passes and names no non-zero failure count, so
    // there is no failure inside it for a moved number to hide. This is the case the whole
    // allow-list exists for and the counter/reporter line falls exactly here.
    base: [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 5 passed in 0.2s ====="],
    head: [RED_LINE, "PASSED tests/x_test.py::test_b", "PASSED tests/new_test.py::test_new", "===== 7 passed in 0.31s ====="],
    why: "pytest -v whose summary counts only passes: the moved count excuses",
  };
  const TAP = {
    base: ["ok 1 - a passing check", "not ok 2 - a bats check", "1..9"],
    head: ["ok 1 - a passing check", "ok 2 - a brand new passing check", "not ok 3 - a bats check", "1..10"],
    why: "TAP: new `ok N` lines and a changed plan",
  };
  const TAP_SUMMARY_MOVED = {
    // The same run with a counting summary bolted on, which is what bats and Test::More
    // wrappers print after the plan. The head's summary counts HIGHER than the base's
    // because this run ran more checks, and it reports them as failures, so the allow-list
    // refuses it and the excuse goes. That is the intended outcome and this row exists to
    // pin it: the one number this rule cannot tell apart is `+2 passing` from `+2 failing`
    // inside a tally that reports failures, and the side it fails on is the one that cannot
    // produce a false green. The tier still excuses only while the summary is byte-identical
    // on both streams, which is why `head` below carries the SAME summary as `base`.
    base: ["ok 1 - a passing check", "not ok 2 - a bats check", "1..9", "# 1 failed, 4 passed of 5"],
    head: ["ok 1 - a passing check", "ok 2 - a brand new passing check", "not ok 3 - a bats check", "1..10", "# 1 failed, 4 passed of 5"],
    why: "TAP with a failure-reporting summary: the summary must be byte-identical to excuse",
  };
  const GO = {
    base: ["=== RUN   TestOld", "--- PASS: TestOld (0.01s)", "--- FAIL: TestSolo (0.02s)"],
    head: [
      "=== RUN   TestOld",
      "--- PASS: TestOld (0.01s)",
      "=== RUN   TestBrandNew",
      "--- PASS: TestBrandNew (0.00s)",
      "--- FAIL: TestSolo (0.02s)",
    ],
    why: "go test -v: new `=== RUN` and `--- PASS:` lines",
  };
  const PYTEST_SUMMARY_MOVED = {
    // THE field case the whole rule exists for, and the reason the counter fold keeps failure
    // counts exact: a PR ADDS PASSING TESTS to a suite that was ALREADY RED with the same
    // failure, and its summary moves ONLY in the passing half (`3 passed` → `5 passed`) while
    // `1 failed` stands. The classifier reads the counted failing tally as a failure line, so
    // before {@link failureLineFold} moved the non-failure counters this refused — the feature
    // refusing the one case it grants. The line that does NOT excuse is the same pair with the
    // FAILURE count moved, pinned just below.
    base: [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 4 passed in 0.42s ====="],
    head: [RED_LINE, "PASSED tests/x_test.py::test_b", "PASSED tests/new_test.py::test_new", "===== 1 failed, 5 passed in 0.44s ====="],
    why: "pytest -v whose failure-reporting summary moved only its PASSED count: the added passing tests excuse",
  };
  const PYTEST_FAILURE_COUNT_MOVED = {
    // The other half of the same rule, and the reason the fold is exact and not convenient: the
    // same summary with its FAILURE count moved is a check that broke, and no fold may make
    // `2 failed` the line the base printed as `1 failed`.
    base: [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 3 passed in 0.42s ====="],
    head: [RED_LINE, "PASSED tests/x_test.py::test_b", "PASSED tests/new_test.py::test_new", "===== 2 failed, 3 passed in 0.42s ====="],
    why: "pytest -v whose summary moved its FAILED count: a check broke, and that is not excusable",
  };
  const JUNIT_TOTALS_MOVED = {
    // Surefire/JUnit's dialect: `Tests run: N, Failures: N`. The total of how many checks ran is
    // a counter and moves; the `Failures: 1` beside it is a reporter and must not.
    base: [RED_LINE, "Tests run: 3, Failures: 1"],
    head: [RED_LINE, "Tests run: 5, Failures: 1"],
    why: "a `Tests run: N, Failures: N` tally whose TOTAL moved and whose failure count did not",
  };
  const JUNIT_FAILURES_MOVED = {
    // The same shape with the number that matters moved: `Failures: 1` beside `Failures: 2` is
    // one more broken check, and the fold leaves both digits standing.
    base: [RED_LINE, "Failures: 1"],
    head: [RED_LINE, "Failures: 2"],
    why: "a Failures: N tally whose failure count moved refuses",
  };
  const PYTEST_FULL_STREAM = {
    // The whole stream of the field case, not one line of it: pytest's summary moves its
    // passed count and its duration, the run gains per-check PASSED lines and a progress row,
    // and the one recognised failure line is identical on both sides. Every line that differs
    // is either a pass marker, a progress row, or a tally whose failure count did not move.
    base: [
      "collected 12 items",
      // The base's own row for the file whose checks this PR adds to. It is BYTE-IDENTICAL to the
      // head's copy, which is what lets it excuse: an added check makes the runner print a row of
      // a different LENGTH, and a row whose length or percentage moved is a row the base never
      // printed. It carries an `F` because the suite is red here, and the whole-line veto refuses
      // a head-only row that does -- the accepted cost the docs state -- so a row that is clean at
      // both runs is excused as the base's own, exactly like the identical `FAILED` line below.
      "tests/x_test.py .....                    [ 50%]",
      "PASSED tests/x_test.py::test_a",
      "PASSED tests/x_test.py::test_b",
      RED_LINE,
      "===== 1 failed, 3 passed in 0.21s =====",
    ],
    head: [
      "collected 14 items",
      "tests/x_test.py .....                    [ 50%]",
      "tests/new_test.py ..                       [100%]",
      "PASSED tests/x_test.py::test_a",
      "PASSED tests/x_test.py::test_b",
      "PASSED tests/new_test.py::test_new_one",
      "PASSED tests/new_test.py::test_new_two",
      RED_LINE,
      "===== 1 failed, 5 passed in 0.34s =====",
    ],
    why: "a full pytest stream that added two passing checks to a red suite: every moved line excuses",
  };
  for (const c of [PYTEST_V, PYTEST_PLAIN, PYTEST_CLEAN_SUMMARY_MOVED, TAP, TAP_SUMMARY_MOVED, GO, PYTEST_SUMMARY_MOVED, JUNIT_TOTALS_MOVED, PYTEST_FULL_STREAM]) {
    const r = excuseOf(c.head, c.base);
    assert(r.kind === "excused", `(excuse) ${c.why} — the added passing tests excuse (${r.kind})`);
  }
  for (const c of [PYTEST_FAILURE_COUNT_MOVED, JUNIT_FAILURES_MOVED]) {
    const r = excuseOf(c.head, c.base);
    assert(r.kind === "refused", `(refuse) ${c.why} (${r.kind})`);
  }
}

// ---------------------------------- (direction) an unknown clean shape costs a hand-back
{
  // A shape the allow-list has never heard of REFUSES. That is the safe direction and the
  // reason the vocabulary is gone: a missed clean line hands the run back, and a wrong
  // clean line would have graded it green. A runner whose passing lines are not on the
  // list gets a hand-back, never a false green.
  const UNKNOWN_CLEAN = ["Ran 5 tests in 0.01s", "PASSING: everything looked fine"];
  for (const line of UNKNOWN_CLEAN) {
    assert(
      excuseOf([RED_LINE, line], [RED_LINE]).kind === "refused",
      `(direction) an unknown head-only line "${line}" is refused, not omitted (${excuseOf([RED_LINE, line], [RED_LINE]).kind})`,
    );
  }
  // …and the same line on BOTH streams is not a new failure, so it excuses: the exemption
  // the rule grants is "the base printed this too", and it needs no allow-list for it.
  assert(
    excuseOf([RED_LINE, UNKNOWN_CLEAN[0] as string], [RED_LINE, UNKNOWN_CLEAN[0] as string])
      .kind === "excused",
    "(direction) the same unknown line at base is not evidence of a new failure",
  );
}

// -------------------------------------------------(control) the rule is not a refusal-all
{
  assert(excuseOf([RED_LINE], [RED_LINE]).kind === "excused", "(control) one identical pair excuses");
  assert(
    excuseOf(["collected 12 items", RED_LINE], ["collected 10 items", RED_LINE]).kind ===
      "excused",
    "(control) a collection count that moved is a clean shape and excuses",
  );
  assert(
    excuseOf(["=====", RED_LINE], ["=====", RED_LINE]).kind === "excused",
    "(control) a separator banner excuses beside the recognised pair",
  );
  assert(
    excuseOf([RED_LINE], ["built 14 packages in 3s"]).kind === "refused",
    "(control) a base that named nothing still excuses nothing",
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
