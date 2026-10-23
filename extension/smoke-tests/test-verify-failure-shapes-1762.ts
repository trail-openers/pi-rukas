#!/usr/bin/env bun
/**
 * #1762 — one failure-line table for every verify reader, and #1770 — the ci
 * tier keeps stdout.
 *
 * The measured defect: four recognisers each admitted only `FAILED: <x>` and
 * `✗ <x>`, so a project gate that speaks another runner's dialect anchored
 * nowhere. On orchard v0.14.2 nine verify parks named no failing assertion and
 * the handoff quoted `pack_release_test.sh: 36 cases, 0 failed` — a PASSING
 * stage — as the evidence, while the runner's own `test.sh: failed checks (1)`
 * block sat earlier in the same window.
 *
 * Every fixture here is synthetic output the driver was fed in production; the
 * orchard stream is the shape from work-413 / work-518.
 */

import { causeVerdictOf } from "../src/work-driver-cause-class.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import { decideCorrectiveRound } from "../src/work-driver-corrective-decide.ts";
import { extractAttributedTail } from "../src/work-driver-exec-error.ts";
import { formatExecError } from "../src/work-driver-verify-develop-helpers.ts";
import {
  classifyFailureLine,
  failureLines,
  isSuccessLine,
  splitLines,
} from "../src/work-driver-verify-failures.ts";
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
  ["scripts/pack_release_test.sh: 36 cases, 1 failed", "named-file", true],
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

// ── 3. the orchard-shaped stream ───────────────────────────────────────────────
const CHECKS_BLOCK = "scripts/test.sh: failed checks (1)";
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
const ORCHARD = [
  "build_test.sh: 12 cases, 0 failed",
  CHECKS_BLOCK,
  CHECK_DETAIL,
  ...PASSING,
  ...TIMING,
].join("\n");
const PAD = "build stage output\n".repeat(200);

for (const maxLen of [800, 1500]) {
  const { tail, attributed } = extractAttributedTail(`${PAD}\n${ORCHARD}`, maxLen);
  assert(attributed, `orchard @${maxLen}: the tail is attributed`);
  assert(tail.length <= maxLen, `orchard @${maxLen}: the tail respects maxLen`);
  assert(
    tail.startsWith(CHECKS_BLOCK),
    `orchard @${maxLen}: the anchor is the failed-checks block, got ${JSON.stringify(tail.slice(0, 60))}`,
  );
  assert(
    extractSpecificAssertion(tail) === CHECKS_BLOCK,
    `orchard @${maxLen}: the specific assertion names the failing file`,
  );
  assert(
    PASSING.every((p) => !failureLines(tail).includes(p)),
    `orchard @${maxLen}: no passing tally appears among the tail's failure lines`,
  );
  assert(
    failureLines(tail).every((l) => !isSuccessLine(l)),
    `orchard @${maxLen}: no success line in the tail is a failure line`,
  );
}

// A bare passing tally names no assertion, and never surfaces as evidence.
{
  const passing = "pack_release_test.sh: 36 cases, 0 failed";
  assert(
    extractSpecificAssertion(passing) === NO_SPECIFIC_ASSERTION,
    "orchard: a lone passing tally reports absence, never the tally itself",
  );
  assert(failureLines(passing).length === 0, "orchard: a lone passing tally yields no failure line");
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
        failures: [ORCHARD],
        at: 1,
        origin: "outcome-gate",
      },
    },
  } as unknown as WorkState;
  const v = causeVerdictOf(state, "verify-failed:develop", undefined);
  const joined = (v?.causeEvidence ?? []).join("\n");
  assert(
    PASSING.every((p) => !joined.includes(p)),
    `orchard: the cause verdict quotes no passing stage (got ${JSON.stringify(joined.slice(0, 200))})`,
  );
  assert(
    joined.includes("failed checks"),
    `orchard: the cause verdict names the failed-checks block (got ${JSON.stringify(joined.slice(0, 200))})`,
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

// ── 8. a orchard-shaped per-worktree failure earns the corrective round ───────
{
  const CMD = "bash scripts/verify.sh";
  const WT = "/repo/.worktrees/issue-1-a";
  const text = `verify command \`${CMD}\` failed in ${WT}: ${CHECKS_BLOCK}\n${CHECK_DETAIL}`;
  const gate = {
    ok: false,
    failures: [text],
    verifyRun: {
      status: "ran",
      command: CMD,
      failures: [text],
      perWorktree: [{ cwd: WT, text }],
    },
  } as const;
  const d = decideCorrectiveRound(gate, {
    eventLog: [],
    worktrees: { a: WT },
  });
  assert(
    d.round === true,
    `corrective: a orchard-shaped per-worktree failure earns the round (${JSON.stringify(d)})`,
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
