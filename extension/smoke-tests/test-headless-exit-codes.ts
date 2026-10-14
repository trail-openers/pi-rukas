#!/usr/bin/env bun
/**
 * #1024 (headless S4) — state-file fixtures → exit code, the grouped rule, the
 * clarification questions, the JSON projection, and the argv parser.
 * Pure: no driver, no network, no Pi session.
 */
import { parseHeadlessArgs } from "../src/headless/cli.ts";
import { EXIT, exitCodeForGroup, exitCodeForState } from "../src/headless/exit-code.ts";
import { projectIssue, questionsOf } from "../src/headless/result.ts";
import type { WorkCapLiteral } from "../src/workflow-state-events-caps.ts";
import {
  type WorkEvent,
  type WorkState,
  appendEvent,
  initialState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function withStatus(
  issue: number,
  status: WorkState["pipelineState"]["status"],
  events: WorkEvent[] = [],
): WorkState {
  let s = initialState(issue);
  for (const e of events) s = appendEvent(s, e);
  return { ...s, pipelineState: { ...s.pipelineState, status } };
}

function cap(c: WorkCapLiteral, evidence?: string): WorkEvent {
  return {
    kind: "cap-hit",
    at: 2,
    cap: c,
    reviewRound: 0,
    ...(evidence ? { evidence } : {}),
  };
}

// ── Status → exit code.
assert(exitCodeForState(withStatus(1, "merged")) === EXIT.merged, "merged → 0");
assert(
  exitCodeForState(withStatus(1, "handoff", [cap("round-cap")])) === 10,
  "handoff on round-cap → 10",
);
assert(
  exitCodeForState(withStatus(1, "handoff", [cap("awaiting-human-merge")])) === 10,
  "awaiting-human-merge → 10",
);
assert(exitCodeForState(withStatus(1, "handoff")) === 10, "handoff without a cap → 10");
assert(
  exitCodeForState(withStatus(1, "handoff", [cap("intent-park")])) === 11,
  "handoff on intent-park → 11",
);
assert(
  exitCodeForState(withStatus(1, "handoff", [cap("explore-needs-clarification")])) === 11,
  "handoff on explore-needs-clarification → 11",
);
assert(exitCodeForState(withStatus(1, "aborted")) === 20, "aborted → 20");
assert(
  exitCodeForState(
    withStatus(1, "interrupted", [{ kind: "interrupted", at: 1, reason: "signal" }]),
  ) === 21,
  "interrupted by a signal → 21",
);
assert(
  exitCodeForState(
    withStatus(1, "interrupted", [{ kind: "interrupted", at: 1, reason: "timeout" }]),
  ) === 30,
  "interrupted by --timeout → 30",
);
assert(
  exitCodeForState(withStatus(1, "running")) === 30,
  "a cycle left running after the driver returned → 30",
);

// ── Grouped rule: 21 if any interrupted, else the highest per-issue code.
assert(exitCodeForGroup([0, 10]) === 10, "group [merged, handoff] → 10 (the highest)");
assert(exitCodeForGroup([0, 21]) === 21, "group with an interrupted issue → 21");
assert(exitCodeForGroup([10, 11]) === 11, "group [handoff, clarification] → 11");
assert(exitCodeForGroup([0, 0]) === 0, "group of merged → 0");

// ── Questions for exit 11: the cap's bullets, numbered q1, q2…
{
  const s = withStatus(2, "handoff", [
    cap(
      "intent-park",
      "Park reason: underspecified\n- Which database?\n* Which region?\nnot a bullet",
    ),
  ]);
  assert(
    JSON.stringify(questionsOf(s)) === JSON.stringify(["q1: Which database?", "q2: Which region?"]),
    "clarification questions are the cap evidence bullets, numbered q1, q2",
  );
  const p = projectIssue(s, "/tmp/x.json");
  assert(
    p.exitCode === 11 && p.questions?.length === 2,
    "projection carries exit 11 and the questions",
  );
}

// ── Projection: status, cap, branch, PR from the merged event, durations, steps.
{
  let s = withStatus(3, "merged", [
    { kind: "step-started", step: "explore", at: 1000 },
    { kind: "step-started", step: "plan", at: 2000 },
    { kind: "merged", at: 5000, prNumber: 77 },
  ]);
  s = { ...s, pipelineState: { ...s.pipelineState, branchName: "feature/issue-3-x" } };
  const p = projectIssue(s, "/state/3.json");
  assert(
    p.status === "merged" && p.exitCode === 0 && p.prNumber === 77,
    "projection: status, exit, PR",
  );
  assert(
    p.branch === "feature/issue-3-x" && p.stateFile === "/state/3.json",
    "projection: branch and stateFile",
  );
  assert(p.durationMs === 4000, "projection: durationMs is last eventLog at − first");
  assert(
    p.steps.length === 2 && p.steps[0]?.step === "explore",
    "projection: steps from step-started",
  );
  assert(
    p.questions === undefined && p.cap === undefined,
    "projection: no questions or cap when merged",
  );
}

// ── Argv parser.
{
  const ok = parseHeadlessArgs(["12", "13", "--restart", "--timeout", "5", "--json"]);
  assert(
    !("error" in ok) &&
      ok.issues.join(",") === "12,13" &&
      ok.restart &&
      ok.json &&
      ok.timeoutMs === 300_000,
    "parseHeadlessArgs reads issues, --restart, --timeout (minutes) and --json",
  );
  assert("error" in parseHeadlessArgs([]), "parseHeadlessArgs refuses no issue");
  assert("error" in parseHeadlessArgs(["abc"]), "parseHeadlessArgs refuses a non-numeric token");
  assert(
    "error" in parseHeadlessArgs(["3", "--timeout", "0"]),
    "parseHeadlessArgs refuses --timeout 0",
  );
}

process.exit(exit);
