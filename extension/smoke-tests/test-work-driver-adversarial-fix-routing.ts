#!/usr/bin/env bun
/**
 * #1114 — the adversarial gate reviews, the develop step fixes.
 *
 * Offline routing contract for the /work driver's adversarial step:
 *  - the step makes ZERO developer dispatches and leaves each worktree's
 *    `git status --porcelain` identical before and after;
 *  - a parsed ISSUES_FOUND / CRITICAL_ISSUES_FOUND at a non-terminal round
 *    routes that workstream to develop (fix-requested), and nothing else;
 *  - an unparsed verdict or a failed dispatch is infra: never routed, never
 *    counted toward the round cap;
 *  - with two workstreams, the approving one is neither re-developed nor
 *    re-reviewed when the other is routed back;
 *  - the round cap is per workstream and derived from the event log; at the
 *    last round only CRITICAL parks;
 *  - the develop fix pass reuses the worktree, widens scope only for named
 *    paths, and parks on a no-op pass.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Zero the in-step retry backoff; the diff is empty in these non-git trees, so
// disable the empty-diff skip (the same setting the other adversarial tests use).
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

type Status = "APPROVED" | "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND" | "MINOR_OBSERVATIONS";

function review(status: Status, round: number, findings = `finding in ${round}`): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    exitCode: 0,
    text: findings,
    toolUses: [],
    ms: 1,
    loopOutcome: "approved",
    adversarialRounds: [{ round, status, verdictParsed: true }],
  } as DispatchResult;
}

function unparsed(round: number): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: false,
    exitCode: 1,
    text: "no verdict",
    toolUses: [],
    ms: 1,
    loopOutcome: "infra-failure",
    adversarialRounds: [{ round, status: "ISSUES_FOUND", verdictParsed: false }],
  } as DispatchResult;
}

function tmpDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `adv-fix-${label}-`));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return dir;
}

function git(cwd: string, cmd: string): string {
  return execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd, stdio: "pipe" }).toString();
}

function singleState(dir: string, eventLog: WorkState["eventLog"] = []): WorkState {
  const s = initialState(1114, 1_000_000);
  return {
    ...s,
    eventLog,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: { default: dir },
      branchName: "feature/issue-1114",
    },
  };
}

function ctxFor(
  dir: string,
  loop: NonNullable<DriverContext["adversarialLoopFn"]>,
  devSpawns: string[],
): DriverContext {
  return {
    pi: { sendUserMessage: () => {} } as unknown as DriverContext["pi"],
    repoRoot: dir,
    issue: 1114,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
    adversarialLoopFn: loop,
    dispatchFn: async (_pi, spec) => {
      devSpawns.push(spec.role);
      throw new Error(`stub dispatcher: ${spec.role}`);
    },
  };
}

// A — the review does not touch the tree, dispatches no developer, and a
// parsed ISSUES_FOUND routes the workstream to develop.
{
  const dir = tmpDir("route");
  try {
    git(dir, "init -q -b main");
    writeFileSync(path.join(dir, "a.txt"), "uncommitted work\n");
    const before = git(dir, "status --porcelain");
    const devSpawns: string[] = [];
    const calls: Array<{ reportOnly?: boolean; round?: number }> = [];
    const ctx = ctxFor(
      dir,
      async (params) => {
        calls.push({ reportOnly: params.reportOnly, round: params.reportRound });
        return review("ISSUES_FOUND", 1, "the parser drops the last line");
      },
      devSpawns,
    );
    const s = await runAdversarial(ctx, singleState(dir), Date.now());
    const after = git(dir, "status --porcelain");
    assert(devSpawns.length === 0, "A: the adversarial step makes zero developer dispatches");
    assert(before === after, "A: git status --porcelain is identical before and after the step");
    assert(
      calls.length === 1 && calls[0]?.reportOnly === true,
      "A: one reportOnly review per call",
    );
    const tail = s.eventLog[s.eventLog.length - 1];
    assert(
      tail?.kind === "adversarial-fix-requested",
      "A: a parsed ISSUES_FOUND ends in fix-requested",
    );
    assert(
      nextStep(s).kind === "step" && (nextStep(s) as { step: string }).step === "develop",
      "A: fix-requested routes to develop",
    );
    assert(
      pendingFixes(s.eventLog)[0]?.findings.includes("the parser drops the last line") === true,
      "A: the findings travel with the routing event",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A2 — the route back: a fix pass that applied returns the workstream to
// the review gate explicitly, and the routing record is what decides it.
{
  const s = singleState("/nonexistent", [
    { kind: "adversarial-fix-requested", at: 1, workstreamId: "default", round: 1, findings: "f" },
    { kind: "adversarial-fix-applied", at: 2, workstreamId: "default", round: 1 },
  ]);
  const d = nextStep(s);
  assert(
    d.kind === "step" && d.step === "adversarial",
    `A2: fix-applied routes back to adversarial (got ${JSON.stringify(d)})`,
  );
}

// B — an unparsed verdict is infra: no routing, no develop, no counted round.
{
  const dir = tmpDir("infra");
  try {
    const devSpawns: string[] = [];
    const seen: Array<number | undefined> = [];
    const ctx = ctxFor(
      dir,
      async (params) => {
        seen.push(params.reportRound);
        return unparsed(params.reportRound ?? 1);
      },
      devSpawns,
    );
    const s = await runAdversarial(ctx, singleState(dir), Date.now());
    assert(
      !s.eventLog.some((e) => e.kind === "adversarial-fix-requested"),
      "B: an unparsed verdict never routes to develop",
    );
    assert(devSpawns.length === 0, "B: no developer dispatch on an unparsed verdict");
    const rounds = s.eventLog.filter((e) => e.kind === "adversarial-round");
    assert(
      rounds.every((e) => e.kind === "adversarial-round" && e.verdictParsed === false),
      "B: the unparsed round is recorded as unparsed",
    );
    assert(seen[0] === 1, "B: the next review still carries round 1 (infra does not count)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// C — two workstreams: only the non-approving one goes back to develop, and
// after its fix pass only it is re-reviewed; the approved one keeps its verdict.
{
  const a = tmpDir("ws-a");
  const b = tmpDir("ws-b");
  try {
    const devSpawns: string[] = [];
    const calls: Array<{ id: string; round?: number }> = [];
    const verdicts: Record<string, Status> = { a: "APPROVED", b: "ISSUES_FOUND" };
    const ctx = ctxFor(
      a,
      async (params) => {
        const id = params.workCwd === b ? "b" : "a";
        calls.push({ id, round: params.reportRound });
        return review(verdicts[id] as Status, params.reportRound ?? 1);
      },
      devSpawns,
    );
    let s: WorkState = initialState(1114, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { a, b },
        workstreams: {
          a: { id: "a", scope: "a", paths: [], outOfScope: [] },
          b: { id: "b", scope: "b", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-1114",
      },
    };
    s = await runAdversarial(ctx, s, Date.now());
    const routed = pendingFixes(s.eventLog).map((p) => p.workstreamId);
    assert(
      routed.join(",") === "b",
      `C: only the non-approving workstream is routed (got ${routed.join(",") || "none"})`,
    );
    assert(
      s.eventLog.some(
        (e) =>
          e.kind === "adversarial-workstream-outcome" &&
          e.workstreamId === "a" &&
          e.outcome === "approved",
      ),
      "C: the approving workstream's verdict is recorded and waits",
    );
    s = appendEvent(s, {
      kind: "adversarial-fix-applied",
      at: Date.now(),
      workstreamId: "b",
      round: 1,
    });
    verdicts.b = "APPROVED";
    calls.length = 0;
    s = await runAdversarial(ctx, s, Date.now());
    assert(
      calls.length === 1 && calls[0]?.id === "b" && calls[0]?.round === 2,
      `C: only b is re-reviewed, on round 2 (got ${JSON.stringify(calls)})`,
    );
    assert(
      s.eventLog.some((e) => e.kind === "adversarial-approved"),
      "C: the aggregate approval lands once every workstream has a final verdict",
    );
    assert(devSpawns.length === 0, "C: the adversarial step never dispatches a developer");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
}

// C2 — mixed fan-out: one workstream routed to fix, its sibling infra. The
// routing record is written (the fix request is not dropped) and the infra
// sibling is left for re-entry.
{
  const a2 = tmpDir("mix-a");
  const b2 = tmpDir("mix-b");
  try {
    const ctx = ctxFor(
      a2,
      async (params) =>
        params.workCwd === b2
          ? unparsed(params.reportRound ?? 1)
          : review("ISSUES_FOUND", params.reportRound ?? 1, "a finding"),
      [],
    );
    let s: WorkState = initialState(1114, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "adversarial",
        lastCompletedStep: "develop",
        worktrees: { a: a2, b: b2 },
        workstreams: {
          a: { id: "a", scope: "a", paths: [], outOfScope: [] },
          b: { id: "b", scope: "b", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-1114",
      },
    };
    s = await runAdversarial(ctx, s, Date.now());
    // The infra sibling exhausts its budget on the first pass, so the cycle
    // parks on the explicit infra cap — the fix request is never silently
    // dropped and the aggregate never approves.
    const tail = s.eventLog[s.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" || pendingFixes(s.eventLog).map((p) => p.workstreamId).join(",") === "a",
      `C2: a mixed fan-out either routes a's fix or parks explicitly (tail: ${tail?.kind})`,
    );
    assert(
      !s.eventLog.some((e) => e.kind === "adversarial-approved"),
      "C2: a mixed fan-out with a parsed ISSUES_FOUND never approves",
    );
  } finally {
    rmSync(a2, { recursive: true, force: true });
    rmSync(b2, { recursive: true, force: true });
  }
}

// D — the round cap is per workstream and counted from the log. Two routed
// rounds are already recorded, so the next review is round 3 (the last):
// CRITICAL parks, ISSUES_FOUND passes with its findings disclosed.
function seededLog(): WorkState["eventLog"] {
  const log: WorkState["eventLog"] = [];
  for (const r of [1, 2]) {
    log.push(
      { kind: "adversarial-round", at: 1, round: r, status: "ISSUES_FOUND", verdictParsed: true },
      {
        kind: "adversarial-fix-requested",
        at: 2,
        workstreamId: "default",
        round: r,
        findings: `r${r}`,
      },
      { kind: "adversarial-fix-applied", at: 3, workstreamId: "default", round: r },
    );
  }
  return log;
}
{
  const dir = tmpDir("cap-critical");
  try {
    const seen: number[] = [];
    const ctx = ctxFor(
      dir,
      async (params) => {
        seen.push(params.reportRound ?? 0);
        return review("CRITICAL_ISSUES_FOUND", params.reportRound ?? 0, "critical");
      },
      [],
    );
    const s = await runAdversarial(ctx, singleState(dir, seededLog()), Date.now());
    assert(seen[0] === 3, `D: the third review carries round 3 (got ${seen[0]})`);
    assert(
      s.eventLog.some((e) => e.kind === "cap-hit" && e.cap === "adversarial-loop"),
      "D: CRITICAL at the last round parks",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = tmpDir("cap-issues");
  try {
    const ctx = ctxFor(
      dir,
      async (params) => review("ISSUES_FOUND", params.reportRound ?? 0, "minor-ish"),
      [],
    );
    const s = await runAdversarial(ctx, singleState(dir, seededLog()), Date.now());
    const approved = s.eventLog.find((e) => e.kind === "adversarial-approved");
    assert(
      approved?.kind === "adversarial-approved" && (approved.findings ?? "").includes("minor-ish"),
      "D: ISSUES_FOUND at the last round proceeds with its findings disclosed",
    );
    assert(
      !s.eventLog.some((e) => e.kind === "cap-hit"),
      "D: no cap for a non-critical last round",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
