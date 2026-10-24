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
import { VERIFY_FULL_OUTPUT_MAX, keepEvidenceHead, runVerifyFull } from "../src/work-driver-verify-full.ts";
import { VERIFY_FULL_EVIDENCE_MAX } from "../src/work-driver-verify-full.ts";
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
  // The reader must be shown the GATE'S line alone. Handing back the wrapper is the
  // #798 defect through the window: an operator sent to the harness sentence, and the
  // cycle's one corrective round spent on text the harness wrote.
  assert(
    asserted === CHECKS_BLOCK,
    `window: the assertion reader is given the gate line, not the wrapper (${JSON.stringify(asserted).slice(0, 100)}...)`,
  );
  assert(
    !asserted.startsWith("verify command"),
    `window: the wrapper sentence is never returned as the assertion`,
  );
}


// ── 5b. #1762 round 2 (C3) — the DISCRIMINATING case for the anchored store ─
// The last recognised failure line sits more than one excerpt-width from the end
// of the stream, followed by passing output. A positional tail of the stored width
// starts 4000 characters from the end — inside that passing output — so it keeps
// the summary and drops the failure; the anchored excerpt must not. Both halves
// are asserted (starts at the failure, AND differs from the blind tail) because an
// implementation that merely got lucky about the stream length passes a
// one-sided assertion. The gap is deliberately WIDER than one excerpt: at that
// distance the failure is reachable only by starting the window at it, which is
// what is pinned here.
{
  const FAIL_LINE = "✗ the release manifest disagrees with the fixture";
  const BEFORE_GAP = "noise: nothing to see here\n".repeat(80);
  // The gap after the failure must EXCEED the excerpt budget: that is what makes
  // the positional tail lose the failure and the anchor keep it. A stream no wider
  // than one excerpt fits the failure either way and would not discriminate.
  const AFTER = "passing summary line 42 ok\n".repeat(200); // ~5400 chars, > 4000
  const stream = `${BEFORE_GAP}${FAIL_LINE}\n${AFTER}`;
  const gap = stream.length - stream.indexOf(FAIL_LINE) - FAIL_LINE.length;
  assert(
    gap > 2000 && gap > VERIFY_FULL_OUTPUT_MAX,
    `c3: the failure sits more than one excerpt from the end (${gap})`,
  );
  const failing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: stream,
    stderr: "",
  });
  const run = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw failing;
  });
  assert(
    run.output.length <= VERIFY_FULL_OUTPUT_MAX,
    `c3: the stored excerpt is bounded (${run.output.length})`,
  );
  // (a) The excerpt STARTS with the failure line (within 200 characters, allowing
  // for the redaction marker a credential-shaped payload could leave behind).
  const at = run.output.indexOf(FAIL_LINE);
  assert(
    at >= 0 && at <= 200,
    `c3: the stored excerpt starts at the failure line (found at ${at} of ${JSON.stringify(run.output.slice(0, 60))})`,
  );
  // (b) It DIFFERS from the positional tail of the same width — the tail is all
  // passing output and contains no failure at all.
  const positional = Array.from(stream).slice(-VERIFY_FULL_OUTPUT_MAX).join("");
  assert(
    run.output !== positional,
    "c3: the anchored excerpt is not the positional tail",
  );
  assert(
    !positional.includes(FAIL_LINE),
    "c3: the positional tail really does omit the failure (the fixture is discriminating)",
  );
  // (c) The stepback's 500-character evidence contains the failure line. This is
  // the cut that used to be `slice(-500)` on an excerpt that starts at the failure,
  // i.e. the reader undoing what the producer had just fixed.
  const evidence = keepEvidenceHead(run.output, run.anchored === true);
  assert(
    evidence.length <= VERIFY_FULL_EVIDENCE_MAX,
    `c3: the evidence is bounded to the handoff budget (${evidence.length})`,
  );
  assert(
    evidence.includes(FAIL_LINE),
    `c3: the 500-char evidence contains the failure line (got ${JSON.stringify(evidence.slice(0, 80))})`,
  );
  // The negative control: with no anchor anywhere in the scanned tail the producer
  // stores the positional tail and says so, and the evidence keeps its tail. The
  // stream is built to be WIDER than one excerpt, which is the only case where
  // "positional tail" is a claim at all — a shorter stream is stored whole.
  const quietStream = ("passing summary line 42 ok\n".repeat(600) + "the last word").trim();
  assert(
    quietStream.length > VERIFY_FULL_OUTPUT_MAX,
    `c3: the unanchored fixture is wider than one excerpt (${quietStream.length})`,
  );
  const quiet = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: quietStream,
    stderr: "",
  });
  const quietRun = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw quiet;
  });
  assert(
    quietRun.anchored === false,
    `c3: a stream with no recognised failure reports no anchor (got ${JSON.stringify(quietRun.anchored)})`,
  );
  assert(
    quietRun.output === Array.from(quietStream).slice(-VERIFY_FULL_OUTPUT_MAX).join(""),
    "c3: an unanchored excerpt is the positional tail",
  );
}

console.log(failed() ? "\nFAILED" : "\nAll #1762/#1770 round-1 store and window checks passed.");
process.exit(failed() ? 1 : 0);
