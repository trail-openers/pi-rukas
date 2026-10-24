#!/usr/bin/env bun
/**
 * #1762 / #1770 round 4 — the anchor is an OFFSET inside the stored excerpt.
 *
 * The store's `anchored` was a boolean, and it was wrong for one whole shape of
 * stream: the producer clamps the window start to `min(anchor, len - 4000)`, so a
 * failure that sits in the LAST excerpt-width of the stream is stored INSIDE the
 * positional tail, not at its head. The flag still said "anchored" there, and
 * `keepEvidenceHead` then kept the first 500 characters of the excerpt — the lines
 * ABOVE the failure — and dropped the failure line itself. #1762's symptom, back
 * through a flag that over-claimed.
 *
 * Split out of `test-verify-failure-shapes-c-1762.ts` along the round seam so no
 * file crosses the 500-line cap (AGENTS.md §12). Every fixture is synthetic output
 * the driver was fed in production.
 */

import {
  VERIFY_FULL_EVIDENCE_MAX,
  VERIFY_FULL_OUTPUT_MAX,
  keepEvidenceHead,
  runVerifyFull,
} from "../src/work-driver-verify-full.ts";
import { makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

// ── 5c. #1762 round 4 — the anchor OFFSET, not a boolean ─────────────────────
// Both cases below must put the failure at the TOP of the 500-character evidence:
// one where the failure sits inside the positional tail (1000 characters from the
// end, so the clamp starts the window BEFORE it) and one outside it (6000, so the
// window opens at the failure and the clamp never fires). The near case is the one
// the boolean got wrong; the far case is the one it got right, and both are pinned
// because an implementation that always head-cut from zero satisfies the far one.
{
  const FAIL_LINE = "✗ the migration left the schema half-applied";
  const TAIL_NOISE = "passing summary line 7 ok\n"; // 25 chars
  const build = (tailChars: number): string => {
    const before = "noise: irrelevant preamble\n".repeat(40);
    const after = TAIL_NOISE.repeat(Math.ceil(tailChars / TAIL_NOISE.length)).slice(0, tailChars);
    return `${before}${FAIL_LINE}\n${after}`;
  };
  const cases: Array<[string, number]> = [
    ["inside the positional tail", 1000],
    ["outside the positional tail", 6000],
  ];
  for (const [label, tailChars] of cases) {
    const stream = build(tailChars);
    const distance = stream.length - (stream.indexOf(FAIL_LINE) + FAIL_LINE.length) - 1;
    assert(
      distance === tailChars,
      `c5: the failure line ends ${tailChars} characters before the end (${label}, got ${distance})`,
    );
    const failing = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
      stdout: stream,
      stderr: "",
    });
    const run = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
      throw failing;
    });
    assert(
      run.anchorOffset !== undefined,
      `c5: the failure is recognised, so an offset is reported (${label})`,
    );
    assert(
      run.output.slice(run.anchorOffset ?? -1, (run.anchorOffset ?? -1) + FAIL_LINE.length) ===
        FAIL_LINE,
      `c5: the offset points AT the failure line inside the excerpt (${label}, got ${JSON.stringify(run.output.slice(run.anchorOffset ?? 0, (run.anchorOffset ?? 0) + 60))})`,
    );
    const evidence = keepEvidenceHead(run.output, run.anchorOffset);
    assert(
      evidence.length <= VERIFY_FULL_EVIDENCE_MAX,
      `c5: the evidence is bounded to the handoff budget (${label}, ${evidence.length})`,
    );
    assert(
      evidence.startsWith(FAIL_LINE),
      `c5: the 500-char evidence STARTS with the failure line (${label}, got ${JSON.stringify(evidence.slice(0, 70))})`,
    );
    if (tailChars > VERIFY_FULL_OUTPUT_MAX) {
      // The discriminating half for the far case: a blind tail cut of the excerpt
      // keeps the passing noise and drops the failure, which is what the offset is
      // there to prevent. (The near case has no such alternative — its excerpt IS
      // the positional tail — so it is pinned by `startsWith` alone.)
      const blindTail = Array.from(run.output).slice(-VERIFY_FULL_EVIDENCE_MAX).join("");
      assert(
        !blindTail.includes(FAIL_LINE),
        `c5: the blind tail cut really does omit the failure (${label})`,
      );
    }
  }
  // And with no failure line anywhere, the evidence is the excerpt's tail.
  const quiet = Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
    stdout: "passing summary line 7 ok\n".repeat(400),
    stderr: "",
  });
  const quietRun = await runVerifyFull("bash scripts/verify.sh --full", "/w", 5000, async () => {
    throw quiet;
  });
  assert(
    quietRun.anchorOffset === undefined,
    `c5: a stream with no failure line reports no offset (got ${JSON.stringify(quietRun.anchorOffset)})`,
  );
  assert(
    keepEvidenceHead(quietRun.output, quietRun.anchorOffset) ===
      Array.from(quietRun.output).slice(-VERIFY_FULL_EVIDENCE_MAX).join(""),
    "c5: with no offset the evidence is the tail",
  );
}

// ── 5d. #1762 round 4 — the recovered run carries the FIRST run's own offset ───
// The stepback renders `firstRunOutput` as the evidence for a recovered run, so the
// offset it hands the cut must describe THAT excerpt. The re-run passed, so its
// anchor (or absence of one) says nothing about where the first run's failure sits —
// `runVerifyFull` reports the first run's offset for a recovered tier precisely so
// the cut cannot be made at a position that describes a different string.
{
  const FAIL_LINE = "✗ the flaky gate tripped on the fixture";
  const firstStream = `${"noise: before the failure\n".repeat(40)}${FAIL_LINE}\n${"passing summary line 7 ok\n".repeat(200)}`;
  const secondStream = "all checks passed, nothing to report".repeat(30);
  let call = 0;
  const result = await runVerifyFull(
    "bash scripts/verify.sh --full",
    "/w",
    5000,
    async () => {
      call++;
      if (call === 1) {
        throw Object.assign(new Error("Command failed: bash scripts/verify.sh --full"), {
          stdout: firstStream,
          stderr: "",
        });
      }
      return { stdout: secondStream, stderr: "" };
    },
    { retry: true },
  );
  assert(
    result.recovered === true && result.outcome === "success",
    `c5: the re-run recovered the tier (${JSON.stringify(result.outcome)}, recovered ${JSON.stringify(result.recovered)})`,
  );
  assert(
    result.firstRunOutput?.includes(FAIL_LINE) === true,
    "c5: the recovered run still preserves the first run's failing excerpt",
  );
  const firstEvidence = keepEvidenceHead(result.firstRunOutput ?? result.output, result.anchorOffset);
  assert(
    firstEvidence.startsWith(FAIL_LINE),
    `c5: the recovered evidence cut uses the first run's own offset (got ${JSON.stringify(firstEvidence.slice(0, 70))})`,
  );
  assert(
    keepEvidenceHead(result.output, result.anchorOffset).length <= VERIFY_FULL_EVIDENCE_MAX,
    "c5: the reported excerpt still cuts to the handoff budget",
  );
}

console.log(failed() ? "\nFAILED" : "\nAll #1762 round-4 anchor-offset checks passed.");
process.exit(failed() ? 1 : 0);
