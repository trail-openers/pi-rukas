#!/usr/bin/env bun
/**
 * #2064 — the lines the excuse reads, and what refuses the whole excuse.
 *
 * With the pytest identity parser gone the reader has one rule: a failure line is a
 * failure LINE. Three consequences this file pins, none of which an identity parser
 * could have satisfied:
 *
 *   (lines) every recognised line of a stream reads back as its own comparable text,
 *     in stream order and deduplicated — a summary the runner repeats is one line, not
 *     two failures;
 *   (unreadable) a line carrying a runner's failure token that the classifier does not
 *     recognise is simply not a line the excuse reads — the empty recognised set is what
 *     refuses, so a base whose only line is unreadable names nothing. What the deleted
 *     allow-list added on top (a head-only unread line refusing because nothing vouched
 *     for it) is gone, and the pins below are the new boundary: a RECOGNISED line printed
 *     only at head refuses, and only an unread line the base printed identically is inert;
 *   (head-only) the shapes the allow-list, the counter fold and the harness exemptions
 *     used to discount — a moved pass-count summary, `PASSED x` / `--- PASS:`, a
 *     `Command failed:` echo, a `$` trace, a bare `Exit code: 1` — are each refused now
 *     unless the base printed the identical line;
 *   (over-window) a raw line past the classifier's own scan window REFUSES the excuse
 *     too. The classifier judges such a line on its first 8 KiB, so two lines differing
 *     only past the window can fold onto one comparison key — the folding this module
 *     exists to prevent, arriving through length instead of through a token parser.
 *
 * The controls keep each guard from being a blanket refusal.
 */
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine as classify,
} from "../src/work-driver-verify-failures.ts";
import {
  PREEXISTING_NAME_MAX_CHARS,
  preexistingFailuresProblem,
} from "../src/lean/state-outcome-maps.ts";
import { baselineExcuse, failureLinesOf } from "../src/lean/verify-baseline-excuse.ts";
import type { BaseProbe } from "../src/lean/verify-baseline.ts";

const SELF = "test-AC8b-baseline-excuse-identity.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const RED: BaseProbe = { status: "red" };
/** Two trees that are definitely different directories. */
const HEAD_ROOT = "/tmp/pi-rukas-2064-id/worktree";
const PROBE_ROOT = "/tmp/pi-rukas-2064-id/repo.baseline-lean-verify-9";

/** One comparison, on the lines each run printed. */
function excuseOf(headLines: string[], baseLines: string[], cmd = "sh -c 'pytest'") {
  return baselineExcuse({
    tierName: "fast",
    cmd,
    baseSha: "a".repeat(40),
    probe: RED,
    headStream: headLines.join("\n"),
    baseStream: baseLines.join("\n"),
    headRoot: HEAD_ROOT,
    probeRoot: PROBE_ROOT,
  });
}

// --------------------------------------------------------------------- (lines)
{
  const STREAM = [
    "built 14 packages in 3s",
    "FAILED a.py::t[1] - AssertionError",
    "not ok 1 - a bats check",
    "FAILED a.py::t[1] - AssertionError",
  ].join("\n");
  const read = failureLinesOf(STREAM);
  assert(
    read.join("\n") === "FAILED a.py::t[1] - AssertionError\nnot ok 1 - a bats check",
    `(lines) each recognised line reads back once, in stream order, prose excluded (${JSON.stringify(read)})`,
  );
  assert(
    excuseOf([STREAM.split("\n")[1] as string], [STREAM.split("\n")[1] as string]).kind ===
      "excused",
    `(lines) and a pair of identical lines excuses — the reader is not a blanket refusal (${excuseOf([STREAM.split("\n")[1] as string], [STREAM.split("\n")[1] as string]).kind})`,
  );
}

// --------------------------------------------- (unreadable) what the reader ignores
{
  const A = "FAILED tests/x_test.py::test_a - AssertionError";
  // A collection error and a bare file verdict declare a failing test in a dialect the
  // shared table does not carry, so `failureLines` drops both. That alone is not a
  // refusal any more — nothing is left to vouch for or against a head-only unread line —
  // so what refuses is the EMPTY set: a base whose only line the classifier never read
  // names nothing, and an excuse cannot be graded on nothing.
  const COLLECTION_ERROR = "ERROR tests/test_brand_new.py";
  const BARE_FAILED = "FAILED tests/y.py";
  assert(
    failureLinesOf(COLLECTION_ERROR).length === 0 && failureLinesOf(BARE_FAILED).length === 0,
    `(unreadable) neither bare line is offered as a comparable line (${JSON.stringify(failureLinesOf(BARE_FAILED))})`,
  );
  assert(
    excuseOf([A], [BARE_FAILED]).kind === "refused",
    `(unreadable) a base whose only line is unreadable names nothing, and refuses (${excuseOf([A], [BARE_FAILED]).kind})`,
  );
  assert(
    excuseOf([BARE_FAILED], [A]).kind === "refused",
    `(unreadable) a head whose only line is unreadable names nothing either (${excuseOf([BARE_FAILED], [A]).kind})`,
  );
  assert(
    excuseOf([A], [A]).kind === "excused",
    "(unreadable) the recognised pair without such a line still excuses (not a blanket refusal)",
  );
  // A line the classifier does not read is not evidence about which check failed, so it
  // is INERT: it neither refuses nor excuses. The old default-refuse gate turned a
  // head-only one of these into a refusal by asking the allow-list whether it was provably
  // clean; with the allow-list gone there is no such question, and the recognised pair on
  // both sides decides. What still refuses through this door is a stream whose recognised
  // set is EMPTY — nothing the classifier read is not evidence the base was red.
  const TAP_COMMENT = "# not ok 9 - /t/brand_new.t - boom";
  const SHELL_TRACE = "+ not ok 7 - a trace line the table does not carry";
  assert(
    failureLinesOf(TAP_COMMENT).length === 0 && failureLinesOf(SHELL_TRACE).length === 0,
    `(unreadable) neither a TAP comment nor a shell trace is a line the classifier reads (${JSON.stringify(failureLinesOf(TAP_COMMENT))})`,
  );
  for (const [shape, line] of [
    ["TAP comment", TAP_COMMENT],
    ["shell trace", SHELL_TRACE],
  ] as const) {
    assert(
      excuseOf([A, line], [A]).kind === "excused" &&
        excuseOf([A], [A, line]).kind === "excused",
      `(unreadable) an unread ${shape} is inert on either side — the recognised pair decides (${excuseOf([A, line], [A]).kind}/${excuseOf([A], [A, line]).kind})`,
    );
    assert(
      excuseOf([line], []).kind === "refused" && excuseOf([A], [line]).kind === "refused",
      `(unreadable) and the same ${shape} as the only line of a stream refuses on the empty set (${excuseOf([line], []).kind}/${excuseOf([A], [line]).kind})`,
    );
  }
}

// --------------------- (head-only) every shape the old exemptions discounted refuses
{
  // The allow-list vouched for a head-only PASS marker, the counter fold placed a runner
  // summary whose pass count moved, and the harness arms excused the executor's own
  // writing. All three are gone. The unit of comparison is a line the classifier READS, so
  // the shapes that carry no verdict (`PASSED x`, `--- PASS:`, `Command failed: …`, a `$`
  // trace) are simply invisible to the rule — the pins below prove that, and would stay
  // green for the wrong reason if read as refusals. What the rule DOES refuse now, and the
  // old seam excused, is a recognised line that differs by anything at all: a moved runner
  // counter, a shifted check index. Each case is paired with the identical-lines control
  // that excuses, so a refusal is attributed to the move and not to the reader.
  const A = "FAILED tests/x_test.py::test_a - AssertionError";
  const INVISIBLE: ReadonlyArray<readonly [string, string]> = [
    ["a new passing pytest check", "PASSED tests/x.py::t_new"],
    ["a new passing go check", "--- PASS: TestNew (0.11s)"],
    ["the harness's echo of a command", "Command failed: sh -c 'pytest'"],
    ["a traced command line", "$ sh -c 'pytest'"],
  ];
  for (const [shape, line] of INVISIBLE) {
    assert(
      classify(line) === undefined && failureLinesOf(line).length === 0,
      `(head-only) the ${shape} is not a line the classifier reads (${JSON.stringify(classify(line))})`,
    );
    assert(
      excuseOf([A, line], [A]).kind === "excused",
      `(head-only) a head-only ${shape} is invisible to the comparison, so the recognised pair decides (${excuseOf([A, line], [A]).kind})`,
    );
  }
  // A runner's summary is the case the counter fold existed to place: a suite already red
  // at base that GAINS passing tests prints a different tally line, and with no fold that
  // line is one the base never printed. The classifier must READ the line for this to be a
  // refusal rather than an omission — otherwise both sets are the same named failures.
  const HEAD_SUMMARY = "pack_release_test.sh: 36 cases, 1 failed, 5 passed in 0.44s";
  const BASE_SUMMARY = "pack_release_test.sh: 36 cases, 1 failed, 3 passed in 0.42s";
  assert(
    classify(HEAD_SUMMARY) !== undefined && classify(BASE_SUMMARY) !== undefined,
    "(head-only) both pass-count summaries are lines the classifier reads, so the moved count is visible to the rule",
  );
  assert(
    excuseOf([HEAD_SUMMARY], [BASE_SUMMARY]).kind === "refused",
    `(head-only) a moved pass count on a red suite's summary refuses the excuse (${excuseOf([HEAD_SUMMARY], [BASE_SUMMARY]).kind})`,
  );
  assert(
    excuseOf([HEAD_SUMMARY], [HEAD_SUMMARY]).kind === "excused",
    `(head-only) and the same summary at base excuses, so the refusal is the move (${excuseOf([HEAD_SUMMARY], [HEAD_SUMMARY]).kind})`,
  );
  // The harness's own wrapper sentence is the shape the harness module discounted by WHO
  // wrote the line. The classifier unwraps it, so the gate's verdict behind `verify command
  // … failed in …` is a line it READS — and a head-only one of those used to be excused on
  // its harness prefix. It now refuses, and only the base's copy of the same sentence (its
  // own tree's prefix out of it) settles it.
  const WRAPPED_HEAD = `verify command \`pytest\` failed in ${HEAD_ROOT}: ${A}`;
  const WRAPPED_BASE = `verify command \`pytest\` failed in ${PROBE_ROOT}: ${A}`;
  assert(
    classify(WRAPPED_HEAD) !== undefined && failureLinesOf(WRAPPED_HEAD).length === 1,
    `(head-only) the harness's wrapper carrying a verdict is a line the classifier reads (${JSON.stringify(classify(WRAPPED_HEAD)?.shape)})`,
  );
  assert(
    excuseOf([WRAPPED_HEAD], [A]).kind === "refused",
    `(head-only) a head-only harness-wrapped verdict refuses — the wrapper excuses nothing (${excuseOf([WRAPPED_HEAD], [A]).kind})`,
  );
  assert(
    excuseOf([WRAPPED_HEAD], [WRAPPED_BASE]).kind === "excused",
    `(head-only) and the base's own wrapper sentence for the same check excuses (${excuseOf([WRAPPED_HEAD], [WRAPPED_BASE]).kind})`,
  );
  // A TAP runner numbers its checks in the order they ran, so a renumbered failure is a
  // different line, and no fold is left to place it.
  assert(
    excuseOf(["not ok 3 - checkout - expected 3 got 4"], ["not ok 1 - checkout - expected 3 got 4"]).kind ===
      "refused",
    "(head-only) a renumbered TAP check refuses — the index is part of the line",
  );
}

// ------------------------------------------------------ (over-window) one long line
{
  // A line past the classifier's own scan window is judged on its first 8 KiB, so the
  // tail — where two distinct checks differ — is invisible to the judge. Two such lines
  // can fold onto one comparison key, which is the defect whole-line comparison exists to
  // close. The rule is not "compare what was seen": a line no judge fully saw is not
  // evidence, so it refuses on either side.
  const PAD = "x".repeat(FAILURE_LINE_SCAN_MAX);
  const LONG_A = `not ok 1 - checkout ${PAD} variant alpha`;
  const LONG_B = `not ok 1 - checkout ${PAD} variant omega`;
  assert(
    LONG_A.length > FAILURE_LINE_SCAN_MAX && LONG_B.length > FAILURE_LINE_SCAN_MAX,
    `(over-window) both fixture lines really are past the window (${String(LONG_A.length)} vs ${String(FAILURE_LINE_SCAN_MAX)})`,
  );
  assert(
    excuseOf([LONG_A], [LONG_B]).kind === "refused",
    `(over-window) two long lines differing only past the window refuse — they must not fold (${excuseOf([LONG_A], [LONG_B]).kind})`,
  );
  assert(
    excuseOf([LONG_A], [LONG_A]).kind === "refused",
    `(over-window) an identical over-long pair refuses too — the line itself is not evidence (${excuseOf([LONG_A], [LONG_A]).kind})`,
  );
  assert(
    excuseOf([LONG_A], [LONG_A]).kind === "refused" &&
      excuseOf(["not ok 1 - checkout"], ["not ok 1 - checkout"]).kind === "excused",
    "(over-window) and a line inside the window still excuses (the veto is not a blanket refusal)",
  );
  // The wrapper shape is the one that actually folded: the harness prefix pushes the
  // gate's own text past the window, so the table read only the head of one check and
  // answered for both.
  const WRAPPED_A = `verify command \`prove -r t\` failed in ${PROBE_ROOT}: ${LONG_A}`;
  const WRAPPED_B = `verify command \`prove -r t\` failed in ${PROBE_ROOT}: ${LONG_B}`;
  assert(
    excuseOf([WRAPPED_A], [WRAPPED_B]).kind === "refused",
    `(over-window) two distinct harness-wrapped long lines refuse (${excuseOf([WRAPPED_A], [WRAPPED_B]).kind})`,
  );
}

// -------------------------------------------------- (paths) only a LEADING root comes out
{
  // The tree prefix is where a run's own tree sits. A root that appears anywhere else in
  // the line is CONTENT the tier printed — a path quoted in an assertion — and the other
  // tree's line carries it too, so removing it from one side and not the other erases a
  // difference the excuse then excused.
  const MID = `not ok 1 - checkout - ${HEAD_ROOT}/t/other.t is quoted mid-line`;
  assert(
    failureLinesOf(MID)[0]?.includes(HEAD_ROOT) === true,
    `(paths) a mid-line occurrence of the run's own root is KEPT (${JSON.stringify(failureLinesOf(MID)[0]?.slice(0, 60))})`,
  );
  assert(
    excuseOf([MID], [`not ok 1 - checkout - /somewhere/else/t/other.t is quoted mid-line`]).kind ===
      "refused",
    `(paths) and so a head line quoting its own tree refuses over a base that quoted another (${excuseOf([MID], [`not ok 1 - checkout - /somewhere/else/t/other.t is quoted mid-line`]).kind})`,
  );
}

// ----------------------------------------------------------- (record) an over-long line
{
  // A line past the step log's bound cannot be persisted, and the log's own reader is
  // what says so. `names` is a DISPLAY preview and is clipped here, where the excuse is
  // still the caller's to forfeit; the record then goes to the reader that will judge it,
  // and the two cannot disagree.
  const LONG = `FAILED tests/${"d".repeat(240)}_test.py::test_a - AssertionError`;
  assert(
    LONG.length > PREEXISTING_NAME_MAX_CHARS,
    `(record) the fixture line really is over the log's bound (${String(LONG.length)} chars)`,
  );
  assert(
    preexistingFailuresProblem({
      fast: { cmd: "c", names: [LONG], total: 1, baseSha: "a".repeat(40) },
    }) !== undefined,
    "(record) the log's own reader really does refuse that line (the two cannot disagree)",
  );
  const r = excuseOf([LONG], [LONG]);
  assert(
    r.kind === "excused",
    `(record) a line both runs printed that fits the comparison still excuses (${r.kind})`,
  );
  assert(
    r.kind === "excused" &&
      r.record.names.every((n) => n.length <= PREEXISTING_NAME_MAX_CHARS) &&
      preexistingFailuresProblem({ fast: r.record }) === undefined,
    `(record) every DISPLAYED line is inside the bound and validates (${String(r.kind === "excused" ? r.record.names[0]?.length : -1)})`,
  );
  assert(
    r.kind === "excused" && !("baseNames" in r.record),
    `(record) the record carries no base name set for ci to replay (${JSON.stringify(Object.keys(r.kind === "excused" ? r.record : {}))})`,
  );
  assert(
    r.kind === "excused" && r.record.total === 1,
    `(record) the total counts the line, not the clip (${String(r.kind === "excused" ? r.record.total : -1)})`,
  );
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
