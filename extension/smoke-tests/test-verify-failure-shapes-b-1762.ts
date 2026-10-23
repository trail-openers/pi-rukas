#!/usr/bin/env bun
/**
 * #1762 / #1770 — the failure-line table read through the STREAM readers.
 *
 * The second half of the suite split from `test-verify-failure-shapes-1762.ts`
 * (AGENTS.md §12 file-size limit). Where the first half asks the table one line
 * at a time, every case here feeds a whole stream to a reader — the attributed
 * tail extractor, `formatExecError`, the ci tier's `runVerifyFull`, the
 * corrective-round decider — and asserts what the driver would hand a developer.
 *
 * The tehas fixtures are the shape from work-413 / work-518; the #1770 case is
 * the ci tier that used to drop stdout and report `Command failed: <cmd>` as
 * the whole of the evidence.
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
  failureLines,
  harnessInnerLine,
  isSuccessLine,
  splitLines,
} from "../src/work-driver-verify-failures.ts";
import { assertionLines } from "../src/work-driver-verify-record.ts";
import { runVerifyFull } from "../src/work-driver-verify-full.ts";
import type { WorkState } from "../src/workflow-state.ts";
import {
  CHECKS_BLOCK,
  CHECK_DETAIL,
  CMD,
  PASSING,
  TIMING,
  WT,
  makeAssert,
} from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 3. the tehas-shaped stream ───────────────────────────────────────────────
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
  assert(
    msg.startsWith(LABEL),
    `exhaustion: a fork-failure stream is labelled (got ${msg.slice(0, 60)})`,
  );

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
  const VERIFY_CMD = "bash scripts/verify.sh";
  const text = `verify command \`${VERIFY_CMD}\` failed in ${WT}: ${CHECKS_BLOCK}\n${CHECK_DETAIL}`;
  const gate: CorrectiveGateView = {
    ok: false,
    failures: [text],
    verifyRun: {
      status: "ran",
      command: VERIFY_CMD,
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

// ── 9. what the reader RETURNS is the gate's line, not harness text ─────────
// `harnessInnerLine` returns the first cut whose stream classifies, so two
// kinds of the harness's own writing can ride along into the field labelled
// "the specific assertion": the separator padding a command or cwd containing
// `: ` leaves in front of the gate's output, and the deps hint's diagnosis when
// the cut lands on the colon inside the hint. Classification is unchanged by
// either — these assert only what a developer is shown.
{
  // (a) Separator padding. `host:8080` and `host:9090` put `: ` in the command
  // and the run's cwd, so the first candidate the builder's scan accepts is
  // one of those and the returned stream opened with `: : : …`.
  const PADDED =
    `verify command \`${CMD} run host:8080 and host:9090\` failed in ${WT}` +
    `${": ".repeat(12)}a.ts: 3 failed`;
  assert(
    harnessInnerLine(PADDED) === "a.ts: 3 failed",
    `padding: harnessInnerLine strips the leading separators (got ${JSON.stringify(harnessInnerLine(PADDED))})`,
  );
  assert(
    extractSpecificAssertion(PADDED) === "a.ts: 3 failed",
    `padding: extractSpecificAssertion returns the gate line, unpadded (got ${JSON.stringify(extractSpecificAssertion(PADDED))})`,
  );
  {
    const gate: CorrectiveGateView = {
      ok: false,
      failures: [PADDED],
      verifyRun: {
        status: "ran",
        command: `${CMD} run host:8080 and host:9090`,
        failures: [PADDED],
        perWorktree: [{ cwd: WT, text: PADDED }],
      },
    };
    const d = decideCorrectiveRound(gate, { eventLog: [], worktrees: { a: WT } });
    assert(d.round === true, `padding: the padded line still earns the round (${JSON.stringify(d)})`);
    if (d.round) {
      assert(
        (d.targets[0]?.lines ?? []).join("|") === "a.ts: 3 failed",
        `padding: the developer is given the bare gate line (got ${JSON.stringify(d.targets[0]?.lines)})`,
      );
    }
  }

  // (b) The deps hint's own prose. Both shapes that carry a `: ` of their own
  // reach the gate's tail through that colon, so the returned stream opened
  // with the harness's diagnosis: `node_modules is empty: scripts/gate.sh: …`.
  const GATE_LINE = "scripts/gate.sh: failed checks (1)";
  const HINTED: Array<[string, string]> = [
    [
      "hook-failed",
      `verify command \`${CMD}\` failed in ${WT} — the \`.pi/worktree-setup\` hook failed ` +
        `during provisioning: node_modules is empty: ${GATE_LINE}`,
    ],
    [
      "generic",
      `verify command \`${CMD}\` failed in ${WT} — this looks like missing dependencies ` +
        `in the worktree: node_modules is empty: ${GATE_LINE}`,
    ],
  ];
  for (const [shape, line] of HINTED) {
    assert(
      harnessInnerLine(line) === GATE_LINE,
      `hint prose (${shape}): the returned line is the gate's, with no hint text (got ${JSON.stringify(harnessInnerLine(line))})`,
    );
    assert(
      extractSpecificAssertion(line) === GATE_LINE,
      `hint prose (${shape}): the specific assertion names no hint prose (got ${JSON.stringify(extractSpecificAssertion(line))})`,
    );
    assert(
      assertionLines(line).join("|") === GATE_LINE,
      `hint prose (${shape}): the corrective round is given only the gate line (got ${JSON.stringify(assertionLines(line))})`,
    );
  }

  // And the two removals are only removals: a wrapper with nothing assertable
  // behind it still reports absence, and still keeps its deps hint.
  const hintOnly =
    `verify command \`${CMD}\` failed in ${WT} — the \`.pi/worktree-setup\` hook failed ` +
    "during provisioning: node_modules is empty\nnothing to see here";
  assert(
    extractSpecificAssertion(hintOnly) === NO_SPECIFIC_ASSERTION,
    `hint prose: a hint with no gate failure still reports absence (got ${JSON.stringify(extractSpecificAssertion(hintOnly))})`,
  );
}

console.log(failed() ? "\nFAILED" : "\nAll #1762/#1770 stream-reader checks passed.");
process.exit(failed() ? 1 : 0);