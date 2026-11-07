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
 *     summary counts;
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
  // (`1..9` to `1..10`, `3 passed`, a progress line's `[50%]`) because it reports how many
  // checks ran, and a PR that adds checks changes it. A REPORTER may not, and a line naming
  // a non-zero count of failures (`1 failed, 5 passed`) is a reporter: it is saying something
  // broke, and a number that moved inside it is exactly the evidence the excuse must not
  // wave through. Where a runner prints such a line, the tier excuses with that line
  // byte-identical on both streams — which is what each fixture below does.
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
  const PYTEST_SUMMARY_REFUSES = {
    // What the rule costs, and the cost is taken deliberately: the same run whose summary
    // line counts differently between base and head REFUSES, because a summary that reports
    // failures (`1 failed, N passed`) cannot distinguish "N rose because the PR added
    // passing checks" from "N fell because the PR broke one". A hand-back is the right
    // answer when the evidence cannot tell those apart; a green is not.
    base: [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 4 passed in 0.42s ====="],
    head: [RED_LINE, "PASSED tests/x_test.py::test_b", "PASSED tests/new_test.py::test_new", "===== 1 failed, 5 passed in 0.44s ====="],
    why: "pytest -v whose failure-reporting summary moved: refuses rather than guesses",
  };
  for (const c of [PYTEST_V, PYTEST_PLAIN, PYTEST_CLEAN_SUMMARY_MOVED, TAP, TAP_SUMMARY_MOVED, GO]) {
    const r = excuseOf(c.head, c.base);
    assert(r.kind === "excused", `(excuse) ${c.why} — the added passing tests excuse (${r.kind})`);
  }
  assert(
    excuseOf(PYTEST_SUMMARY_REFUSES.head, PYTEST_SUMMARY_REFUSES.base).kind === "refused",
    `(refuse) ${PYTEST_SUMMARY_REFUSES.why} (${excuseOf(PYTEST_SUMMARY_REFUSES.head, PYTEST_SUMMARY_REFUSES.base).kind})`,
  );
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
