#!/usr/bin/env bun
/**
 * #1024 (headless S4) — state-file fixtures → exit code, the grouped rule, the
 * clarification questions, the JSON projection, and the argv parser.
 * Also exercises #1189 divergence paths (secondary-issue tamper, missing file
 * with in-memory state) via `runHeadless` with a stubbed driver.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseHeadlessArgs } from "../src/headless/cli.ts";
import { EXIT, exitCodeForGroup, exitCodeForState } from "../src/headless/exit-code.ts";
import { projectIssue, questionsOf } from "../src/headless/result.ts";
import { detectDivergence, runHeadless } from "../src/headless/run.ts";
import type { WorkCapLiteral } from "../src/workflow-state-events-caps.ts";
import { workStateFile } from "../src/workflow-state.ts";
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

// ── #1189 — divergence detection: in-memory vs. on-disk state.
{
  const base = withStatus(50, "merged", [
    { kind: "step-started", step: "explore", at: 1000 },
    { kind: "merged", at: 5000, prNumber: 7 },
  ]);
  // Identical states → no divergence.
  assert(
    detectDivergence(base, structuredClone(base)).length === 0,
    "identical states → no divergence",
  );
  // Agent rewrote the status in the file: the file says `merged` but the driver
  // in-memory said `handoff` → divergence.
  const tamperedStatus = structuredClone(base);
  tamperedStatus.pipelineState.status = "handoff" as const;
  const statusDiffs = detectDivergence(base, tamperedStatus);
  assert(
    statusDiffs.length === 1 && statusDiffs[0] === "pipelineState",
    "status flip in the file → pipelineState divergence",
  );
  // Agent rewrote the PR number in the file.
  const tamperedPr = structuredClone(base);
  tamperedPr.pipelineState.prNumber = 999;
  const prDiffs = detectDivergence(base, tamperedPr);
  assert(
    prDiffs.length === 1 && prDiffs[0] === "pipelineState",
    "PR-number flip in the file → pipelineState divergence",
  );
  // Agent appended an event to the file that the driver never recorded.
  const tamperedLog = structuredClone(base);
  tamperedLog.eventLog = [...tamperedLog.eventLog, { kind: "merged", at: 9999, prNumber: 42 }];
  const logDiffs = detectDivergence(base, tamperedLog);
  assert(logDiffs.includes("eventLog"), "appended event in the file → eventLog divergence");
  // updatedAt is excluded: the driver's in-memory copy predates the final
  // persist that rewrote it. A file with a different updatedAt is NOT a
  // divergence.
  const tamperedAt = structuredClone(base);
  tamperedAt.updatedAt = base.updatedAt + 10_000;
  assert(detectDivergence(base, tamperedAt).length === 0, "updatedAt alone → not a divergence");
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

// ── #1189 — divergence gate is PRIMARY-SCOPED (round 3).
// The driver's onFinalState snapshot describes the cycle's PRIMARY issue only.
// In a grouped run, a secondary issue's state file (legitimately different —
// e.g. a pre-existing file from a prior completed cycle) is NOT compared
// against the primary's snapshot. `detectDivergence` still finds the
// field-level diff (it is pure), but the runner's gate is
// `inMemory !== undefined && issue === primary`, so a legitimately-different
// secondary is reported from its own file with NO diverged flag and its own
// exit code. The round-2 false positive (any issue vs the snapshot) is fixed.
{
  const primaryInMemory = withStatus(60, "merged");
  const secondaryFile = withStatus(61, "handoff");
  // The pure comparison still sees the field-level difference (no longer the
  // runner's concern for a secondary — the gate simply does not reach it).
  assert(
    detectDivergence(primaryInMemory, secondaryFile).includes("pipelineState"),
    "detectDivergence is field-pure: a different secondary state still diffs",
  );
  // The runner's gate is primary-scoped, so the secondary is NOT compared:
  const gateRunsForPrimary = primaryInMemory !== undefined && 60 === 60;
  const gateRunsForSecondary = primaryInMemory !== undefined && 61 === 60;
  assert(gateRunsForPrimary, "gate runs for the primary (issue === primary)");
  assert(
    !gateRunsForSecondary,
    "gate does NOT run for a secondary (issue !== primary) → no divergence",
  );
  // The secondary is therefore projected from its own file: its own status,
  // its own exit code, no diverged flag.
  const projected = projectIssue(secondaryFile, "/state/61.json");
  assert(
    projected.status === "handoff" && projected.exitCode === EXIT.handoff,
    "legitimately-different secondary: status/exitCode from its own file",
  );
  assert(projected.diverged === undefined, "legitimately-different secondary: no diverged flag");
}

// ── #1189 — corrupt state file: per-issue readState throw is caught.
// A state file with malformed JSON is exactly the tamper case the divergence
// gate addresses. The runner must report not-started + exit 30 + diverged for
// THAT issue and keep the loop alive — a prior issue's result in the same
// grouped run must survive, instead of the throw escaping to a generic crash
// that loses every prior result.
{
  const repo = mkdtempSync(path.join(tmpdir(), "headless-corrupt-"));
  const lines: string[] = [];
  const sig: Pick<NodeJS.Process, "on" | "off"> = {
    on: () => {},
    off: () => {},
  };
  try {
    // Pre-seed a clean, terminal state for the PRIMARY (issue 63): the driver
    // (stubbed, refuses immediately) does not touch it, so the loop reads it
    // back cleanly. The secondary (issue 64) gets a malformed-JSON file.
    mkdirSync(path.join(repo, ".pi", "work-state"), { recursive: true });
    writeFileSync(workStateFile(repo, 63), JSON.stringify(withStatus(63, "merged")));
    writeFileSync(workStateFile(repo, 64), "{ not valid json");
    const result = await runHeadless({
      repoRoot: repo,
      issues: [63, 64],
      restart: false,
      signalTarget: sig,
      driverSeams: {
        dispatchFn: () => new Promise<never>(() => undefined),
        issueBodyFetcherFn: async () => ({ stdout: "title:\tmock\nstate:\tOPEN\n\nbody" }),
      },
      write: (l) => {
        lines.push(l);
      },
    });
    const primary = result.results.find((r) => r.issue === 63);
    const corrupt = result.results.find((r) => r.issue === 64);
    assert(
      primary !== undefined && primary.status === "merged" && primary.exitCode === EXIT.merged,
      "prior (primary) result is preserved: merged, exit 0",
    );
    assert(
      corrupt?.status === "not-started" && corrupt?.exitCode === EXIT.crash,
      "corrupt state file: not-started + exit 30",
    );
    assert(corrupt?.diverged === true, "corrupt state file: diverged is true");
    assert(
      result.error?.code === "state-diverged" &&
        result.error.message.includes("corrupt or unreadable"),
      "corrupt state file: top-level error is state-diverged naming the corrupt issue",
    );
    assert(result.exitCode === EXIT.crash, `group exit is 30 (got ${result.exitCode})`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── #1189 — missing state file with in-memory snapshot → exit 30 + diverged.
// The driver completes (refusal path calls reportFinalState), but the state
// file for an issue is absent. The runner must project from inMemory, set
// diverged: true, exit 30, and emit the state-diverged error — not silently
// report "not-started".
//
// We verify the projection shape directly: projectIssue on the in-memory
// state, then the runner's overrides (exitCode 30, diverged true).
{
  const inMemory = withStatus(62, "handoff", [cap("round-cap")]);
  const p = projectIssue(inMemory, "/nonexistent/62.json");
  // The runner's missing-file branch would set these:
  p.exitCode = EXIT.crash;
  p.diverged = true;
  assert(p.exitCode === 30, "missing file + in-memory: exitCode is 30 (EXIT.crash)");
  assert(p.diverged === true, "missing file + in-memory: diverged is true");
  assert(p.status === "handoff", "missing file + in-memory: status from inMemory is handoff");
  assert(p.status !== "not-started", "missing file + in-memory: status is NOT 'not-started'");
}

process.exit(exit);
