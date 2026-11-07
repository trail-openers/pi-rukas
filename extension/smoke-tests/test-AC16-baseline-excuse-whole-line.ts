#!/usr/bin/env bun
/**
 * #2064 round 3 — every allow-list arm vouches for the WHOLE LINE.
 *
 * Round 2 made the rule default-refuse: a head-only line is excused only when something
 * POSITIVE proves it cannot declare a failure. Round 2 still let three arms vouch for a line
 * by its PREFIX while the rest of the line said the opposite — `ok, the brand new deploy check
 * failed` opened with a pass marker and the arm stopped reading there; pytest's progress arm
 * admitted a row whose result run carried an `F`; and the tally arm folded any number whose
 * neighbour was a known counter word, so `999 crashed` folded away and a run that crashed 998
 * times instead of 999 looked like the line the base printed. The fourth arm, the harness echo,
 * vouched for a `Command failed:` line by a SUBSTRING of a base line.
 *
 * So this file pins the whole-line rule in the four places it was broken, and asks BOTH the
 * allow-list directly and the excuse itself — the second is what a green is actually graded on,
 * and a veto that only lived in `isKnownCleanLine` would still let the counter fold match a
 * moved crash count.
 *
 *   (veto) an `ok`-prefixed line that reports a failure anywhere in it refuses;
 *   (progress) a result row carrying an `F` or `E` glyph refuses, standalone AND as a
 *     base/head pair where the head gained the `F` — the row is a line the base never printed,
 *     so the excuse goes;
 *   (tally) a counted word that is NOT on the counter list — `crashed`, `aborted`, `panicked`,
 *     `segfault` — refuses when its count moves, and the same line with the same counts excuses;
 *   (echo) a `Command failed:` echo is vouched for only by a base line that IS the command, never
 *     by one that merely contains it;
 *   (control) every case the rule exists to excuse is still green: `pytest -v`'s new PASSED line,
 *     pytest's default dots-only progress, TAP `ok` lines whose names hold no failure word,
 *     `go test -v`, and the summary whose PASSED count moved.
 *
 * The veto's cost is stated where it is paid, in `docs/lean.md` and the troubleshooting entry:
 * a PASSING test whose NAME contains a failure word, when it is head-only, is refused — a
 * hand-back. That is the accepted direction, and it is the direction this file keeps pinned.
 */
import { classifyFailureLine } from "../src/work-driver-verify-failures.ts";
import { counterFolded } from "../src/lean/verify-baseline-counters.ts";
import { baselineExcuse } from "../src/lean/verify-baseline-excuse.ts";
import {
  isHarnessEchoOf,
  isKnownCleanLine,
} from "../src/lean/verify-baseline-allow-list.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC16-baseline-excuse-whole-line.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
const HEAD_ROOT = "/tmp/pi-rukas-2064-wholeline/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-wholeline/repo.baseline-lean-verify-9";

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

// ------------------------- (veto) a pass marker at the head of the line vouches for nothing
{
  // The three lines round 2 missed. Each opens with a real pass marker in a real runner's
  // dialect — TAP's `ok N - <name>`, and `ok` followed by prose — and each says somewhere
  // further along that something failed. The classifier does not read any of them as a failure
  // line (no `FAILED <path>::` shape, no `not ok`), so NOTHING but the whole-line veto refuses
  // them, and the classifier-first ordering of `isKnownCleanLine` cannot be leaned on here.
  const OK_PREFixed_FAILURE = [
    "ok, the brand new deploy check failed",
    "ok 4 - brand new check FAILED",
    "ok 3 - t/release.t the publish step failed",
  ];
  for (const line of OK_PREFixed_FAILURE) {
    assert(
      !isKnownCleanLine(line),
      `(veto) the allow-list does not vouch for "${line}" on its prefix alone (${isKnownCleanLine(line)})`,
    );
    assert(
      excuseOf([RED_LINE, line], [RED_LINE]).kind === "refused",
      `(veto) head-only "${line}" refuses the excuse (${excuseOf([RED_LINE, line], [RED_LINE]).kind})`,
    );
  }

  // The veto is a WORD veto, not a letter veto: a passing line whose name merely shares
  // characters with a failure word stays clean, and the fix is not "refuse anything noisy".
  const OK_PREFixed_CLEAN = [
    "ok 1 - the passing check",
    "ok 4 - t/release.t the publish step is fine",
    "ok, everything is fine",
    "PASS tests/deploy_check.py::test_deploy_ok",
  ];
  for (const line of OK_PREFixed_CLEAN) {
    assert(
      isKnownCleanLine(line),
      `(control) "${line}" still excuses — the veto reads words, not letters (${isKnownCleanLine(line)})`,
    );
  }
}

// ----------------------------------- (progress) an F glyph in the result run is a failed check
{
  const F_ROW = "tests/new_test.py ....F... [ 50%]";
  assert(
    !isKnownCleanLine(F_ROW),
    `(progress) a result row carrying an F is not a clean line (${isKnownCleanLine(F_ROW)})`,
  );
  assert(
    excuseOf([RED_LINE, F_ROW], [RED_LINE]).kind === "refused",
    `(progress) head-only "${F_ROW}" refuses the excuse (${excuseOf([RED_LINE, F_ROW], [RED_LINE]).kind})`,
  );

  // The same file at base and head, where head GAINED the F: the row is a line the base never
  // printed, and the percentage move is not evidence that it is the same row.
  const BASE_ROW = "tests/new_test.py .......  [ 40%]";
  const HEAD_ROW = "tests/new_test.py ....F..  [ 50%]";
  assert(
    excuseOf([RED_LINE, HEAD_ROW], [RED_LINE, BASE_ROW]).kind === "refused",
    `(progress) the same file's row gaining an F refuses the excuse (${excuseOf([RED_LINE, HEAD_ROW], [RED_LINE, BASE_ROW]).kind})`,
  );
  assert(
    excuseOf([RED_LINE, HEAD_ROW], [RED_LINE, HEAD_ROW]).kind === "excused",
    "(progress) and the identical F row at base is the base's own red, so it excuses",
  );

  // `s` (skipped) and `x` (expected-fail) are passes for this purpose; `E` is not. The
  // classifier does not read either row as a failure line, so both are the progress arm's
  // own answer and nothing else can refuse them.
  assert(
    isKnownCleanLine("tests/x.py ..s.x.  [ 60%]") &&
      classifyFailureLine("tests/x.py ..s.x.  [ 60%]") === undefined,
    "(progress) a row of . s and x is a passing row",
  );
  assert(
    classifyFailureLine("tests/x.py ..E...  [ 60%]") === undefined &&
      !isKnownCleanLine("tests/x.py ..E...  [ 60%]"),
    `(progress) a row carrying an E is not a passing row (classifier: ${String(classifyFailureLine("tests/x.py ..E...  [ 60%]"))}, clean: ${isKnownCleanLine("tests/x.py ..E...  [ 60%]")})`,
  );
}

// -------------------------------- (tally) a counted word is clean only by being a KNOWN counter
{
  // The inversion: a tally is admitted when EVERY `<number> <word>` pair names a counter, and
  // any other counted word refuses by absence. `crashed` was never on any list, and round 2's
  // fold erased its number because a known counter word sat next to it.
  const CRASH_TALLY = "===== 999 crashed, 9 passed =====";
  const CRASH_TALLY_MOVED = "===== 998 crashed, 9 passed =====";
  assert(
    !isKnownCleanLine(CRASH_TALLY),
    `(tally) a counted word that is not a counter keeps the line off the list (${isKnownCleanLine(CRASH_TALLY)})`,
  );
  assert(
    counterFolded(CRASH_TALLY) !== counterFolded(CRASH_TALLY_MOVED),
    `(tally) the crash count keeps its digits, so ${CRASH_TALLY} and ${CRASH_TALLY_MOVED} stay two lines (${counterFolded(CRASH_TALLY)} / ${counterFolded(CRASH_TALLY_MOVED)})`,
  );
  for (const [a, b] of [
    ["===== 999 crashed, 9 passed =====", "===== 998 crashed, 9 passed ====="],
    ["===== 3 panicked, 1 passed =====", "===== 4 panicked, 1 passed ====="],
    ["===== 2 aborted, 1 passed =====", "===== 5 aborted, 1 passed ====="],
    ["===== 1 segfault, 1 passed =====", "===== 2 segfault, 1 passed ====="],
  ] as const) {
    const pair = `base "${b}" / head "${a}"`;
    assert(
      excuseOf([RED_LINE, a], [RED_LINE, b]).kind === "refused",
      `(tally) a moved counted word refuses the excuse: ${pair} (${excuseOf([RED_LINE, a], [RED_LINE, b]).kind})`,
    );
    assert(
      excuseOf([RED_LINE, a], [RED_LINE, a]).kind === "excused",
      `(control) the same tally, unchanged, still excuses: ${pair} (${excuseOf([RED_LINE, a], [RED_LINE, a]).kind})`,
    );
  }

  // A counted word with no tally shape around it is refused by the shape arm — the counter
  // list is not asked to do the classifier's job, and it does not have to.
  assert(
    classifyFailureLine("999 crashed") === undefined && !isKnownCleanLine("999 crashed"),
    `(tally) a bare counted word is not a known-clean line on its own (classifier: ${String(classifyFailureLine("999 crashed"))}, clean: ${isKnownCleanLine("999 crashed")})`,
  );
}

// --------------------------------------- (echo) the base echoed the command, or it vouches for nothing
{
  const echoed = "Command failed: sh -c 'pnpm run lint'";
  // A base line that merely CONTAINS the command is not a record that the base ran it: the
  // substring form excused a head echoing a command neither run was asked to run, whenever any
  // base line quoted it in passing (a `make lint` step that also printed the pnpm invocation).
  assert(
    !isHarnessEchoOf(echoed, ["make check  # runs pnpm run lint too"], "make check"),
    "(echo) a base line that only CONTAINS the echoed command does not vouch for the echo",
  );
  assert(
    isHarnessEchoOf(echoed, ["sh -c 'pnpm run lint'"], "make check"),
    "(echo) a base line that IS the command still vouches for the echo",
  );
  assert(
    isHarnessEchoOf(echoed, [], "sh -c 'pnpm run lint'"),
    "(echo) and the tier's own command still vouches for its echo",
  );
}

// ------------------------------------- (control) everything the rule exists to excuse, still excused
{
  // The must-excuse set the brief names, kept whole: these are the lines a PR that ADDS
  // PASSING TESTS prints, and a veto that ate any of them would refuse the case the excuse
  // exists for. Each is asserted clean on its own AND as part of a full stream comparison.
  const CLEAN = [
    "PASSED tests/new_test.py::test_new",
    "tests/new_test.py ..  [100%]",
    "..s.                                      [ 50%]",
    "ok 1 - a passing check",
    "ok 5 - t/x.t # skip reason",
    "=== RUN   TestBrandNew",
    "--- PASS: TestBrandNew (0.00s)",
  ];
  for (const line of CLEAN) {
    assert(isKnownCleanLine(line), `(control) "${line}" is on the allow-list (${isKnownCleanLine(line)})`);
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
    `(control) the full added-passing-tests stream excuses — new pass lines, new progress row, moved passed count and total (${r.kind})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
