#!/usr/bin/env bun
/**
 * #841 — consolidated-verify log persistence: two-stream classification,
 * run1/run2 raw logs, write-failure degradation.
 *
 * Cases 1–7: `runConsolidatedVerify` with a STUB `execFn` (git commands run
 * through real git; the verify command is controlled per-test). Cases 8–9:
 * `runDevelopTopological` (the cap-hit emit site) with stub dispatch + verify.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);
let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};
const listLogs = (d: string) => {
  try {
    return readdirSync(d).filter((n) => n.endsWith(".log"));
  } catch {
    return [];
  }
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const sh = (cwd: string, cmd: string) => execFileP("/bin/sh", ["-c", cmd], { cwd });

type StubExec = NonNullable<DriverContext["verifyExecFn"]>;

function makeStubExec(
  verify: () => { stdout: string; stderr: string; throw: boolean },
): StubExec {
  return async (cmd, o) => {
    if (cmd.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", cmd)).stdout };
    const r = verify();
    if (r.throw) {
      const e = new Error(`Command failed: ${cmd}`) as Error & { stdout?: string; stderr?: string };
      e.stdout = r.stdout;
      e.stderr = r.stderr;
      throw e;
    }
    return { stdout: r.stdout };
  };
}

// Shared git fixture: a repo with a base commit + a worktree with one change.
async function makeFixture(name: string) {
  const dir = path.join(root, name);
  const repo = path.join(dir, "repo");
  const scratch = path.join(dir, "scratch");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  return { repo, baseSha, dir, scratch };
}

async function addWorktree(f: { repo: string; baseSha: string; dir: string }, id: string) {
  const wt = path.join(f.dir, `wt-${id}`);
  await git(f.repo, ["worktree", "add", "--detach", wt, f.baseSha]);
  writeFileSync(path.join(wt, `change-${id}.txt`), "new\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", `add change ${id}`]);
  return wt;
}

const opts = (
  f: { repo: string; baseSha: string; dir: string; scratch: string },
  wt: Record<string, string>,
  extra?: { retry?: Parameters<typeof runConsolidatedVerify>[1]["retry"] },
) => ({
  repoRoot: f.repo,
  baseSha: f.baseSha,
  worktrees: wt,
  scratchDir: f.scratch,
  verifyCmd: "sh -c 'exit 1'",
  timeoutMs: 30_000,
  ...extra,
});

async function runCases1to7() {
  // Case 1: two-stream classification — stdout "✗ x" + stderr warning → detail has "✗ x"
  {
    const f = await makeFixture("case1");
    const wt = await addWorktree(f, "a");
    const stub = makeStubExec(() => ({
      stdout: "✗ x: assertion failed\nctx\n",
      stderr: "warning: bun\n",
      throw: true,
    }));
    const r = await runConsolidatedVerify(stub, opts(f, { a: wt }));
    assert(r.status === "failed", "case 1: status is failed");
    if (r.status === "failed")
      assert(r.detail.includes("✗ x"), `case 1: detail contains "✗ x" (stdout survives)`);
  }
  // Case 2: run1 log written, holds both streams, stdout before stderr
  {
    const f = await makeFixture("case2");
    const wt = await addWorktree(f, "a");
    const stub = makeStubExec(() => ({
      stdout: "FAILED: t.ts\n✗ assertion\n",
      stderr: "some warning\n",
      throw: true,
    }));
    const r = await runConsolidatedVerify(stub, opts(f, { a: wt }));
    assert(r.status === "failed", "case 2: status is failed");
    const run1 = listLogs(f.scratch).filter((n) => n.includes("-run1.log"));
    assert(run1.length === 1, `case 2: exactly one run1 log (got ${run1.length})`);
    if (run1.length === 1) {
      const c = readFileSync(path.join(f.scratch, run1[0]), "utf8");
      assert(
        c.includes("FAILED: t.ts") && c.includes("some warning"),
        "case 2: log holds both streams verbatim",
      );
      assert(
        c.indexOf("FAILED: t.ts") < c.indexOf("some warning"),
        "case 2: stdout before stderr in log",
      );
    }
    if (r.status === "failed")
      assert(
        r.logPath !== undefined && existsSync(r.logPath),
        `case 2: logPath exists (got: ${r.logPath})`,
      );
  }
  // Case 3: run2 log when flake re-run also fails; same timestamp prefix
  {
    const f = await makeFixture("case3");
    const wt = await addWorktree(f, "a");
    const stub = makeStubExec(() => ({ stdout: "✗ x\n", stderr: "w\n", throw: true }));
    const r = await runConsolidatedVerify(stub, opts(f, { a: wt }, {
      retry: { canRetry: true, onRecover: () => assert(false, "case 3: onRecover should not fire") },
    }));
    assert(r.status === "failed", "case 3: status is failed");
    if (r.status === "failed") {
      assert(r.retried === true, "case 3: retried is true");
      assert(r.recovered === false, "case 3: recovered is false");
    }
    const all = listLogs(f.scratch);
    const r1 = all.filter((n) => n.includes("-run1.log"));
    const r2 = all.filter((n) => n.includes("-run2.log"));
    assert(r1.length === 1, "case 3: run1 log exists");
    assert(r2.length === 1, "case 3: run2 log exists");
    if (r1.length === 1 && r2.length === 1) {
      const ts1 = r1[0].replace(/-run1\.log$/, "");
      const ts2 = r2[0].replace(/-run2\.log$/, "");
      assert(ts1 === ts2, "case 3: run1 and run2 share the same timestamp prefix");
    }
  }
  // Case 4: recovery — run1 fails, run2 passes → run1 log exists, logPath names it
  {
    const f = await makeFixture("case4");
    const wt = await addWorktree(f, "a");
    let n = 0;
    const stub = makeStubExec(() => {
      n++;
      return n === 1
        ? { stdout: "✗ transient\n", stderr: "w\n", throw: true }
        : { stdout: "ok\n", stderr: "", throw: false };
    });
    let rec = false;
    const r = await runConsolidatedVerify(stub, opts(f, { a: wt }, {
      retry: { canRetry: true, onRecover: () => { rec = true; } },
    }));
    assert(r.status === "passed", `case 4: status is passed (got: ${r.status})`);
    if (r.status === "passed") {
      assert(r.recovered === true, "case 4: recovered is true");
      const r1 = listLogs(f.scratch).filter((n) => n.includes("-run1.log"));
      assert(r1.length === 1, "case 4: run1 log exists after recovery");
      assert(
        r.logPath !== undefined && r1.length === 1 && r.logPath.endsWith(r1[0]),
        "case 4: logPath names the run1 log",
      );
    }
    assert(rec, "case 4: onRecover was called");
  }
  // Case 5: log write throws (scratch is a file) → outcome unchanged, "unavailable"
  {
    const f = await makeFixture("case5");
    const wt = await addWorktree(f, "a");
    writeFileSync(f.scratch, "not-a-dir\n"); // scratch is now a file
    const stub = makeStubExec(() => ({ stdout: "✗ x\n", stderr: "w\n", throw: true }));
    const r = await runConsolidatedVerify(stub, opts(f, { a: wt }));
    assert(r.status === "failed", `case 5: status is failed (got: ${r.status})`);
    if (r.status === "failed") {
      assert(r.logPath === undefined, "case 5: logPath is undefined on write failure");
      assert(r.detail.includes("unavailable"), "case 5: detail says log is unavailable");
    }
    rmSync(f.scratch, { force: true });
  }
  // Case 6: no log on a clean pass
  {
    const f = await makeFixture("case6");
    const wt = await addWorktree(f, "a");
    const stub = makeStubExec(() => ({ stdout: "ok\n", stderr: "", throw: false }));
    const r = await runConsolidatedVerify(stub, opts(f, { a: wt }));
    assert(r.status === "passed", "case 6: status is passed");
    assert(listLogs(f.scratch).length === 0, "case 6: no logs on clean pass");
  }
  // Case 7: log content is the raw combined stream; path under scratchDir
  {
    const f = await makeFixture("case7");
    const wt = await addWorktree(f, "a");
    const stub = makeStubExec(() => ({
      stdout: "l1\nFAILED: t.ts\n✗ fail\n",
      stderr: "warn\n",
      throw: true,
    }));
    const r = await runConsolidatedVerify(stub, opts(f, { a: wt }));
    if (r.status === "failed" && r.logPath && existsSync(r.logPath)) {
      const c = readFileSync(r.logPath, "utf8");
      assert(c.includes("l1"), "case 7: log has stdout line 1");
      assert(c.includes("FAILED: t.ts"), "case 7: log has FAILED marker");
      assert(c.includes("warn"), "case 7: log has stderr");
      assert(r.logPath.startsWith(f.scratch), "case 7: logPath under scratchDir");
    } else assert(false, "case 7: failed to locate run1 log");
  }
}

// Case 8: N=1 verify-failed:develop cap-hit emitted; log path in verifyEvidence.failures
async function runCase8() {
  const dir = path.join(root, "case8-n1");
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const pi = path.join(repo, ".pi");
  mkdirSync(pi, { recursive: true });
  writeFileSync(path.join(pi, "verify-cmd"), "sh -c 'exit 1'\n");
  writeFileSync(path.join(repo, "change.txt"), "new\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "add change"]);

  const state = initialState(841);
  state.pipelineState.worktrees = { default: repo };
  state.pipelineState.baseSha = baseSha;
  state.pipelineState.workstreams = {
    default: { id: "default", scope: "N=1 test", paths: ["change.txt"], outOfScope: [] },
  };

  const ctx: DriverContext = {
    pi: {} as unknown as DriverContext["pi"],
    repoRoot: repo,
    issue: 841,
    dispatchFn: async () => ({
      ok: true, finalText: "done", errorStop: false, stopReason: "stop",
      durationMs: 100, totalCost: 0, inputTokens: 0, outputTokens: 0,
    }),
    verifyExecFn: async (cmd, o) => {
      if (cmd.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", cmd)).stdout };
      const e = new Error(`Command failed`) as Error & { stdout?: string; stderr?: string };
      e.stdout = "✗ x: assertion failed\n";
      e.stderr = "";
      throw e;
    },
  };

  const result = await runDevelopTopological(
    ctx, state, ["default"], state.pipelineState.workstreams!, [841],
    ctx.dispatchFn!, ctx.verifyExecFn!, Date.now(), "job-841",
  );
  const capHit = [...result.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(capHit !== undefined, "case 8: cap-hit emitted");
  if (capHit?.kind === "cap-hit") {
    assert(capHit.cap === "verify-failed:develop", `case 8: cap is verify-failed:develop (got: ${capHit.cap})`);
    assert(
      capHit.evidence !== undefined && capHit.evidence.length > 0,
      "case 8: cap-hit evidence field is non-empty",
    );
  }
  const ve = result.pipelineState.verifyEvidence;
  assert(ve !== undefined && ve.failures.length > 0, "case 8: verifyEvidence.failures non-empty");
  assert(
    ve?.failures.some((f) => f.includes("Raw output:")) === true,
    "case 8: failures name the log path via 'Raw output:'",
  );
}

// Case 9: N>1 flake recovery — run1 log written, no verify-failed cap after recovery
async function runCase9() {
  const dir = path.join(root, "case9-n2");
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const pi = path.join(repo, ".pi");
  mkdirSync(pi, { recursive: true });
  writeFileSync(path.join(pi, "verify-cmd"), "sh -c 'exit 1'\n");
  const wts: Record<string, string> = {};
  for (const id of ["a", "b"]) wts[id] = await addWorktree({ repo, baseSha, dir, scratch: "" }, id);

  const state = initialState(841);
  state.pipelineState.worktrees = wts;
  state.pipelineState.baseSha = baseSha;
  state.pipelineState.workstreams = {
    a: { id: "a", scope: "a", paths: ["change-a.txt"], outOfScope: [] },
    b: { id: "b", scope: "b", paths: ["change-b.txt"], outOfScope: [] },
  };

  let vc = 0;
  const ctx: DriverContext = {
    pi: {} as unknown as DriverContext["pi"],
    repoRoot: repo,
    issue: 841,
    dispatchFn: async () => ({
      ok: true, finalText: "done", errorStop: false, stopReason: "stop",
      durationMs: 100, totalCost: 0, inputTokens: 0, outputTokens: 0,
    }),
    verifyExecFn: async (cmd, o) => {
      if (cmd.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", cmd)).stdout };
      vc++;
      if (vc === 3) {
        const e = new Error("fail") as Error & { stdout?: string; stderr?: string };
        e.stdout = "✗ transient\n";
        e.stderr = "warning\n";
        throw e;
      }
      return { stdout: "ok\n" };
    },
  };

  const result = await runDevelopTopological(
    ctx, state, ["a", "b"], state.pipelineState.workstreams!, [841],
    ctx.dispatchFn!, ctx.verifyExecFn!, Date.now(), "job-841",
  );
  const scratchDir = path.join(repo, "tmp", "issue-841");
  const r1 = listLogs(scratchDir).filter((n) => n.includes("-run1.log"));
  assert(r1.length === 1, `case 9: run1 log written during flake recovery (got ${r1.length})`);
  const capHit = [...result.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(
    capHit === undefined || (capHit.kind === "cap-hit" && capHit.cap !== "verify-failed:develop"),
    "case 9: no verify-failed:develop cap-hit after recovery",
  );
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-841-log-"));

async function main() {
  try {
    await runCases1to7();
    await runCase8();
    await runCase9();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main()
  .catch((e) => {
    console.error(`✗ crashed: ${(e as Error).message}`);
    exit = 1;
  })
  .finally(() => {
    console.log(`\nexit ${exit}`);
    process.exit(exit);
  });
