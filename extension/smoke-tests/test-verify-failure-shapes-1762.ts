#!/usr/bin/env bun
/**
 * #1762 — the failure-line table read DIRECTLY: one case per runner dialect,
 * the prose that must never classify, the counted tallies, and the wrapper.
 *
 * This is the first half of the suite that #1762 grew (the tehas-stream,
 * `\r`-stream, host-exhaustion, ci-tier and corrective-round cases are in
 * `test-verify-failure-shapes-b-1762.ts`); the fixtures both halves read are
 * in `lib/verify-failure-shapes-fixtures.ts` (AGENTS.md §12 file-size limit).
 *
 * The measured defect: four recognisers each admitted only `FAILED: <x>` and
 * `✗ <x>`, so a project gate that speaks another runner's dialect anchored
 * nowhere. On tehas v0.14.2 nine verify parks named no failing assertion and
 * the handoff quoted `pack_release_test.sh: 36 cases, 0 failed` — a PASSING
 * stage — as the evidence, while the runner's own `test.sh: failed checks (1)`
 * block sat earlier in the same window.
 *
 * Every fixture here is synthetic output the driver was fed in production.
 */

import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { decideCorrectiveRound } from "../src/work-driver-corrective-decide.ts";
import type { CorrectiveGateView } from "../src/work-driver-corrective-decide.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  depsHintStartFor,
  failureLines,
  isSuccessLine,
} from "../src/work-driver-verify-failures.ts";
import { depsHintApplies } from "../src/work-driver-verify-record.ts";
import { CHECKS_BLOCK, CMD, WT, makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 1. one case per shape ────────────────────────────────────────────────────
const SHAPES: Array<[string, string, boolean]> = [
  ["FAILED: extension/smoke-tests/test-x.ts", "failed-marker", false],
  ["✗ expected 5 got 6", "assertion-mark", true],
  ["error TS2345: Argument of type 'string' is not assignable", "diagnostic", true],
  ["error: cannot compile", "diagnostic", true],
  ["error[E0308]: mismatched types", "diagnostic", true],
  ["scripts/pack_release_test.sh: failed checks (1)", "script-tally", true],
  ["scripts/test.sh: 3 failed", "named-file", true],
  ["not ok 3 - the console's tests", "tap-not-ok", true],
  ["FAILED tests/test_auth.py::test_login", "pytest-failed", true],
  ["ERROR tests/test_auth.py::test_login", "pytest-error", true],
  ["--- FAIL: TestThing (0.31s)", "go-fail", true],
];
for (const [line, shape, names] of SHAPES) {
  const got = classifyFailureLine(line);
  assert(
    got !== undefined && got.shape === shape && got.namesTest === names,
    `shape: ${JSON.stringify(line)} -> ${shape} (namesTest ${names}), got ${JSON.stringify(got)}`,
  );
}

// ── 2. the success-line negatives ────────────────────────────────────────────
const SUCCESS = [
  "pack_release_test.sh: 36 cases, 0 failed",
  "test_auth_test.sh: 36 cases, 0 failed",
  "ok 24 - the console's tests",
  "✓ 3 other checks",
  "PASS  Test Suite (1000 ms)",
  "test result: 23 passed, 0 failed",
  "Checked 276 files in 61ms. No fixes applied.",
  "12 passed",
  "book the token for the lookup",
  "OK",
  "  ",
];
for (const line of SUCCESS) {
  assert(
    classifyFailureLine(line) === undefined,
    `negative: ${JSON.stringify(line)} is never a failure line`,
  );
}
assert(failureLines(SUCCESS.join("\n")).length === 0, "negative: a passing stream yields nothing");

// ── 2b. prose that merely contains a failure VERB is not a named-file line ───
// The rule these killed: the table matched `error`, `cannot` and
// `not found` ANYWHERE after an extension-bearing token, with no separator, so
// ordinary prose classified, became the anchor with `attributed: true`, and
// could earn the cycle a corrective round over a sentence that names no check.
{
  const PROSE = [
    "index.ts: fatal error",
    "index.ts: cannot parse",
    "src/a.ts: consider this error case",
    "index.ts: this error is expected in prose",
    "index.ts: not found in the fixture, which is fine",
    "a.ts: the parser cannot handle this and that is intentional",
  ];
  for (const line of PROSE) {
    assert(
      classifyFailureLine(line) === undefined,
      `prose: ${JSON.stringify(line)} is not a named-file failure`,
    );
  }
  assert(
    failureLines(PROSE.join("\n")).length === 0,
    "prose: a stream of such lines yields no failure line",
  );
  assert(
    extractAttributedTail(`build output\n${PROSE.join("\n")}`, 800).attributed === false,
    "prose: such a stream is never attributed, so it cannot anchor the evidence",
  );

  // The accepted shapes, each spelled out (the brief's list, and the tehas
  // summary the #1762 park depends on). The counted-tally cases carry no
  // `passed` half, so they do not depend on the mixed-tally rule pinned below;
  // the comma-tally form `36 cases, 1 failed` IS a failure and lives in that
  // block, not in the prose list.
  const NAMED: Array<[string, string]> = [
    ["a.ts: failed", "named-file"],
    ["a.ts: FAILED", "named-file"],
    ["a.ts: FAIL", "named-file"],
    ["a.ts: ERROR", "named-file"],
    ["a.ts   FAILED", "named-file"],
    ["a.ts: 3 failed", "named-file"],
    ["a.ts: 2 errors", "named-file"],
    ["a.ts: 1 failure", "named-file"],
    ["FAIL a.ts", "named-file"],
    [CHECKS_BLOCK, "script-tally"],
  ];
  for (const [line, shape] of NAMED) {
    const got = classifyFailureLine(line);
    assert(
      got !== undefined && got.shape === shape && got.namesTest,
      `named-file: ${JSON.stringify(line)} classifies as ${shape}, got ${JSON.stringify(got)}`,
    );
  }
  assert(
    classifyFailureLine("a.ts: 0 failed") === undefined,
    "named-file: a zero count reports success, not failure",
  );
  assert(
    classifyFailureLine("a.ts: failed checks (0)") === undefined,
    "named-file: a zero-count failed-checks tally reports success, not failure",
  );

  // The pass veto must not swallow a tally that also reports a NON-ZERO failure
  // count: the passing half of `1 failed, 3 passed` does not cancel the
  // failing half. What stays excluded is a line with no such count.
  for (const [line, shape] of [
    ["test.sh: 1 failed, 3 passed", "named-file"],
    ["pack_release_test.sh: 36 cases, 1 failed", "named-file"],
    ["x.sh: 2 errors, 10 passed", "named-file"],
  ] as Array<[string, string]>) {
    const got = classifyFailureLine(line);
    assert(
      got !== undefined && got.shape === shape,
      `mixed tally: ${JSON.stringify(line)} classifies as ${shape}, got ${JSON.stringify(got)}`,
    );
  }
  for (const line of ["x.sh: 36 cases, 0 failed", "12 passed"]) {
    assert(
      classifyFailureLine(line) === undefined,
      `mixed tally: ${JSON.stringify(line)} still reports success`,
    );
  }
}

// ── 2e. the deps hint is never chosen as the gate's stream ─────────────────
// `provisionDepsHint` is appended to the harness's own sentence, BEFORE
// `formatExecError` appends the gate's tail, and the `hook-failed` shape
// contains a `: ` of its own (`… during provisioning: <problem>`). Cutting at
// that colon quotes the harness's own diagnosis as the gate's output — the
// #1667 suppression, backwards: a line the driver wrote becomes evidence and
// `depsHintApplies` then keeps a hint it exists to suppress.
{
  const HINT_PROBLEM = "Cannot find module 'react' in node_modules";
  const hinted = (tail: string): string =>
    `verify command \`${CMD}\` failed in ${WT} — the \`.pi/worktree-setup\` hook failed during provisioning: ${HINT_PROBLEM}${tail}`;
  assert(
    depsHintStartFor(hinted("")) !== undefined,
    "deps hint: the hint's start is found in the composed wrapper",
  );
  assert(
    classifyFailureLine(hinted("\nnothing to see here")) === undefined,
    `deps hint: a hint whose problem text looks like a failure is not classified as one (got ${JSON.stringify(classifyFailureLine(hinted("\nnothing to see here")))})`,
  );
  assert(
    depsHintApplies(hinted("\nnothing to see here")) === true,
    "deps hint: the hint still applies when the gate printed nothing assertable",
  );
  // …and the real gate line beneath the hint is still reached — excluding the
  // hint must not swallow the builder's own separator, which sits right after
  // the hint's colon.
  assert(
    classifyFailureLine(hinted(`\n${CHECKS_BLOCK}`))?.shape === "script-tally",
    `deps hint: the gate's own line beneath the hint still classifies (got ${JSON.stringify(classifyFailureLine(hinted(`\n${CHECKS_BLOCK}`)))})`,
  );
}

// ── 2f. a pathological single line costs a constant, not the square ────────
// The classifier is quadratic in line length: the wrapper prefix's lazy `.+?`
// backtracks once per `: ` it finds and the tally branches' `[^\r\n]*` does the
// same. A gate that prints a serialized fixture on one line used to cost
// seconds per line, and a whole suite of them stops the gate. The scan window
// makes the cost of one line constant.
{
  const huge = `${"x".repeat(1200)}: `.repeat(1500); // 200 KB, 1500 `: ` candidates
  const started = Date.now();
  const got = classifyFailureLine(huge);
  const ms = Date.now() - started;
  assert(got === undefined, `bound: a 200 KB line of separators classifies as nothing`);
  assert(
    ms < 500,
    `bound: a 200 KB single line classifies in under 500 ms (took ${ms} ms; window ${FAILURE_LINE_SCAN_MAX})`,
  );
  assert(
    FAILURE_LINE_SCAN_MAX === 8 * 1024,
    `bound: the scan window is the exported 8 KiB (got ${FAILURE_LINE_SCAN_MAX})`,
  );
  // The window must not lose a real shape: a status keyword in the first 8 KiB
  // is still the line the table recognises.
  assert(
    classifyFailureLine(`${CHECKS_BLOCK}${"y".repeat(200000)}`)?.shape === "script-tally",
    "bound: a real failure shape at the head of a huge line still classifies",
  );
}

// ── 2g. isSuccessLine asserted directly, not only through the classifier ───
// The classifier asks this first and every passing veto in the table depends on
// it, so a change that keeps `classifyFailureLine` green while breaking the
// predicate (an inverted count guard, say) must still fail here.
{
  const YES: string[] = [
    "✓ 3 other checks",
    "ok 24 - the console's tests",
    "PASS  Test Suite (1000 ms)",
    "test result: 23 passed, 0 failed",
    "pack_release_test.sh: 36 cases, 0 failed",
    "scripts/test.sh: failed checks (0)",
    "0 errors",
    "12 passed",
  ];
  const NO: string[] = [
    "scripts/test.sh: failed checks (1)",
    "a.ts: 3 failed",
    "✗ expected 5 got 6",
    "not ok 3 - the console's tests",
    "",
    "   ",
    "index.ts: fatal error",
  ];
  for (const line of YES) {
    assert(isSuccessLine(line) === true, `isSuccessLine: ${JSON.stringify(line)} is a success`);
  }
  for (const line of NO) {
    assert(
      isSuccessLine(line) === false,
      `isSuccessLine: ${JSON.stringify(line)} is not a success`,
    );
  }
}

// ── 2c. a line the harness wrapped is classified on its inner stream ───────
// The harness composes `verify command \`cmd\` failed in <cwd>: <stream>`; the
// first version of this used the stream only as an existence veto and then
// matched the WHOLE wrapped line, so every anchored shape (`^✗\s`,
// `^ERROR \S+::`, `^--- FAIL:`) fell through while the same line unwrapped
// classified. The wrapper itself must stay unclassified when nothing behind it
// reports a failure — that is #1667's no-assertion exemption.
{
  const WRAPPED: Array<[string, string]> = [
    ["not ok 3 - x", "tap-not-ok"],
    ["--- FAIL: TestX (0.31s)", "go-fail"],
    ["ERROR t.py::t", "pytest-error"],
    ["FAILED t.py::t", "pytest-failed"],
    ["\u2717 x", "assertion-mark"],
    [CHECKS_BLOCK, "script-tally"],
  ];
  for (const [inner, shape] of WRAPPED) {
    const line = `verify command \`${CMD}\` failed in ${WT}: ${inner}`;
    const got = classifyFailureLine(line);
    assert(
      got !== undefined && got.shape === shape,
      `wrapped: ${JSON.stringify(inner)} behind the harness reports ${shape}, got ${JSON.stringify(got)}`,
    );
    // A cwd that contains a colon must not change the answer — the cut is the
    // builder's `: `, not the first colon in the line.
    const colonCwd = `verify command \`${CMD}\` failed in /wt/a:b/c: ${inner}`;
    assert(
      classifyFailureLine(colonCwd)?.shape === shape,
      `wrapped: a cwd containing a colon still classifies as ${shape}, got ${JSON.stringify(classifyFailureLine(colonCwd))}`,
    );
  }

  // A wrapped stream with no failure shape stays undefined: the harness saying
  // a run exited non-zero is not evidence, and this is the case the whole
  // no-assertion suite of #1667 rests on.
  for (const inner of ["something went wrong", "expected 1, got 2", "12 passed"]) {
    assert(
      classifyFailureLine(`verify command \`${CMD}\` failed in ${WT}: ${inner}`) === undefined,
      `wrapped: ${JSON.stringify(inner)} behind the harness is not a failure line`,
    );
  }
  // And a deps hint that carries its own `: ` (the hook-failed shape) must not
  // hide the gate's own failure line behind it.
  const hinted =
    `verify command \`${CMD}\` failed in ${WT} — the \`.pi/worktree-setup\` hook failed ` +
    `during provisioning: src/gate.sh exited 1\n${CHECKS_BLOCK}`;
  assert(
    classifyFailureLine(hinted) !== undefined,
    "wrapped: a deps hint carrying its own colon does not hide the gate's failure line",
  );
  const hintedClean =
    `verify command \`${CMD}\` failed in ${WT} — the \`.pi/worktree-setup\` hook failed ` +
    "during provisioning: src/gate.sh exited 1\nnothing to see here";
  assert(
    classifyFailureLine(hintedClean) === undefined,
    "wrapped: a hint-only tail with no failure shape stays unclassified",
  );

  // A wrapped `FAILED:` MARKER is the one case where classification and
  // assertion-hood disagree, and the disagreement is the #798 defect arriving
  // through the wrapper: the marker is a valid ANCHOR for the evidence tail,
  // but never an ASSERTION. Judging the WRAPPER text (which is what the first
  // version did — `IS_MARKER_LINE` was tested against the wrapper, not the
  // inner line) reported the harness sentence as "the specific assertion" and
  // spent the cycle's one corrective round on it.
  const wrappedMarker = `verify command \`${CMD}\` failed in ${WT}: FAILED: b.ts\nsomething went wrong`;
  assert(
    classifyFailureLine(wrappedMarker) !== undefined,
    "wrapped marker: the stream behind the harness still reports a failure, so the tail anchors",
  );
  assert(
    extractSpecificAssertion(wrappedMarker) === NO_SPECIFIC_ASSERTION,
    `wrapped marker: a wrapped FAILED: marker is never the specific assertion (got ${JSON.stringify(extractSpecificAssertion(wrappedMarker))})`,
  );
  {
    const text = wrappedMarker;
    const gate: CorrectiveGateView = {
      ok: false,
      failures: [text],
      verifyRun: {
        status: "ran",
        command: CMD,
        failures: [text],
        perWorktree: [{ cwd: WT, text }],
      },
    };
    const d = decideCorrectiveRound(gate, { eventLog: [], worktrees: { a: WT } });
    assert(
      d.round === false,
      `wrapped marker: no corrective round is spent on a wrapped FAILED: marker (${JSON.stringify(d)})`,
    );
  }
  // The same wrapper with a real assertion beneath it still earns the round,
  // and the developer is given the ✗ line — not the harness sentence.
  const wrappedAssertion = `verify command \`${CMD}\` failed in ${WT}: FAILED: b.ts\n\u2717 b.ts: expected x`;
  assert(
    extractSpecificAssertion(wrappedAssertion) === "\u2717 b.ts: expected x",
    `wrapped marker: the ✗ line beneath the wrapped marker is the assertion (got ${JSON.stringify(extractSpecificAssertion(wrappedAssertion))})`,
  );
  {
    const text = wrappedAssertion;
    const gate: CorrectiveGateView = {
      ok: false,
      failures: [text],
      verifyRun: {
        status: "ran",
        command: CMD,
        failures: [text],
        perWorktree: [{ cwd: WT, text }],
      },
    };
    const d = decideCorrectiveRound(gate, { eventLog: [], worktrees: { a: WT } });
    assert(
      d.round === true,
      `wrapped marker: a real assertion beneath the wrapped marker still earns the round (${JSON.stringify(d)})`,
    );
    if (d.round) {
      assert(
        (d.targets[0]?.lines ?? []).join("|") === "\u2717 b.ts: expected x",
        `wrapped marker: the developer is given the ✗ line, not the wrapper (got ${JSON.stringify(d.targets[0]?.lines)})`,
      );
    }
  }
}

// ── 4. `not ok` beats `ok` ───────────────────────────────────────────────────
{
  const tap = "ok 1 - first\nnot ok 2 - second\nok 3 - third";
  const lines = failureLines(tap);
  assert(
    lines.length === 1 && lines[0]?.startsWith("not ok 2"),
    `tap: only 'not ok' classifies (got ${JSON.stringify(lines)})`,
  );
  assert(classifyFailureLine("not ok 1 - x")?.shape === "tap-not-ok", "tap: shape is tap-not-ok");
}

console.log(failed() ? "\nFAILED" : "\nAll #1762 failure-table checks passed.");
process.exit(failed() ? 1 : 0);
