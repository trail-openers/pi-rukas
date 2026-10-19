#!/usr/bin/env bun
/**
 * #1667 — the develop step's one corrective round, driven through the REAL
 * runDevelopTopological in a live temp git repo (the test-symbol-merge-retry
 * shape). The project's verify command is a shell stand-in that prints a `✗`
 * assertion line until `fixed.txt` exists.
 *
 *   1. a ✗ failure gets ONE corrective round; the developer's fix passes the
 *      second verify; no cap-hit; the round's record names the lines given.
 *   2. the round is persisted before its developer runs (write-ahead).
 *   3. a second failure after the round parks at verify-failed:develop, with
 *      exactly one corrective dispatch.
 *   4. a corrective developer that fails parks with NO re-verify.
 *   5. a verify failure with no ✗ / error line gets no round.
 *   6. a corrected cycle records the same post-verify events as an uncorrected
 *      passing one (both reach the one shared verdict path).
 *   7. a crash before the write-ahead leaves no round on disk (the state
 *      directory refuses the write during the first verify). A crash AFTER the
 *      write-ahead leaves the round on disk: resume then re-runs the first pass
 *      (no repair re-run) and parks safely at verify-failed:develop if it is
 *      still red, because the round is counted from the log.
 *   8. a corrective pass's verdict replaces its first-pass verdict (refreshVerdicts).
 * The pure decision (exemptions, attribution, deps rule) is pinned in
 * test-work-driver-corrective-decide.ts.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import { refreshVerdicts } from "../src/work-driver-corrective-round.ts";
import type { DevelopGate } from "../src/work-driver-develop-verdict.ts";
import { recordDevelopVerdict } from "../src/work-driver-develop-verdict.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { type WorkState, initialState, readState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ISSUE = 1667;
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1667-"));
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout.trim();

/**
 * The verify stand-in. It passes at base (no work.txt) and fails once the first
 * developer's work.txt exists without fixed.txt. The failure prints the marker
 * FIRST and the ✗ line after it — the golden #1579 shape, since the attributed
 * tail starts at the last FAILED: marker. `lockDir`, when given, is made
 * read-only by the failing run: the next state write then fails, as a crash
 * between the decision and the write-ahead would.
 */
function checkScript(runsLog: string, plain: boolean, lockDir?: string): string {
  const body = plain
    ? 'echo "FAILED: b.ts"; echo "something went wrong"'
    : 'echo "FAILED: b.ts"; echo "\u2717 b.ts: expected fixed.txt to exist"';
  const lock = lockDir === undefined ? "" : `chmod 555 ${lockDir}\n`;
  return `#!/bin/sh\necho run >> ${runsLog}\n[ -f work.txt ] || exit 0\n[ -f fixed.txt ] && exit 0\n${lock}${body}\nexit 1\n`;
}

interface RunOpts {
  plain?: boolean;
  /** The first developer also writes the fix, so the first verify passes. */
  firstFixes?: boolean;
  /** Lock the state directory on the failing verify (the crash simulation). */
  lockStateOnFail?: boolean;
  /** Receives every developer dispatch, so a run that throws still reports them. */
  sink?: Call[];
}

async function fixture(name: string, opts: RunOpts): Promise<{ repo: string; baseSha: string; runsLog: string }> {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  const runsLog = path.join(root, `${name}-runs.log`);
  const lockDir = opts.lockStateOnFail === true ? path.join(repo, ".pi", "work-state") : undefined;
  writeFileSync(path.join(repo, "check.sh"), checkScript(runsLog, opts.plain === true, lockDir));
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), "sh check.sh\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  return { repo, baseSha: await gitOut(repo, ["rev-parse", "HEAD"]), runsLog };
}

const runCount = (log: string): number => {
  try {
    return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

type Mode = "fix" | "noop" | "fail";
interface Call {
  cwd?: string;
  prompt?: string;
  runsAtDispatch?: number;
  stateEventsAtDispatch?: string[];
}

/** One N=1 develop run: the first developer writes work.txt; the corrective one behaves per `mode`. */
async function run(name: string, mode: Mode, opts: RunOpts = {}) {
  const { repo, baseSha, runsLog } = await fixture(name, opts);
  const wt = path.join(repo, ".worktrees", `issue-${ISSUE}-a`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  const calls: Call[] = opts.sink ?? [];
  const dispatchFn = async (_pi: unknown, spec: { cwd?: string; prompt?: string }) => {
    const corrective = (spec.prompt ?? "").includes("corrective develop round");
    const call: Call = {
      cwd: spec.cwd,
      prompt: spec.prompt,
      runsAtDispatch: runCount(runsLog),
    };
    if (corrective) {
      // Write-ahead: the round must already be on disk when its developer starts.
      const onDisk = await readState(repo, ISSUE);
      call.stateEventsAtDispatch = (onDisk?.eventLog ?? [])
        .filter((e) => e.kind === "corrective-round")
        .map((e) => e.kind);
    }
    calls.push(call);
    if (!corrective) {
      writeFileSync(path.join(wt, "work.txt"), "first pass\n");
      if (opts.firstFixes === true) writeFileSync(path.join(wt, "fixed.txt"), "fixed\n");
    } else if (mode === "fix") {
      writeFileSync(path.join(wt, "fixed.txt"), "fixed\n");
    } else if (mode === "noop") {
      writeFileSync(path.join(wt, "other.txt"), "not the fix\n");
    }
    if (corrective && mode === "fail") {
      return {
        role: "developer",
        ok: false,
        text: "corrective developer gave up",
        toolUses: [],
        ms: 1,
        exitCode: 1,
        transcriptPath: "/tmp/x.json",
      } satisfies DispatchResult;
    }
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", corrective ? "fix" : "first"]);
    return {
      role: "developer",
      ok: true,
      text: "done",
      toolUses: [],
      ms: 1,
      exitCode: 0,
      transcriptPath: "/tmp/x.json",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    } satisfies DispatchResult;
  };
  const ctx = {
    host: {},
    issue: ISSUE,
    issues: [ISSUE],
    repoRoot: repo,
    verifyExecFn: realExec,
    stateRef: { current: initialState(ISSUE) },
    dispatchFn,
  } as unknown as DriverContext;
  const workstreams: Record<string, Workstream> = {
    a: {
      id: "a",
      scope: "a",
      paths: ["work.txt", "fixed.txt", "other.txt"],
      outOfScope: [],
    },
  };
  const base = initialState(ISSUE);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = { a: wt };
  base.pipelineState.workstreamBaseShas = { a: baseSha };
  base.pipelineState.workstreams = workstreams;
  base.pipelineState.currentStep = "develop";
  const after: WorkState = await runDevelopTopological(
    ctx,
    base,
    ["a"],
    workstreams,
    [ISSUE],
    dispatchFn as unknown as NonNullable<DriverContext["dispatchFn"]>,
    realExec,
    Date.now(),
    `job-1667-${name}`,
  );
  return { after, calls, runsLog, repo };
}

const rounds = (s: WorkState) => s.eventLog.filter((e) => e.kind === "corrective-round");
const correctiveCalls = (calls: Call[]) =>
  calls.filter((c) => (c.prompt ?? "").includes("corrective develop round"));
const lastCap = (s: WorkState) => {
  const last = s.eventLog[s.eventLog.length - 1];
  return last?.kind === "cap-hit" ? last.cap : undefined;
};
/** The event kinds after the last developer completion: the verdict path's own events. */
const verdictTail = (s: WorkState): string[] => {
  const log = s.eventLog;
  let from = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]?.kind === "dispatch-completed") {
      from = i;
      break;
    }
  }
  return log.slice(from + 1).map((e) => e.kind);
};

// ── 1. one round, the fix passes the second verify ───────────────────────
{
  const { after, calls } = await run("fix", "fix");
  const r = rounds(after);
  assert(r.length === 1, `fix: exactly one corrective-round record (got ${r.length})`);
  const rec = r[0];
  assert(
    rec?.kind === "corrective-round" &&
      rec.workstreamId === "a" &&
      rec.attempt === 1 &&
      rec.evidenceLines.some((l) => l.startsWith("\u2717")),
    "fix: the record names the workstream and the ✗ line it was given",
  );
  assert(correctiveCalls(calls).length === 1, "fix: exactly one corrective developer dispatch");
  assert(
    correctiveCalls(calls)[0]?.cwd?.endsWith("issue-1667-a") === true,
    "fix: the corrective developer runs in the failing worktree",
  );
  assert(
    lastCap(after) === undefined,
    `fix: the second verify passed, no cap-hit (got ${lastCap(after)})`,
  );
  // ── 2. write-ahead: the record was on disk before the developer ran.
  assert(
    correctiveCalls(calls)[0]?.stateEventsAtDispatch?.length === 1,
    "write-ahead: the corrective-round record was persisted before the corrective developer started",
  );
}

// ── 3. a second failure parks exactly once ────────────────────────────────
{
  const { after, calls } = await run("noop", "noop");
  assert(correctiveCalls(calls).length === 1, "second failure: no third developer dispatch");
  assert(
    lastCap(after) === "verify-failed:develop",
    `second failure: parks at verify-failed:develop (got ${lastCap(after)})`,
  );
  assert(rounds(after).length === 1, "second failure: still exactly one round recorded");
}

// ── 4. a failing corrective developer parks with no re-verify ───────────
{
  const { after, calls, runsLog } = await run("fail", "fail");
  const corrective = correctiveCalls(calls)[0];
  const cap = after.eventLog[after.eventLog.length - 1];
  assert(
    lastCap(after) === "verify-failed:develop",
    `developer failure: parks at verify-failed:develop (got ${lastCap(after)})`,
  );
  assert(
    cap?.kind === "cap-hit" &&
      (cap.evidence ?? "").includes("corrective developer a did not complete"),
    "developer failure: the evidence names the corrective developer that did not complete",
  );
  assert(
    corrective !== undefined && runCount(runsLog) === (corrective.runsAtDispatch ?? -1),
    "developer failure: no verify ran after the corrective developer (no re-verify)",
  );
}

// ── 5. no assertion line: no round ───────────────────────────────────────
{
  const { after, calls } = await run("plain", "fix", { plain: true });
  assert(
    correctiveCalls(calls).length === 0,
    "no-assertion: no corrective developer is dispatched",
  );
  assert(rounds(after).length === 0, "no-assertion: no corrective-round record");
  assert(
    lastCap(after) === "verify-failed:develop",
    "no-assertion: parks at verify-failed:develop as before",
  );
}

// ── 6. a corrected cycle reaches the same verdict events as an uncorrected one ──
{
  const corrected = await run("eq-corrected", "fix");
  const uncorrected = await run("eq-uncorrected", "noop", { firstFixes: true });
  assert(
    rounds(uncorrected.after).length === 0 && correctiveCalls(uncorrected.calls).length === 0,
    "equivalence: the uncorrected cycle passed its first verify (no round)",
  );
  assert(
    lastCap(corrected.after) === undefined && lastCap(uncorrected.after) === undefined,
    "equivalence: both cycles end with no cap-hit",
  );
  const a = verdictTail(corrected.after);
  const b = verdictTail(uncorrected.after);
  assert(
    a.length > 0 && JSON.stringify(a) === JSON.stringify(b),
    `equivalence: the post-verify events match (corrected ${a.join(",")} | uncorrected ${b.join(",")})`,
  );
}

// ── 7. a crash between the decision and the write-ahead: no round on disk ──
if (process.getuid?.() !== 0) {
  const crashCalls: Call[] = [];
  const crashed = await run("crash", "fix", { lockStateOnFail: true, sink: crashCalls }).then(
    () => "completed",
    () => "threw",
  );
  assert(crashed === "threw", "crash: the state write refused, so the develop step did not complete");
  const stateDir = path.join(root, "crash", ".pi", "work-state");
  chmodSync(stateDir, 0o755);
  const onDisk = await readState(path.join(root, "crash"), ISSUE);
  assert(
    (onDisk?.eventLog ?? []).every((e) => e.kind !== "corrective-round"),
    "crash: no corrective-round record reached disk before the crash",
  );
  assert(
    correctiveCalls(crashCalls).length === 0,
    "crash: no corrective developer was started",
  );
} else {
  console.log("skip: crash simulation needs a non-root user (chmod does not bind root)");
}

// ── 8. a corrective pass's verdict replaces its first-pass verdict ─────────
{
  const prior = [
    { id: "a", ok: false, reason: "first pass: developer did not complete" },
    { id: "b", ok: true },
  ];
  const refreshed = refreshVerdicts(prior, [{ id: "a", ok: true }]);
  assert(
    refreshed[0]?.id === "a" && refreshed[0]?.ok === true && refreshed[0]?.reason === undefined,
    "refresh: a workstream whose first pass failed and whose corrective pass succeeded is recorded ok",
  );
  assert(refreshed[1] === prior[1], "refresh: an untouched workstream keeps its first-pass verdict");
  const stillRed = refreshVerdicts(prior, [{ id: "a", ok: false, reason: "still red" }]);
  assert(
    stillRed[0]?.ok === false && stillRed[0]?.reason === "still red",
    "refresh: a corrective pass that fails is recorded with its own reason",
  );
  const claimedPrior = [{ id: "a", ok: false, reason: "first pass", claimed: true as const }];
  const kept = refreshVerdicts(claimedPrior, [{ id: "a", ok: true }]);
  assert(
    kept[0]?.claimed === true && kept[0]?.ok === true && kept[0]?.reason === undefined,
    "refresh: the claimed field survives a corrective refresh and the prior reason is dropped",
  );
}

// ── 9. a fence failure after the corrective round parks, no developer dispatch ──
{
  const state = initialState(ISSUE);
  let dispatches = 0;
  const dispatch = (async () => {
    dispatches += 1;
    throw new Error("no developer dispatch expected after the corrective round");
  }) as unknown as NonNullable<DriverContext["dispatchFn"]>;
  // A sibling-declared fence violation: the first-pass recovery would merge and re-dispatch.
  const gate = {
    ok: false,
    failures: ["fence: workstream a touched shared.ts, declared by workstream b"],
    fenceViolations: [
      { kind: "sibling-declared", workstreamId: "a", declaredById: "b", file: "shared.ts" },
    ],
  } as unknown as DevelopGate;
  const after = await recordDevelopVerdict({
    ctx: {} as unknown as CycleContext,
    state,
    stateRef: { current: state },
    ids: ["a"],
    verdicts: [{ id: "a", ok: true }],
    gate,
    execFn: realExec,
    dispatch,
    afterCorrectiveRound: true,
    onVerifyFailed: (s, g) => appendDevelopVerifyFailure(s, g),
  });
  assert(dispatches === 0, `after round: no developer is dispatched (got ${dispatches})`);
  assert(
    lastCap(after) === "verify-failed:develop",
    `after round: a fence failure parks at verify-failed:develop (got ${lastCap(after)})`,
  );
}

rmSync(root, { recursive: true, force: true });
if (exit !== 0) process.exit(exit);
console.log("all corrective-round assertions passed");
