#!/usr/bin/env bun
/**
 * #2064 round 6 — the two folds the comparison may NOT use, pinned one per removed key.
 *
 * The comparison of head failure lines against base failure lines folds exactly one field: a runner's
 * own counters, and only on a line the classifier did not read as one check's failure ({@link
 * failureLineFold}). Within that, what may move is decided by ONE question asked of the whole line: does
 * its text name a failure ({@link declaresFailure})? This file pins the keys that used to sit beside the
 * fold and are deleted, because each excused a failure the base never printed:
 *
 *   (reporter) on a line that names a failure ANYWHERE, the only digit that may fold is one immediately
 *     followed by an explicit PASS word — `passed`, `skipped`, `deselected`, `xfailed`, `xpassed`,
 *     `warning(s)`. Everything else on that line stays exact. The counter arms answer "is the word next
 *     to this digit a counter?", and a counter word names a POPULATION, not a verdict: `items` is
 *     admitted for a tally's `36 items`, so `tests/x_test.py: 1 items failed` folded onto the `2` the
 *     head printed and a new failed check was excused as the base's. Same for `ran`/`tests` as LABELS —
 *     `suite ran: 1 failed` folded onto `suite ran: 2 failed` — and for the run's own total in `Tests
 *     run: 3, Failures: 1`. The refusal comes from the line's own text, since neither a label vocabulary
 *     nor a per-digit failure vocabulary can be closed; and
 *   (index) a runner's CHECK INDEX folds by nothing. `not ok 3 - x` is not the line a base printed as
 *     `not ok 1 - x`: the index is assigned by the order checks ran, so it says nothing about WHICH
 *     check printed the line, and a new failing check printed third folded onto the base's first.
 *
 * The accepted costs, all in the safe direction and all stated in `docs/lean.md` and the troubleshooting
 * entry: a TAP or bats run whose failing checks were RENUMBERED — the usual effect of adding a passing
 * test before them — now refuses; a passing test whose NAME carries a failure word is refused; and a
 * JUnit/Surefire `Tests run: 3, Failures: 1` → `Tests run: 5, Failures: 1` — passing tests added, the
 * run's own total moved — now hands back, because `run` is not a pass word. A hand-back, never a green.
 *
 * The counterpart of every refusal here is the must-move case: the PASSED half of the same summary still
 * folds, and on a line that names no failure the whole counter list still folds — so the fix is not
 * "fold nothing".
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

  // The fold's own boundary, stated exactly. On a line whose text names a failure ANYWHERE, the only
  // digit that may fold is one immediately followed by an explicit PASS word. `N items failed` puts a
  // word that IS on the counter list (`items`) beside the count of what broke, and the counter list
  // cannot tell a tally's item count from a failed-check row — so the line's own text is what decides,
  // and it says this row reports failures. Every digit on it keeps its digits.
  assert(
    classifyFailureLine("tests/x_test.py: 1 items failed") === undefined &&
      !isKnownCleanLine("tests/x_test.py: 1 items failed"),
    "(reporter) a `N items failed` row is no clean shape: the whole-line veto holds it in the stream",
  );
  assert(
    failureLineFold("tests/x_test.py: 1 items failed") !==
      failureLineFold("tests/x_test.py: 2 items failed"),
    "(reporter) the false green this rule exists to close: a bare `N items failed` row keeps its count",
  );
  assert(
    excuseOf(
      [RED_LINE, "tests/x_test.py: 1 items failed"],
      [RED_LINE, "tests/x_test.py: 2 items failed"],
    ).kind === "refused",
    "(reporter) and the excuse refuses a `N items failed` row whose count moved",
  );

  // The fold is not "refuse any line that mentions a failure word": the PASSED half of the same summary
  // still folds — that is the one digit a failure-reporting line may move. A `Tests run: N` total, by
  // contrast, no longer folds beside a `Failures:` count: `run` is not a pass word, and that is the
  // accepted cost stated in `docs/lean.md` and the troubleshooting entry.
  assert(
    failureLineFold("===== 1 failed, 3 passed =====") ===
      failureLineFold("===== 1 failed, 5 passed ====="),
    "(reporter) a moved passed count still folds beside the standing failure count",
  );
  assert(
    failureLineFold("Tests run: 3") === failureLineFold("Tests run: 5"),
    "(reporter) the Tests run: N total still folds on a line that names no failure",
  );
  assert(
    failureLineFold("Tests run: 3, Failures: 1") !==
      failureLineFold("Tests run: 5, Failures: 1"),
    "(reporter) the accepted cost: the same total beside a Failures count keeps its digits",
  );

  // And the must-move case through the excuse, as a whole stream: the field the rule exists to grant.
  assert(
    excuseOf(
      [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 5 passed ====="],
      [RED_LINE, "PASSED tests/x_test.py::test_b", "===== 1 failed, 3 passed ====="],
    ).kind === "excused",
    "(reporter) the summary whose PASSED half moved still excuses over a base that printed the same failure",
  );
  // …and the JUnit total that moved is the refusal by design, pinned through the excuse as well as the
  // key: passing tests added to a Surefire suite hand the run back rather than keep a fold that would
  // also have equalled a moved `Failures:` count.
  assert(
    excuseOf([RED_LINE, "Tests run: 5, Failures: 1"], [RED_LINE, "Tests run: 3, Failures: 1"]).kind ===
      "refused",
    "(reporter) the Surefire total that moved now refuses — the accepted cost, a hand-back not a green",
  );
  assert(
    excuseOf([RED_LINE, "Tests run: 5, Failures: 2"], [RED_LINE, "Tests run: 5, Failures: 1"]).kind ===
      "refused",
    "(reporter) the same Surefire shape whose Failures count moved still refuses",
  );
  // A line that names no failure still folds its totals and durations freely, so the narrowing is
  // confined to lines the veto reads as failure-reporting.
  assert(
    failureLineFold("Tests: 5 passed, 5 total") === failureLineFold("Tests: 7 passed, 7 total"),
    "(reporter) a pass-only tally still folds every count on the counter list",
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
