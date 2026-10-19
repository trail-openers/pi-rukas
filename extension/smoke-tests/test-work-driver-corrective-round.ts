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
 * The pure decision (exemptions, attribution, deps rule) is pinned in
 * test-work-driver-corrective-decide.ts.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
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
 * tail starts at the last FAILED: marker.
 */
function checkScript(runsLog: string, plain: boolean): string {
  const body = plain
    ? 'echo "FAILED: b.ts"; echo "something went wrong"'
    : 'echo "FAILED: b.ts"; echo "\u2717 b.ts: expected fixed.txt to exist"';
  return `#!/bin/sh\necho run >> ${runsLog}\n[ -f work.txt ] || exit 0\n[ -f fixed.txt ] && exit 0\n${body}\nexit 1\n`;
}

async function fixture(
  name: string,
  plain = false,
): Promise<{ repo: string; baseSha: string; runsLog: string }> {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  const runsLog = path.join(root, `${name}-runs.log`);
  writeFileSync(path.join(repo, "check.sh"), checkScript(runsLog, plain));
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
async function run(name: string, mode: Mode, plain = false) {
  const { repo, baseSha, runsLog } = await fixture(name, plain);
  const wt = path.join(repo, ".worktrees", `issue-${ISSUE}-a`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  const calls: Call[] = [];
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
    if (mode !== "fail" || !corrective) {
      await git(wt, ["add", "-A"]);
      await git(wt, ["commit", "-q", "-m", corrective ? "fix" : "first"]);
    }
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
  return { after, calls, runsLog };
}

const rounds = (s: WorkState) => s.eventLog.filter((e) => e.kind === "corrective-round");
const correctiveCalls = (calls: Call[]) =>
  calls.filter((c) => (c.prompt ?? "").includes("corrective develop round"));
const lastCap = (s: WorkState) => {
  const last = s.eventLog[s.eventLog.length - 1];
  return last?.kind === "cap-hit" ? last.cap : undefined;
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
  const { after, calls } = await run("plain", "fix", true);
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

rmSync(root, { recursive: true, force: true });
if (exit !== 0) process.exit(exit);
console.log("all corrective-round assertions passed");
