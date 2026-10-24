#!/usr/bin/env bun
/**
 * #1762 / #1770 round 1 — the STORED ci evidence tail, the one harness-echo
 * vocabulary, and the scan window measured from the gate's own stream.
 *
 * The third half of the suite #1762 grew: `test-verify-failure-shapes-1762.ts`
 * reads the table directly and `test-verify-failure-shapes-b-1762.ts` reads the
 * streams; this one reads what the driver STORES and what it shows a reader. Split
 * out along that seam so no file crosses the 500-line cap (AGENTS.md §12).
 *
 * Every fixture here is synthetic output the driver was fed in production.
 */

import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-consolidation-classify.ts";
import {
  FAILURE_LINE_SCAN_MAX,
  classifyFailureLine,
  isHarnessEchoLine,
} from "../src/work-driver-verify-failures.ts";
import { assertionLines } from "../src/work-driver-verify-record.ts";
import { VERIFY_FULL_OUTPUT_MAX, runVerifyFull } from "../src/work-driver-verify-full.ts";
import { CHECKS_BLOCK, CMD, WT, makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 5. #1762 round 1 — the stored ci tail goes through the failure table ─────
// `storeTierOutput` used to keep a positional tail of the redacted stream with no
// idea what was in it. A gate that prints one failing line and then 5 KB of passing
// summary therefore stored the SUMMARY and threw the failure off the top of the
// window — the #1762 symptom arriving through the store rather than the classifier.
// The stored excerpt now starts at or before the LAST recognised failure line.
{
  const SUMMARY = "passing check 1712 ok\n".repeat(600); // ~10 KB of passing noise
  const FAIL_LINE = CHECKS_BLOCK;
  const stream = `${FAIL_LINE}\n${SUMMARY}`;
  const failing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: stream,
    stderr: "",
  });
  const run = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw failing;
  });
  assert(
    run.output.length <= VERIFY_FULL_OUTPUT_MAX,
    `store: the stored tail is bounded (${run.output.length})`,
  );
  assert(
    run.output.includes(FAIL_LINE),
    `store: a failure line followed by a wall of passing summary still survives (${JSON.stringify(run.output.slice(0, 80))})`,
  );
  // The same stream with NO failure line at all keeps the positional tail — an
  // unrecognised gate still gets its last words, unattributed rather than empty.
  const quiet = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: SUMMARY,
    stderr: "",
  });
  const quietRun = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw quiet;
  });
  assert(
    quietRun.output.length > 0 && quietRun.output.length <= VERIFY_FULL_OUTPUT_MAX,
    "store: a stream naming no failure still keeps its bounded tail",
  );
}

// ── 6. #1762 round 1 — a secret straddling the cut never survives as a fragment ─
// The whole point of redacting the FULL stream before any bound: a token that sits
// across the edge of the kept window is either redacted whole or not present, never
// shipped as a prefix no pattern recognises.
{
  const SECRET = `ghp_${"Z9yW8xV7".repeat(6)}`; // 52 chars, GitHub-token shaped
  assert(SECRET.length > 40, `cut straddle: the token is long enough to be split (${SECRET.length})`);
  // The token is placed so the 4 KB window's LEFT edge falls in its middle.
  const pad = "z".repeat(VERIFY_FULL_OUTPUT_MAX - 20);
  const stream = `${pad} token=${SECRET} tail`;
  const failing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: stream,
    stderr: "",
  });
  const run = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw failing;
  });
  assert(
    !run.output.includes("ghp_") && !run.output.includes(SECRET),
    `cut straddle: no token or token fragment survives the bound (${JSON.stringify(run.output.slice(0, 60))})`,
  );
  assert(
    run.output.includes("[REDACTED]"),
    "cut straddle: the redaction ran on the full stream before the window was taken",
  );
}

// ── 7. #1762 round 1 — ONE harness-echo vocabulary, anchored on the harness's kill ─
// `work-driver-cause-class.ts` kept its own list of "the harness's own echo" lines
// and its `killed` entry was unanchored, so any gate line that merely USED the word
// was vetoed as harness noise. Both halves are pinned: the harness's own kill line is
// an echo, and a gate line about a killed process is a failure line.
{
  assert(
    isHarnessEchoLine("killed") === true,
    "echo: the harness's bare kill verdict is an echo",
  );
  assert(
    isHarnessEchoLine("killed by signal SIGKILL") === true,
    "echo: the harness's own kill line is an echo",
  );
  assert(
    isHarnessEchoLine("Command failed: bun test") === true,
    "echo: the executor's Command failed line is an echo",
  );
  assert(
    isHarnessEchoLine("$ bun run check") === true,
    "echo: an echoed command is an echo",
  );
  // The other way: a gate line that merely contains the word is a failure line, not
  // noise, and the table must say so.
  for (const gate of [
    "test-killed-child.ts: 1 failed",
    "scripts/sigkill_test.sh: failed checks (1)",
    "✗ the worker was killed before it answered",
  ]) {
    assert(
      isHarnessEchoLine(gate) === false,
      `echo: a gate line that merely uses "killed" is not an echo (${JSON.stringify(gate)})`,
    );
    assert(
      classifyFailureLine(gate) !== undefined,
      `echo: and it still classifies as a failure line (${JSON.stringify(gate)})`,
    );
  }
}

// ── 8. #1762 round 1 — `assertionLines` returns REDACTED lines ───────────────
// These lines are the evidence of a park: the corrective-round prompt, the handoff
// and the forge comment all carry them. A failing assertion routinely echoes the
// value it compared, so what this reader gives out is redacted, the way
// `namedFailureLines` already redacts what it keeps.
{
  const SECRET = `ghp_${"Q7wErT6y".repeat(5)}`;
  const line = `✗ token mismatch, got ${SECRET}`;
  const offered = assertionLines(line);
  assert(
    offered.length === 1,
    `redaction: the assertion line is still offered (${JSON.stringify(offered)})`,
  );
  assert(
    !offered.some((l) => l.includes("ghp_")),
    `redaction: the echoed token does not reach the reader (${JSON.stringify(offered)})`,
  );
  assert(
    offered[0]?.includes("[REDACTED]") === true,
    `redaction: the line comes back masked, not dropped (${JSON.stringify(offered)})`,
  );
}

// ── 9. #1762 round 1 — the 8 KiB window is measured from the gate's own stream ───
// The wrapper is clipped by the caller, so a long command string eats part of that
// clip. If the stream were re-windowed at the same bound, a wrapper whose command
// runs long would push the gate's own report past the end and the line would report
// no failure at all — the window would be a window on the harness's prose.
{
  const LONG_CMD = "sh ".concat("check --verbose ".repeat(900)); // ~14 KB, past 8 KiB
  assert(
    LONG_CMD.length > FAILURE_LINE_SCAN_MAX,
    `window: the wrapper prefix alone exceeds the scan window (${LONG_CMD.length})`,
  );
  const wrapped = `verify command \`${LONG_CMD}\` failed in ${WT}: ${CHECKS_BLOCK}`;
  const got = classifyFailureLine(wrapped);
  assert(
    got?.shape === "script-tally",
    `window: a failing gate line behind a >8 KiB wrapper prefix is still found (${JSON.stringify(got)})`,
  );
  const asserted = extractSpecificAssertion(wrapped);
  assert(
    asserted === CHECKS_BLOCK,
    `window: and the assertion reader sees the same gate line (${JSON.stringify(asserted)})`,
  );
}


console.log(failed() ? "\nFAILED" : "\nAll #1762/#1770 round-1 store and window checks passed.");
process.exit(failed() ? 1 : 0);
