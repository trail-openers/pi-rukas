#!/usr/bin/env bun
/**
 * #546 — long-dispatch mid-stream deaths arrive looking like partial success.
 *
 * Three subagents died mid-stream during the #543/#544 session (95-min silent
 * reviewer, 159-turn fix developer, 231-turn lens-mediums developer). Each was
 * recovered by surveying disk state and re-dispatching with the full contract
 * — but only because a human noticed. The report read like partial success.
 *
 * AC1: a report whose final text is a truncated tool-narration line (no
 * completion-shaped summary) on a long run (> 80 turns) is tagged
 * POSSIBLY-TRUNCATED in both report shapes.
 * AC2: the taxonomy distinguishes "mid-stream truncation with on-disk work"
 * from a provider error and suggests the resume-from-disk pattern.
 *
 * Detection is intentionally conservative: false positives cost one "verify on
 * disk" line; false negatives reproduce the original failure.
 */

import {
  TRUNCATION_TURN_THRESHOLD,
  formatBatchReport,
  formatSingleReport,
  isTruncatedNarration,
  looksLikeCompletion,
} from "../src/async-jobs-report.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ the detector

{
  const truncated = "Now editing the file to add the marker.";
  const complete = "Task complete: truncation detector";
  const statusFirst = "Status: Ready for PM to merge";
  const testsPass = "All tests pass — 47 offline smoke tests, tsc clean.";
  const gate = "Offline gate green: tsc + biome + 120 tests.";

  assert(looksLikeCompletion(truncated) === false, "truncated narration is not a completion");
  assert(looksLikeCompletion(complete) === true, "'Task complete' matches case-insensitively");
  assert(looksLikeCompletion("task COMPLETE: done") === true, "...including different casing");
  assert(looksLikeCompletion(statusFirst) === true, "'Status:' start of the last line matches");
  assert(looksLikeCompletion(testsPass) === true, "'All tests pass' matches");
  assert(looksLikeCompletion(gate) === true, "'Offline gate' matches");
  assert(looksLikeCompletion("") === false, "empty text is not a completion");
  assert(looksLikeCompletion("  \n\n  ") === false, "whitespace-only text is not a completion");

  assert(
    isTruncatedNarration("Task complete: x", 100) === false,
    "a run that completed is not truncated",
  );
  assert(
    isTruncatedNarration("Now editing the file", 100) === true,
    "narration ending mid-line IS truncated",
  );
  assert(
    isTruncatedNarration("", TRUNCATION_TURN_THRESHOLD) === false,
    "no text, no false positive at the threshold",
  );
}

// ------------------------------------------------------- the report tag

const narration =
  "Now applying the patch to work-driver-lens.ts (edits[].oldText must match exactly).\n";

const result = (over: Partial<DispatchResult> & { turns?: number }): DispatchResult => {
  const turns = over.turns ?? 100;
  const { turns: _turns, ...rest } = over;
  return {
    role: "developer",
    ok: true,
    exitCode: 0,
    ms: 600_000,
    text: "",
    toolUses: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns },
    ...rest,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any as DispatchResult;
};

{
  // AC1 — long run, narration-shaped tail: tagged, and it says what to do.
  const longTruncated = result({ text: narration });
  const report = formatSingleReport("j1", "developer", longTruncated);
  assert(
    report.includes("POSSIBLY-TRUNCATED"),
    "AC1: long narration-tail run is tagged POSSIBLY-TRUNCATED",
  );
  assert(report.includes("Verify on-disk state"), "the tag carries the verify-on-disk instruction");
  assert(
    /survey disk state/.test(report) || /resume/i.test(report),
    "AC2: the report suggests the resume-from-disk pattern, not a blind re-run",
  );
  assert(
    !/FAILED/.test(report),
    "canary: truncation is a warning, not a failure — the run ended exit 0",
  );

  // The batch shape shares describeOutcome, so both report shapes tag.
  const batch = formatBatchReport({
    batchId: "b",
    startedAt: Date.now(),
    members: [{ jobId: "j1", label: "developer", result: longTruncated }],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any);
  assert(batch.includes("POSSIBLY-TRUNCATED"), "AC1: the batch report carries the same tag");

  // AC2 — the taxonomy distinguishes mid-stream truncation with on-disk work
  // from a provider error.
  assert(
    !report.includes("FAILED-PROVIDER-ERROR"),
    "AC2: truncation is NOT reported as a provider error",
  );
  assert(
    report.includes("on-disk") || report.includes("on disk"),
    "AC2: the tag names the on-disk work that must be surveyed",
  );
}

{
  // The false-positive guards: the heuristic must stay conservative.
  const shortReport = formatSingleReport("j2", "developer", result({ text: narration, turns: 10 }));
  assert(
    !shortReport.includes("POSSIBLY-TRUNCATED"),
    "canary: short narration-tail run (10 turns) is NOT tagged",
  );

  const complete = result({
    text: "Task complete: truncation detector\n\n## Summary\nDone.",
    turns: 150,
  });
  assert(
    !formatSingleReport("j3", "developer", complete).includes("POSSIBLY-TRUNCATED"),
    "canary: long run ending in a completion line is NOT tagged",
  );

  for (const cause of ["abort", "inactivity", "timeout", "loop", "token-budget"] as const) {
    const killed = result({
      ok: false,
      killCause: cause,
      text: "Now editing the file.",
      turns: 200,
    });
    const r = formatSingleReport(`j-${cause}`, "developer", killed);
    assert(
      !r.includes("POSSIBLY-TRUNCATED"),
      `canary: killCause=${cause} reports its own cause, never the truncation tag`,
    );
  }

  const errored = result({
    ok: false,
    errorStop: { reason: "error", message: "Provider request error: terminated" },
    text: "Now editing the file.",
    turns: 200,
  });
  const errReport = formatSingleReport("j4", "developer", errored);
  assert(
    errReport.includes("FAILED-PROVIDER-ERROR") && !errReport.includes("POSSIBLY-TRUNCATED"),
    "canary: a genuine provider errorStop stays FAILED-PROVIDER-ERROR, not truncated",
  );

  // The "(no output)" placeholder must not be misread as narration.
  const silent = result({ text: "", turns: 120 });
  assert(
    !formatSingleReport("j5", "developer", silent).includes("POSSIBLY-TRUNCATED"),
    "canary: a long silent run reports '(no output)', not the truncation tag",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
