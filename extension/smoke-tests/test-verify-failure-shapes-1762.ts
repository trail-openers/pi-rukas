#!/usr/bin/env bun
/**
 * #1762 — one failure-line table for every verify reader, and #1770 — the ci
 * tier keeps stdout.
 *
 * The measured defect: four recognisers each admitted only `FAILED: <x>` and
 * `✗ <x>`, so a project gate that speaks another runner's dialect anchored
 * nowhere. On tehas v0.14.2 nine verify parks named no failing assertion and
 * the handoff quoted `pack_release_test.sh: 36 cases, 0 failed` — a PASSING
 * stage — as the evidence, while the runner's own `test.sh: failed checks (1)`
 * block sat earlier in the same window.
 *
 * Every fixture here is synthetic output the driver was fed in production; the
 * tehas stream is the shape from work-413 / work-518.
 */

import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { decideCorrectiveRound } from "../src/work-driver-corrective-decide.ts";
import type { CorrectiveGateView } from "../src/work-driver-corrective-decide.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import { formatExecError } from "../src/work-driver-verify-develop-helpers.ts";
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  depsHintStartFor,
  failureLines,
  isSuccessLine,
  splitLines,
} from "../src/work-driver-verify-failures.ts";
import { depsHintApplies } from "../src/work-driver-verify-record.ts";
import { runVerifyFull } from "../src/work-driver-verify-full.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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
// Shared by 2b and 2c: the command and cwd the harness builder composes with
// (same shape as test-work-driver-corrective-decide.ts's fixtures), and the
// tehas summary block section 3 uses for the stream tests.
const CMD = "sh check.sh";
const WT = "/repo/.worktrees/issue-1-a";
const CHECKS_BLOCK = "scripts/test.sh: failed checks (1)";

// The rule these three killed: the table matched `error`, `cannot` and
// `not found` ANYWHERE after an extension-bearing token, with no separator, so
// ordinary prose classified, became the anchor with `attributed: true`, and
// could earn the cycle a corrective round over a sentence that names no check.
// The three lines the reviewer reproduced, plus neighbours of the same shape.
// `fatal` is not in the accepted status list, and the counted form needs a
// token in the `N failed` idiom rather than the verb loose in the sentence —
// which is what keeps the space-separated `36 cases 1 failed` out of the table —
// the comma form `36 cases, 1 failed` is a runner's tally and classifies, pinned
// alongside `1 failed, 3 passed` in the mixed-tally block below.
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

  // The four accepted shapes, each spelled out (the brief's list, and the
  // tehas summary the #1762 park depends on). The two counted-tally cases carry
  // no `passed` half, so they do not depend on the mixed-tally rule pinned
  // below; the comma-tally form `36 cases, 1 failed` IS a failure and lives in
  // that block, not in the prose list.
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

// ── 2d. the success veto survives prose that mentions a failure count ──────
// The unanchored third branch of `NONZERO_FAILURE_COUNT` reported a non-zero
// count ANYWHERE in the line, so it defeated every passing veto: a line whose
// passing half the runner printed and whose failure word sits in prose became a
// failure line, an evidence anchor, and (through `attributed: true`) a candidate
// for the cycle's one corrective round. The rule is now: a count in a STATUS
// position counts, a count in a sentence does not.
{
  const STATUS_TALLY: Array<[string, string]> = [
    // cargo's own summary line — the count follows the label's colon through
    // the passing half, which is what a comma-only anchor missed.
    ["test result: 23 passed, 1 failed", "named-file"],
    ["test result: FAILED. 0 passed; 1 failed", "named-file"],
    ["1 failed, 3 passed", "named-file"],
    ["2 failed, 10 passed", "named-file"],
  ];
  for (const [line, shape] of STATUS_TALLY) {
    const got = classifyFailureLine(line);
    assert(
      got !== undefined && got.shape === shape,
      `tally: ${JSON.stringify(line)} classifies as ${shape}, got ${JSON.stringify(got)}`,
    );
    assert(
      isSuccessLine(line) === false,
      `tally: ${JSON.stringify(line)} is not a success line`,
    );
  }
  const PROSE_COUNT = [
    // The three the reviewer named, plus the neighbours of the same shape.
    "test result: 23 passed, 0 failed",
    "12 passed (retried 1 failed attempt)",
    "attempt 1 failed to start the worker, the second one worked",
    "suite reports 12 passed and nobody said 1 failed",
    "pack_release_test.sh: 36 cases, 0 failed",
    "12 passed",
  ];
  for (const line of PROSE_COUNT) {
    assert(
      classifyFailureLine(line) === undefined,
      `prose count: ${JSON.stringify(line)} stays a success`,
    );
    assert(
      isSuccessLine(line) === true,
      `prose count: ${JSON.stringify(line)} reports success`,
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
    "12 passed (retried 1 failed attempt)",
  ];
  const NO: string[] = [
    "scripts/test.sh: failed checks (1)",
    "test result: 23 passed, 1 failed",
    "1 failed, 3 passed",
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
    assert(isSuccessLine(line) === false, `isSuccessLine: ${JSON.stringify(line)} is not a success`);
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

// ── 3. the tehas-shaped stream ───────────────────────────────────────────────
const CHECK_DETAIL = "scripts/test.sh   pack_release_test.sh";
const PASSING = [
  "pack_release_test.sh: 36 cases, 0 failed",
  "sandbox_test.sh: 36 cases, 0 failed",
  "console_test.sh: 36 cases, 0 failed",
];
const TIMING = [
  "slowest checks:",
  "  pack_release_test.sh   21.4s",
  "  sandbox_test.sh        18.9s",
  "total 1314s",
];
const TEHAS = [
  "build_test.sh: 12 cases, 0 failed",
  CHECKS_BLOCK,
  CHECK_DETAIL,
  ...PASSING,
  ...TIMING,
].join("\n");
const PAD = "build stage output\n".repeat(200);

for (const maxLen of [800, 1500]) {
  const { tail, attributed } = extractAttributedTail(`${PAD}\n${TEHAS}`, maxLen);
  assert(attributed, `tehas @${maxLen}: the tail is attributed`);
  assert(tail.length <= maxLen, `tehas @${maxLen}: the tail respects maxLen`);
  assert(
    tail.startsWith(CHECKS_BLOCK),
    `tehas @${maxLen}: the anchor is the failed-checks block, got ${JSON.stringify(tail.slice(0, 60))}`,
  );
  assert(
    extractSpecificAssertion(tail) === CHECKS_BLOCK,
    `tehas @${maxLen}: the specific assertion names the failing file`,
  );
  assert(
    PASSING.every((p) => !failureLines(tail).includes(p)),
    `tehas @${maxLen}: no passing tally appears among the tail's failure lines`,
  );
  assert(
    failureLines(tail).every((l) => !isSuccessLine(l)),
    `tehas @${maxLen}: no success line in the tail is a failure line`,
  );
}

// A bare passing tally names no assertion, and never surfaces as evidence.
{
  const passing = "pack_release_test.sh: 36 cases, 0 failed";
  assert(
    extractSpecificAssertion(passing) === NO_SPECIFIC_ASSERTION,
    "tehas: a lone passing tally reports absence, never the tally itself",
  );
  assert(failureLines(passing).length === 0, "tehas: a lone passing tally yields no failure line");
}

// The cause verdict must not quote the passing stage either (work-413).
{
  const state = {
    eventLog: [
      { kind: "cap-hit", at: 1, cap: "verify-failed:develop", nextStep: "handoff" },
      {
        kind: "verify-completed",
        at: 1,
        step: "develop",
        command: "bash scripts/verify.sh",
        status: "failed",
      },
    ],
    pipelineState: {
      issue: 413,
      verifyEvidence: {
        step: "develop",
        failures: [TEHAS],
        at: 1,
        origin: "outcome-gate",
      },
    },
  } as unknown as WorkState;
  const v = causeVerdictOf(state, "verify-failed:develop", undefined);
  const joined = (v?.causeEvidence ?? []).join("\n");
  assert(
    PASSING.every((p) => !joined.includes(p)),
    `tehas: the cause verdict quotes no passing stage (got ${JSON.stringify(joined.slice(0, 200))})`,
  );
  assert(
    joined.includes("failed checks"),
    `tehas: the cause verdict names the failed-checks block (got ${JSON.stringify(joined.slice(0, 200))})`,
  );
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

// ── 5. a \r-separated stream attributes correctly (#1762 PM decision 4) ─────
{
  const cr = `build ok\r${CHECKS_BLOCK}\r${CHECK_DETAIL}\r${PASSING[0]}`;
  assert(splitLines(cr).length === 4, "cr: splitLines treats \\r as a line break");
  const { tail, attributed } = extractAttributedTail(cr, 800);
  assert(attributed, "cr: a carriage-return stream is attributed");
  assert(tail.startsWith(CHECKS_BLOCK), "cr: the anchor is the failed-checks block");
}

// ── 6. host-exhaustion labelling, both directions ────────────────────────────
const LABEL = "[host-resource-exhaustion]";
{
  const fork = Object.assign(new Error("Command failed: bash scripts/verify.sh"), {
    stdout: "fork: retry: Resource temporarily unavailable",
    stderr: "",
  });
  const msg = formatExecError(fork, "timeout", "verify command failed in /w");
  assert(msg.startsWith(LABEL), `exhaustion: a fork-failure stream is labelled (got ${msg.slice(0, 60)})`);

  const clean = Object.assign(new Error("Command failed: bash scripts/verify.sh"), {
    stdout: `${CHECKS_BLOCK}\npack_release_test.sh: 36 cases, 0 failed\nall checks ok, nothing to fork here`,
    stderr: "",
  });
  const plain = formatExecError(clean, "timeout", "verify command failed in /w");
  assert(
    !plain.includes(LABEL),
    `exhaustion: a failing stage that merely prints the phrase is not labelled (got ${plain.slice(0, 80)})`,
  );
  assert(
    plain.includes(CHECKS_BLOCK),
    "exhaustion: the failing stage is still the evidence when the label does not apply",
  );
}

// ── 7. #1770 — the ci tier keeps stdout ──────────────────────────────────────
{
  const failing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: `${CHECKS_BLOCK}\n${CHECK_DETAIL}`,
    stderr: "",
  });
  const exec = async (): Promise<{ stdout: string; stderr?: string }> => {
    throw failing;
  };
  const run = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, exec);
  assert(run.outcome === "failure", "1770: a rejected run is a failure");
  assert(
    run.output.includes(CHECKS_BLOCK),
    `1770: the evidence carries the failing line, not just the command (got ${JSON.stringify(run.output.slice(0, 120))})`,
  );
  assert(
    run.output !== "Command failed: bash scripts/verify.sh --full",
    "1770: Command failed alone is no longer a valid evidence tail",
  );
}

// ── 8. a tehas-shaped per-worktree failure earns the corrective round ───────
{
  const CMD = "bash scripts/verify.sh";
  const WT = "/repo/.worktrees/issue-1-a";
  const text = `verify command \`${CMD}\` failed in ${WT}: ${CHECKS_BLOCK}\n${CHECK_DETAIL}`;
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
  const d = decideCorrectiveRound(gate, {
    eventLog: [],
    worktrees: { a: WT },
  });
  assert(
    d.round === true,
    `corrective: a tehas-shaped per-worktree failure earns the round (${JSON.stringify(d)})`,
  );
  if (d.round) {
    assert(
      (d.targets[0]?.lines ?? []).some((l) => l.includes(CHECKS_BLOCK)),
      `corrective: the developer is given the failed-checks block (got ${JSON.stringify(d.targets[0]?.lines)})`,
    );
  }
}

console.log(exit === 0 ? "\nAll #1762/#1770 failure-shape checks passed." : "\nFAILED");
process.exit(exit);
