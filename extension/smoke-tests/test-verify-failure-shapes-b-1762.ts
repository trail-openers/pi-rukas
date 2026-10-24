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
 * The project-runner fixtures are the shape from work-413 / work-518; the #1770 case is
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
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  failureLines,
  harnessInnerLine,
  isHarnessEchoLine,
  isSuccessLine,
} from "../src/work-driver-verify-failures.ts";
import { splitLines } from "../src/work-driver-verify-support.ts";
import { assertionLines } from "../src/work-driver-verify-record.ts";
import { runVerifyFull, VERIFY_FULL_OUTPUT_MAX } from "../src/work-driver-verify-full.ts";
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

// ── 3. the project-runner-shaped stream ───────────────────────────────────────────────
const PROJECT_RUNNER = [
  "build_test.sh: 12 cases, 0 failed",
  CHECKS_BLOCK,
  CHECK_DETAIL,
  ...PASSING,
  ...TIMING,
].join("\n");
const PAD = "build stage output\n".repeat(200);

for (const maxLen of [800, 1500]) {
  const { tail, attributed } = extractAttributedTail(`${PAD}\n${PROJECT_RUNNER}`, maxLen);
  assert(attributed, `project-runner @${maxLen}: the tail is attributed`);
  assert(tail.length <= maxLen, `project-runner @${maxLen}: the tail respects maxLen`);
  assert(
    tail.startsWith(CHECKS_BLOCK),
    `project-runner @${maxLen}: the anchor is the failed-checks block, got ${JSON.stringify(tail.slice(0, 60))}`,
  );
  assert(
    extractSpecificAssertion(tail) === CHECKS_BLOCK,
    `project-runner @${maxLen}: the specific assertion names the failing file`,
  );
  assert(
    PASSING.every((p) => !failureLines(tail).includes(p)),
    `project-runner @${maxLen}: no passing tally appears among the tail's failure lines`,
  );
  assert(
    failureLines(tail).every((l) => !isSuccessLine(l)),
    `project-runner @${maxLen}: no success line in the tail is a failure line`,
  );
}

// A bare passing tally names no assertion, and never surfaces as evidence.
{
  const passing = "pack_release_test.sh: 36 cases, 0 failed";
  assert(
    extractSpecificAssertion(passing) === NO_SPECIFIC_ASSERTION,
    "project-runner: a lone passing tally reports absence, never the tally itself",
  );
  assert(failureLines(passing).length === 0, "project-runner: a lone passing tally yields no failure line");
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
        failures: [PROJECT_RUNNER],
        at: 1,
        origin: "outcome-gate",
      },
    },
  } as unknown as WorkState;
  const v = causeVerdictOf(state, "verify-failed:develop", undefined);
  const joined = (v?.causeEvidence ?? []).join("\n");
  assert(
    PASSING.every((p) => !joined.includes(p)),
    `project-runner: the cause verdict quotes no passing stage (got ${JSON.stringify(joined.slice(0, 200))})`,
  );
  assert(
    joined.includes("failed checks"),
    `project-runner: the cause verdict names the failed-checks block (got ${JSON.stringify(joined.slice(0, 200))})`,
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

// ── 7b. #1762 round 3 — the tier keeps the TAIL, and redacts BEFORE clipping ─
// `storeTierOutput` kept the HEAD of the redacted stream. Every reader of this
// field wants the failure, and a gate prints its report at the END: a 50 KB
// suite log whose assertion fails on the last line was stored as 4 KB of build
// noise with the failure cut off the bottom — the same "the evidence says
// nothing" symptom #1770 opened. Redaction still runs on the FULL text first,
// so a token that straddles the cut can never survive as an unrecognisable
// fragment.
{
  const NOISE = "build step 4712: compiling crate index (dep tree 91%)\n".repeat(900); // ~42 KB
  const SECRET = `ghp_${"A1b2C3d4".repeat(5)}`; // GitHub token shape, 44 chars
  assert(NOISE.length > 40_000, `1770 tail: the noise alone is >4 KB (got ${NOISE.length})`);
  const secretLine = `api_key = ${SECRET}`;
  // The failure sits at the very end, ~40 KB past what a head-clip kept; the
  // secret sits inside the final 4 KB, so a clip-first implementation would
  // have cut through it.
  const stream = `${NOISE}\n${secretLine}\n${CHECKS_BLOCK}\n${CHECK_DETAIL}`;
  assert(
    stream.indexOf(CHECKS_BLOCK) > VERIFY_FULL_OUTPUT_MAX,
    `1770 tail: the failure line sits past what a head-clip kept (${stream.indexOf(CHECKS_BLOCK)} chars from the start)`,
  );
  const failing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: stream,
    stderr: "",
  });
  const exec = async (): Promise<{ stdout: string; stderr?: string }> => {
    throw failing;
  };
  const run = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, exec);
  assert(run.output.length <= VERIFY_FULL_OUTPUT_MAX, "1770 tail: the stored output is bounded");
  assert(
    run.output.includes(CHECKS_BLOCK),
    `1770 tail: the failure at the END of a 50 KB stream survives (got ${JSON.stringify(run.output.slice(-120))})`,
  );
  assert(
    run.output.includes(CHECK_DETAIL),
    "1770 tail: the line beneath the tally survives too",
  );
  assert(
    !run.output.includes(SECRET) && !run.output.includes("ghp_"),
    `1770 tail: a secret near the cut is redacted, not clipped into a fragment (got ${JSON.stringify(run.output.slice(-160))})`,
  );
  assert(
    run.output.includes("[REDACTED]"),
    "1770 tail: the redaction happened, on the full text, before the tail was taken",
  );
  assert(
    run.output.split("\n")[0] !== NOISE.split("\n")[0],
    `1770 tail: the head of the stream is no longer what is stored (got ${JSON.stringify(run.output.slice(0, 60))})`,
  );
  // A code-point TAIL is only a tail if the cut is measured from the end of the
  // text, not from the end of the first `\n`-delimited chunk: a gate that
  // reports on one very long line after a short preamble is the common shape,
  // and a head-clip (or a slice of `split("\n")[0]`) loses the failure there.
  const oneLine = `preamble\n${"z".repeat(20_000)}${CHECKS_BLOCK}`;
  const longFailing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: oneLine,
    stderr: "",
  });
  const longRun = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw longFailing;
  });
  assert(
    longRun.output.includes(CHECKS_BLOCK),
    `1770 tail: a failure at the end of one long line survives the tail (got ${JSON.stringify(longRun.output.slice(-80))})`,
  );
}

// ── 8. a project-runner-shaped per-worktree failure earns the corrective round ───────
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
    `corrective: a project-runner-shaped per-worktree failure earns the round (${JSON.stringify(d)})`,
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

  // (c) #1762 round 3 — the secret guard reaches UNWRAPPED inner lines. A
  // multi-line stream is not one line, so `extractSpecificAssertion` refuses
  // the wrapper and never sees the lines beneath it; `assertionLines` unwraps
  // them itself, and used to offer every one of them without the #807 guard. A
  // credential the gate echoed therefore reached the corrective-round prompt,
  // the handoff and the forge comment as "an assertion the developer can act
  // on". Same predicate now, on both routes.
  {
    const SECRET = `ghp_${"a".repeat(36)}`; // the shape the lens named, verbatim
    const secretLine = `api_key = ${SECRET}`;
    // A multi-line stream behind the wrapper: the guard only applies to
    // UNWRAPPED lines, because a single-line stream already goes through the
    // extractor's own `isNonAssertionLine`.
    const leaked =
      `verify command \`${CMD}\` failed in ${WT}: ${secretLine}\n${CHECKS_BLOCK}`;
    const offered = assertionLines(leaked);
    assert(
      !offered.some((l) => l.includes("ghp_") || l.includes("api_key")),
      `inner secret: no credential-shaped inner line is offered (got ${JSON.stringify(offered)})`,
    );
    assert(
      offered.includes(CHECKS_BLOCK),
      `inner secret: the guard drops only the secret line — the gate's failure is still offered (got ${JSON.stringify(offered)})`,
    );
    assert(
      extractSpecificAssertion(leaked) === CHECKS_BLOCK,
      `inner secret: the extractor agrees on the same stream (got ${JSON.stringify(extractSpecificAssertion(leaked))})`,
    );
    // An echoed command inside the wrapper is harness/CI echo, not an assertion
    // — the same guard, the same refusal the bare `$ …` line earns.
    const echoed =
      `verify command \`${CMD}\` failed in ${WT}: $ bun run check\n${CHECKS_BLOCK}`;
    assert(
      !assertionLines(echoed).some((l) => l.startsWith("$ ")),
      `inner echo: an echoed command inside the wrapper is not offered (got ${JSON.stringify(assertionLines(echoed))})`,
    );
    // And a secret ALONE behind the wrapper earns nothing: absence, not the
    // token.
    const onlySecret = `verify command \`${CMD}\` failed in ${WT}: ${secretLine}`;
    assert(
      assertionLines(onlySecret).length === 0,
      `inner secret: a wrapper whose only content is a secret offers no line (got ${JSON.stringify(assertionLines(onlySecret))})`,
    );
    // The leak this item names, and the shape that is actually reachable here.
    // `LOOKS_LIKE_SECRET` is KEYWORD-shaped (`api_key = …`), so a bare `ghp_…`
    // passes it and the arm of this fix that changes behaviour is the other half
    // of the same item: `splitLines` over `split("\n")`. A gate that broke its
    // lines with `\r` handed `assertionLines` the token and the tally as ONE
    // "line", and neither route's guard ever saw the pair as two — so the token
    // went to the developer, the handoff and the forge comment whole. Splitting
    // first is what lets the guard judge the token at all; the guard is what
    // refuses it, and both halves are pinned here.
    //
    // What the guard alone does NOT close is recorded rather than papered over:
    // a credential welded INSIDE prose that is itself an assertion
    // (`✗ auth check with ghp_… failed`) satisfies `classifyFailureLine`, so it
    // is an assertion by this module's contract and the keyword-shaped #807
    // guard does not name it. Redacting that shape is `redactSecrets`' job and
    // belongs to a separate change — see the report.
    // (c1) The `\r` stream: the case that leaked. The token line and the gate's
    // tally must come back split, guarded, and with the tally intact.
    const crSecret = `verify command \`${CMD}\` failed in ${WT}: ${SECRET}\r${CHECKS_BLOCK}`;
    const crOffered = assertionLines(crSecret);
    assert(
      !crOffered.some((l) => l.includes("ghp_") || l.includes("\r")),
      `inner secret (\\r): a carriage-return stream is split and guarded (got ${JSON.stringify(crOffered)})`,
    );
    assert(
      crOffered.length === 1 && crOffered[0] === CHECKS_BLOCK,
      `inner secret (\\r): exactly the gate line survives (got ${JSON.stringify(crOffered)})`,
    );
    const crMarker = `verify command \`${CMD}\` failed in ${WT}: FAILED: a.ts\r${CHECKS_BLOCK}`;
    assert(
      assertionLines(crMarker).join("|") === CHECKS_BLOCK,
      `inner marker (\\r): a bare FAILED: marker inside the wrapper is not offered (got ${JSON.stringify(assertionLines(crMarker))})`,
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
