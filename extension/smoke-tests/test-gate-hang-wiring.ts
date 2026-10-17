/**
 * Offline smoke: a gate the driver KILLS at its bound produces a hang report,
 * and the report reaches the places an operator looks.
 *
 * #1427. `test-gate-hang-report.ts` unit-tests the reporter; this drives the
 * two seams that call it, with a stub executor that rejects the way `execTree`
 * does on a timeout (`killed: true` + `treePid`), and asserts the three things
 * the issue asks for:
 *
 *   1. the timeout failure string names the hung test instead of only the bound;
 *   2. a report file is written and its path is recorded STRUCTURALLY — on the
 *      cap-hit event's `logPaths`, which is what the handoff renders;
 *   3. the handoff explainer turns that into "what hung: <path>", so a timeout
 *      sends the operator to the stuck process rather than to the diff.
 *
 * The tree walker is injected everywhere: the assertions are about what the
 * driver REPORTS, and a real `ps` on the host would make the expected output
 * depend on whatever else is running.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-gate-hang-wiring.ts
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainVerifyTimeout } from "../src/work-driver-explain-verify.ts";
import { GATE_HANG_LABEL } from "../src/work-driver-gate-hang.ts";
import type { HangProcess } from "../src/work-driver-gate-hang.ts";
import { initialState } from "../src/workflow-state.ts";
import { asShellForm, commandOf } from "./lib/argv-shell.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const sh = (cwd: string, cmd: string) => execFileP("/bin/sh", ["-c", cmd], { cwd });

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1427-"));

const STUCK_TEST = "repo::sync::tests::pull_then_fetch";
const HUNG_STREAM = [
  "running 212 tests",
  "test git::fetch::tests::ok ... ok",
  `test ${STUCK_TEST} has been running for over 60 seconds`,
].join("\n");

/** The tree the injected walker returns: a test process holding a stuck pull. */
const STUCK_TREE: HangProcess[] = [
  { pid: 7001, ppid: 7000, etime: "01:15:02", args: "target/debug/deps/nessie-1a2b" },
  { pid: 7002, ppid: 7001, etime: "01:14:58", args: "git pull --ff-only origin main" },
  { pid: 7003, ppid: 7002, etime: "01:14:57", args: "git remote-https origin https://example/x" },
];

const walk = () => ({ processes: STUCK_TREE });

/** Rejection shaped like `execTree`'s timeout: killed + the leader it signalled. */
function killedError(cmd: string, hangStream: string | undefined): Error {
  const e = new Error(`Command failed: ${cmd}`) as Error & {
    stdout?: string;
    stderr?: string;
    killed?: boolean;
    treePid?: number;
  };
  e.stdout = "";
  e.stderr = hangStream ?? "";
  e.killed = true;
  e.treePid = 7000;
  return e;
}

async function makeRepo(name: string, withVerifyCmd: boolean) {
  const dir = path.join(root, name);
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  // The verify command is part of the BASE commit: `.pi/verify-cmd` written by
  // the cycle itself trips the protected-path fence (#406), which is a
  // different cap and would mask the timeout routing this case asserts.
  if (withVerifyCmd) {
    mkdirSync(path.join(repo, ".pi"), { recursive: true });
    writeFileSync(path.join(repo, ".pi/verify-cmd"), "sh -c 'exit 1'\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "add verify-cmd"]);
  }
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  return { dir, repo, baseSha };
}

// ── 1. The consolidated probe: killed run → report written + path threaded ──
async function caseConsolidated() {
  const f = await makeRepo("consolidated", false);
  const wt = path.join(f.dir, "wt-a");
  await git(f.repo, ["worktree", "add", "--detach", wt, f.baseSha]);
  writeFileSync(path.join(wt, "change-a.txt"), "new\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "change a"]);
  const scratch = path.join(f.dir, "scratch");

  let captured: string | undefined;
  const r = await runConsolidatedVerify(
    async (cmd, o) => {
      const c = commandOf(cmd, o);
      if (c.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", c)).stdout };
      throw killedError(c, HUNG_STREAM);
    },
    {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { a: wt },
      scratchDir: scratch,
      verifyCmd: "cargo test",
      timeoutMs: 30_000,
      onGateHangLogPath: (p) => {
        captured = p;
      },
      walkProcessTree: walk,
    },
  );
  assert(r.status === "failed", "consolidated: a killed run fails the gate");
  if (r.status === "failed") {
    assert(r.timedOut === true, "consolidated: and reports itself as killed, not as a verdict");
    assert(
      typeof r.hangLogPath === "string" && r.hangLogPath.includes("gate-hang-"),
      `consolidated: the result carries the report path (${r.hangLogPath ?? "none"})`,
    );
    assert(captured === r.hangLogPath, "consolidated: the caller's callback saw the same path");
    if (r.hangLogPath !== undefined) {
      const body = readFileSync(r.hangLogPath, "utf8");
      assert(body.startsWith(GATE_HANG_LABEL), "consolidated: the file is a hang report");
      assert(body.includes(STUCK_TEST), "consolidated: the file names the hung test");
      assert(
        body.includes("git remote-https"),
        "consolidated: the file names the process still holding the worktree",
      );
      assert(body.includes("cargo test"), "consolidated: the file names the gate's own command");
    }
  }
}

// ── 2. The develop gate: cap-hit event records the path, failure names the test ──
async function caseDevelopCap() {
  const f = await makeRepo("develop-cap", true);
  writeFileSync(path.join(f.repo, "change.txt"), "new\n");
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-q", "-m", "add change"]);

  const state = initialState(1427);
  state.pipelineState.worktrees = { default: f.repo };
  state.pipelineState.baseSha = f.baseSha;
  state.pipelineState.workstreams = {
    default: { id: "default", scope: "N=1 hang test", paths: ["change.txt"], outOfScope: [] },
  };

  const ctx: DriverContext = {
    host: {} as unknown as DriverContext["host"],
    repoRoot: f.repo,
    issue: 1427,
    dispatchFn: async () => ({
      ok: true,
      finalText: "done",
      errorStop: false,
      stopReason: "stop",
      durationMs: 100,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    verifyExecFn: async (cmd, o) => {
      const c = commandOf(cmd, o);
      if (c.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", c)).stdout };
      throw killedError(c, HUNG_STREAM);
    },
  };

  const result = await runDevelopTopological(
    ctx,
    state,
    ["default"],
    state.pipelineState.workstreams!,
    [1427],
    ctx.dispatchFn!,
    asShellForm(ctx.verifyExecFn!),
    Date.now(),
    "job-1427",
  );
  const capHit = [...result.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(capHit !== undefined, "develop: a killed gate caps the cycle");
  if (capHit?.kind === "cap-hit") {
    assert(
      capHit.cap === "verify-timeout:develop",
      `develop: the cap names a timeout, not a code failure (${capHit.cap})`,
    );
    assert(
      (capHit.logPaths ?? []).some((p) => p.includes("gate-hang-")),
      `develop: the cap event carries the report path structurally (${(capHit.logPaths ?? []).join(", ") || "none"})`,
    );
    assert(
      (capHit.evidence ?? "").includes(STUCK_TEST),
      "develop: the cap evidence itself names the hung test",
    );
    const explained = explainVerifyTimeout(capHit.cap, result);
    assert(
      explained.includes("What hung:"),
      "handoff: the explainer points at the hang report before anything else",
    );
    assert(
      explained.includes("gate-hang-"),
      "handoff: the explainer prints the path the operator opens",
    );
    // The pointer must come BEFORE the generic advice: an operator reads the
    // handoff top-down, and "what hung: <file>" arriving after "re-run the
    // cycle" is the same as not arriving.
    const hangAt = explained.indexOf("What hung:");
    const adviceAt = explained.indexOf("Give the gate more time");
    assert(
      hangAt > -1 && adviceAt > -1 && hangAt < adviceAt,
      "handoff: the hang pointer precedes the generic advice",
    );
  }
  const recorded = ctx.gateHangLogPaths ?? [];
  assert(recorded.length > 0, `develop: the context recorded the report (${recorded.length})`);
}

// ── 3. An ordinary failure writes no report ────────────────────────────────
// The report is a claim about processes a run was KILLED holding. A run that
// failed on its own reached a verdict and gets no such claim.
async function caseNoReportForPlainFailure() {
  const f = await makeRepo("plain-failure", false);
  const wt = path.join(f.dir, "wt-a");
  await git(f.repo, ["worktree", "add", "--detach", wt, f.baseSha]);
  writeFileSync(path.join(wt, "change-a.txt"), "new\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "change a"]);
  const scratch = path.join(f.dir, "scratch");
  let captured: string | undefined;
  const r = await runConsolidatedVerify(
    async (cmd, o) => {
      const c = commandOf(cmd, o);
      if (c.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", c)).stdout };
      const e = new Error(`Command failed: ${c}`) as Error & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      e.stdout = `FAILED: ${STUCK_TEST}\n  assertion failed\n`;
      e.stderr = "";
      e.killed = false;
      throw e;
    },
    {
      repoRoot: f.repo,
      baseSha: f.baseSha,
      worktrees: { a: wt },
      scratchDir: scratch,
      verifyCmd: "cargo test",
      timeoutMs: 30_000,
      onGateHangLogPath: (p) => {
        captured = p;
      },
      walkProcessTree: walk,
    },
  );
  assert(r.status === "failed", "ordinary failure: still a failure");
  if (r.status === "failed") {
    assert(r.timedOut === undefined, "ordinary failure: not reported as killed");
    assert(r.hangLogPath === undefined, "ordinary failure: writes no hang report");
  }
  assert(captured === undefined, "ordinary failure: no path handed to the caller");
}

async function main() {
  await caseConsolidated();
  await caseDevelopCap();
  await caseNoReportForPlainFailure();
  if (exit !== 0) console.error("\n gate hang wiring assertions failed");
  process.exit(exit);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
