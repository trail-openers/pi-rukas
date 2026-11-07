#!/usr/bin/env bun
/**
 * #2064 round 6 — the two folds the comparison may NOT use, pinned one per removed key.
 *
 * The comparison of head failure lines against base failure lines folds exactly one field: a
 * runner's own counters and durations, and only on a line the classifier did not read as one check's
 * failure ({@link failureLineFold}). This file pins the two keys that used to exist beside it and are
 * deleted, because each excused a failure the base never printed:
 *
 *   (reporter) a digit whose OWN word names a failure — `1 failed`, `tests: 1 failed`, `suite ran: 1
 *     failed`, and the error/panic/timeout/killed spellings — never folds, whatever label precedes it.
 *     The counter arms answer "is the word next to this digit a counter?", and a LABEL is exactly the
 *     spelling that lets a real counter word sit beside a broken count: `ran` is admitted for `Run: 3`,
 *     so `suite ran: 1 failed` folded onto `suite ran: 2 failed` and the second failed check was
 *     excused as the first. The refusal comes from the digit's own word, since a label vocabulary is
 *     unbounded; and
 *   (index) a runner's CHECK INDEX folds by nothing. `not ok 3 - x` is not the line a base printed as
 *     `not ok 1 - x`: the index is assigned by the order checks ran, so it says nothing about WHICH
 *     check printed the line, and a new failing check printed third folded onto the base's first.
 *
 * The accepted costs, both in the safe direction and both stated in `docs/lean.md` and the
 * troubleshooting entry: a TAP or bats run whose failing checks were RENUMBERED — the usual effect of
 * adding a passing test before them — now refuses, and a passing test whose NAME carries a failure word
 * is refused. A hand-back, never a green.
 *
 * The counterpart of every refusal here is the must-move case: the PASSED half of the same summary and
 * the `Tests run: N` total still fold, so the fix is not "fold nothing".
 */
import { classifyFailureLine } from "../src/work-driver-verify-failures.ts";
import { failureLineFold } from "../src/lean/verify-baseline-counters.ts";
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import { isKnownCleanLine } from "../src/lean/verify-baseline-allow-list.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC16b-baseline-excuse-what-may-move.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
const HEAD_ROOT = "/tmp/pi-rukas-2064-whatmaymove/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-whatmaymove/repo.baseline-lean-verify-9";

/** One comparison, on the lines each run printed. */
function excuseOf(headLines: string[], baseLines: string[]) {
  return baselineExcuse({
    tierName: "fast",
    cmd: "sh -c 'the tier'",
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

// ------------- (reporter) a digit whose OWN word names a failure never folds, whatever precedes it
{
  // The fold's first question, asked before any counter arm. Pinned through `baselineExcuse`, because
  // that is what a green is graded on, and through `failureLineFold` as well, so the pair is refused
  // wherever a key is built for it.
  const REPORTER_PAIRS: [string, string, string][] = [
    ["suite ran: 1 failed", "suite ran: 2 failed", "a `ran:` label beside a moved failed count"],
    ["tests: 1 failed", "tests: 2 failed", "a `tests:` label beside a moved failed count"],
    ["suite ran: 1 error", "suite ran: 2 errors", "the error spelling, singular at base and plural at head"],
    ["suite ran: 1 panic", "suite ran: 2 panicked", "the panic spelling"],
    ["suite ran: 1 segfault", "suite ran: 2 segfault", "the segfault spelling"],
    ["suite ran: 1 timeout", "suite ran: 2 timed out", "the timeout spelling"],
    ["suite ran: 1 killed", "suite ran: 2 killed", "a run killed by a signal"],
  ];
  for (const [head, base, why] of REPORTER_PAIRS) {
    assert(
      failureLineFold(head) !== failureLineFold(base),
      `(reporter) ${why} keeps its digits (${failureLineFold(head)} / ${failureLineFold(base)})`,
    );
    assert(
      excuseOf([RED_LINE, head], [RED_LINE, base]).kind === "refused",
      `(reporter) ${why} refuses the excuse (${excuseOf([RED_LINE, head], [RED_LINE, base]).kind})`,
    );
  }

  // The fold's own boundary, stated exactly. The reporter arm reads the word on the count's RIGHT, so a
  // count whose own word is a reporter keeps its digits. What it cannot do is reach past the word on the
  // count's LEFT: `N items failed` counts a word that IS on the counter list (`items`), so the counter
  // arm decides it and the digit folds — the fold cannot tell a tally's item count from a failed-check
  // row without the classifier, and the classifier's anchored shapes do not read this bare spelling.
  // Pinned as the known edge it is: the row is still no clean shape (the whole-line veto holds it in the
  // stream), and every dialect a runner actually prints for a failed check — `1 failed`, `tests/x.py: 1
  // failed`, `Failures: 1` — is refused above.
  assert(
    classifyFailureLine("tests/x_test.py: 1 items failed") === undefined &&
      !isKnownCleanLine("tests/x_test.py: 1 items failed"),
    "(reporter) a `N items failed` row is no clean shape: the whole-line veto holds it in the stream",
  );
  assert(
    excuseOf(
      [RED_LINE, "tests/x_test.py: 1 items failed"],
      [RED_LINE, "tests/x_test.py: 2 items failed"],
    ).kind === "excused",
    "(reporter) the disclosed edge: a bare `N items failed` row is a counter row to the fold, so it moves",
  );

  // The fold is not "refuse any line that mentions a failure word": the PASSED half of the same summary
  // still folds, and a `Tests run: N` total beside an unchanged failure count still folds. These are the
  // must-move cases the reporter arm must not cost.
  assert(
    failureLineFold("===== 1 failed, 3 passed =====") ===
      failureLineFold("===== 1 failed, 5 passed ====="),
    `(reporter) a moved passed count still folds beside the standing failure count (${failureLineFold("===== 1 failed, 3 passed =====")})`,
  );
  assert(
    failureLineFold("Tests run: 3") === failureLineFold("Tests run: 5"),
    `(reporter) the Tests run: N total still folds when nothing else moved (${failureLineFold("Tests run: 5")})`,
  );
  assert(
    failureLineFold("Tests run: 3, Failures: 1") === failureLineFold("Tests run: 5, Failures: 1"),
    `(reporter) the Tests run: N total still folds beside an unchanged Failures count (${failureLineFold("Tests run: 5, Failures: 1")})`,
  );

  // And the same two through the excuse, as whole streams: the field case the rule exists to grant.
  assert(
    excuseOf(
      [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 5 passed ====="],
      [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 3 passed ====="],
    ).kind === "excused",
    "(reporter) the summary whose PASSED half moved still excuses over a base that printed the same failure",
  );
  assert(
    excuseOf([RED_LINE, "Tests run: 5, Failures: 1"], [RED_LINE, "Tests run: 3, Failures: 1"]).kind ===
      "excused",
    "(reporter) the Surefire total that moved still excuses beside an unchanged Failures count",
  );
  // …and the reporter arm must not be a blanket refusal on any line that mentions `failed`: the SAME
  // Surefire shape with its FAILURES count moved still refuses, so the exemption above is confined to the
  // label that names the run's total.
  assert(
    excuseOf([RED_LINE, "Tests run: 5, Failures: 2"], [RED_LINE, "Tests run: 5, Failures: 1"]).kind ===
      "refused",
    "(reporter) the same Surefire shape whose Failures count moved still refuses",
  );
}

// ----------------------- (index) a renumbered TAP failure is a line the base never printed
{
  // The check-index fold is deleted. It folded the digits a runner prints after its status word so that
  // `not ok 3 - x` sat where the base printed `not ok 1 - x`, on the theory that a PR adding a passing
  // test renumbers the failures after it. The theory does not survive a NEW failing check: the index is
  // assigned by the order checks ran, so nothing ties it to a check, and a third failing check folded
  // onto the base's first. The accepted cost is the opposite direction — a genuinely renumbered failure
  // now refuses, which is a hand-back and never a green.
  const RENUMBERED: [string, string, string][] = [
    ["not ok 3 - a bats check", "not ok 1 - a bats check", "a TAP failure renumbered by an added check"],
    ["not ok 3 - a bats check", "not ok 2 - a bats check", "the same, one apart"],
    ["not ok 12 - t/release.t", "not ok 11 - t/release.t", "a two-digit index"],
  ];
  for (const [head, base, why] of RENUMBERED) {
    assert(
      excuseOf([RED_LINE, head], [RED_LINE, base]).kind === "refused",
      `(index) ${why} refuses the excuse (${excuseOf([RED_LINE, head], [RED_LINE, base]).kind})`,
    );
    assert(
      excuseOf([RED_LINE, head], [RED_LINE, head]).kind === "excused",
      `(index) the same ${why} printed identically at base is the base's own red and excuses`,
    );
  }

  // …and the renumbering cost stated as the field case it costs: the added-passing-tests run whose TAP
  // failures shift by one. The plan and the new `ok` lines are clean shapes; the shifted failure line is
  // not, and it is what hands the run back.
  assert(
    excuseOf(
      ["ok 1 - a passing check", "ok 2 - a brand new passing check", "not ok 3 - a bats check", "1..10"],
      ["ok 1 - a passing check", "not ok 2 - a bats check", "1..9"],
    ).kind === "refused",
    "(index) the added-passing-tests TAP run whose failure renumbered hands back — the accepted cost",
  );
  // …and the same run with the failure NOT renumbered, which is the case that must keep excusing: new
  // `ok` lines and a moved plan are clean shapes, and nothing else moved.
  assert(
    excuseOf(
      ["ok 1 - a passing check", "ok 2 - a brand new passing check", "not ok 2 - a bats check", "1..10"],
      ["ok 1 - a passing check", "ok 2 - a brand new passing check", "not ok 2 - a bats check", "1..9"],
    ).kind === "excused",
    "(index) new `ok` lines and a moved plan still excuse while the failing line stands still",
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
