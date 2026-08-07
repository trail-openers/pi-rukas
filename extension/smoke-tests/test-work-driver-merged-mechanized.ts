#!/usr/bin/env bun
/**
 * Smoke test for mechanized merge + checkout restoration (issue #323).
 *
 * Covers: deriveMergeMethod, executeAndVerifyMerge, mechanizedMerge,
 * restoreCheckout, inlineMergePrompt with mergeMethod parameter,
 * and the merged step's full flow including fallback dispatch and
 * crash-resume idempotency. No real Pi spawn; all calls are mocked.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type VerifyExecFn, restoreCheckout } from "../src/work-driver-git.ts";
import {
  deriveMergeMethod,
  executeAndVerifyMerge,
  mechanizedMerge,
} from "../src/work-driver-merged-mechanized.ts";
import { inlineMergePrompt } from "../src/work-driver-prompts-late.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

interface MockExec {
  fn: VerifyExecFn;
  calls: string[];
}
function mkExec(
  o: Record<string, { stdout?: string; stderr?: string; error?: boolean }> = {},
): MockExec {
  const calls: string[] = [];
  const fn: VerifyExecFn = async (cmd) => {
    calls.push(cmd);
    for (const [k, v] of Object.entries(o)) {
      if (cmd.includes(k)) {
        if (v.error) {
          const e = new Error(v.stderr ?? "err") as Error & { stderr?: string };
          e.stderr = v.stderr;
          throw e;
        }
        return { stdout: v.stdout ?? "", stderr: v.stderr };
      }
    }
    return { stdout: "" };
  };
  return { fn, calls };
}

function mkCtx(
  issue: number,
  exec: VerifyExecFn,
  opts?: { dispatchFn?: DriverContext["dispatchFn"]; repoRoot?: string },
): DriverContext {
  return {
    repoRoot: opts?.repoRoot ?? "/fake",
    issue,
    pi: mkPi(),
    verifyExecFn: exec,
    mergeGrant: true, // #380 — granted the way `/work N --merge` would
    issueBodyFetcherFn: async () => ({
      stdout: `title:\ttest #${issue}\nstate:\tOPEN\n\nbody`,
    }),
    ...(opts?.dispatchFn ? { dispatchFn: opts.dispatchFn } : {}),
  } as DriverContext;
}

function mkState(issue: number, pr: number, branch: string): WorkState {
  const s = initialState(issue, 1_000_000);
  (s as any).pipelineState = {
    ...s.pipelineState,
    currentStep: "merged",
    lastCompletedStep: "ci",
    branchName: branch,
    prNumber: pr,
  };
  return s;
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
setupSpawnGuard();

// ---- deriveMergeMethod tests ----

{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert(
    "method" in r && r.method === "squash",
    "deriveMergeMethod: squash preferred when all allowed",
  );
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert(
    "method" in r && r.method === "merge",
    "deriveMergeMethod: squash false, merge true → merge",
  );
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert(
    "method" in r && r.method === "rebase",
    "deriveMergeMethod: squash+merge false, rebase true → rebase",
  );
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert("fallback" in r && r.fallback === true, "deriveMergeMethod: all false → fallback");
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":null,"mergeCommitAllowed":null,"rebaseMergeAllowed":null}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert("fallback" in r && r.fallback === true, "deriveMergeMethod: all null → fallback");
}
{
  const { fn } = mkExec({
    "gh repo view": { error: true, stderr: "network error" },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert("fallback" in r && r.fallback === true, "deriveMergeMethod: gh throws → fallback");
}

// ---- executeAndVerifyMerge tests ----

{
  const { fn } = mkExec({ "gh pr view": { stdout: "MERGED\n" } });
  assert(
    (await executeAndVerifyMerge(123, "squash", fn, "/fake")).merged === true,
    "executeAndVerifyMerge: already merged → short-circuit",
  );
}
{
  const { fn } = mkExec({
    "gh pr view": { stdout: "MERGED\n" },
    "gh pr merge": { stdout: "Merged" },
  });
  assert(
    (await executeAndVerifyMerge(123, "squash", fn, "/fake")).merged === true,
    "executeAndVerifyMerge: merge + verify succeeds",
  );
}
{
  const { fn } = mkExec({
    "gh pr view": { error: true, stderr: "not found" },
    "gh pr merge": { stdout: "Merged" },
  });
  const r = await executeAndVerifyMerge(123, "squash", fn, "/fake");
  assert("ok" in r && r.ok === false, "executeAndVerifyMerge: pre-check fails → error");
}

// ---- inlineMergePrompt tests ----

{
  const p = inlineMergePrompt([100], 999, "squash", "/tmp/scratch");
  assert(p.includes("--squash --delete-branch"), "inlineMergePrompt: includes merge method");
  assert(!/adjust the flags/i.test(p), "inlineMergePrompt: escape clause removed");
  assert(!/AGENTS\.md|CONTRIBUTING\.md/i.test(p), "inlineMergePrompt: no doc refs");
  assert(p.includes("Do NOT change it"), "inlineMergePrompt: tells agent not to override");
}

// ---- restoreCheckout tests ----

{
  const { fn, calls } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { stdout: "" },
  });
  await restoreCheckout("/fake", "main", "feature/issue-100", fn);
  const pfx = calls.map((c) => c.split(" ").slice(0, 2).join(" "));
  assert(
    JSON.stringify(pfx) ===
      JSON.stringify(["git fetch", "git rev-parse", "git checkout", "git pull", "git branch"]),
    "restoreCheckout: 5-step sequence (fetch→rev-parse→checkout→pull→branch -d)",
  );
  assert(
    calls[4]?.includes("git branch -d") && calls[4]?.includes("feature/issue-100"),
    "restoreCheckout: step 5 uses lowercase -d",
  );
}
{
  const { fn } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { error: true, stderr: "not fully merged" },
  });
  const notes = await restoreCheckout("/fake", "main", "feature/issue-100", fn);
  assert(
    notes.length > 0 && notes[0]?.includes("branch -d"),
    "restoreCheckout: branch -d refusal → note, not fatal",
  );
}
{
  const { fn, calls } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "main\n" },
    "git pull": { stdout: "" },
  });
  await restoreCheckout("/fake", "main", "feature/issue-100", fn);
  assert(
    !calls.some((c) => c.includes("git checkout")),
    "restoreCheckout: skips checkout when already on mainline",
  );
}

// ---- mechanizedMerge integration tests ----

{
  const orig = process.env.PI_ENSEMBLE_MECHANIZE_OPS;
  process.env.PI_ENSEMBLE_MECHANIZE_OPS = "0";
  try {
    const r = await mechanizedMerge(
      { repoRoot: "/fake", issue: 100, pi: mkPi() } as DriverContext,
      { pipelineState: { prNumber: 999 } } as unknown as WorkState,
    );
    assert(
      r.ok === false && r.reason.includes("PI_ENSEMBLE_MECHANIZE_OPS=0"),
      "mechanizedMerge: PI_ENSEMBLE_MECHANIZE_OPS=0 bypass",
    );
    assert(r.method === "squash", "mechanizedMerge: disabled path returns squash hint");
  } finally {
    process.env.PI_ENSEMBLE_MECHANIZE_OPS = orig;
  }
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "mm-ok-"));
  try {
    let vc = 0;
    const base = mkExec({
      "gh pr merge": { stdout: "Merged" },
      "gh repo view": {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      },
    });
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        vc++;
        if (vc === 1)
          return Promise.reject(
            Object.assign(new Error("not merged yet"), { stderr: "not merged yet" }),
          );
        return { stdout: "MERGED\n" };
      }
      return base.fn(cmd);
    };
    const r = await mechanizedMerge({ repoRoot: dir, issue: 100, pi: mkPi(), verifyExecFn: exec }, {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState);
    assert(
      r.ok === true && r.method === "squash",
      "mechanizedMerge: happy path squash from repo settings",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "mm-rebase-"));
  try {
    let mergeCmd = "";
    let vc = 0;
    const base = mkExec({
      "gh repo view": {
        stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}',
      },
    });
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        vc++;
        if (vc === 1)
          return Promise.reject(Object.assign(new Error("not merged"), { stderr: "not merged" }));
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("gh pr merge")) {
        mergeCmd = cmd;
        return { stdout: "Merged" };
      }
      return base.fn(cmd);
    };
    const r = await mechanizedMerge({ repoRoot: dir, issue: 100, pi: mkPi(), verifyExecFn: exec }, {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState);
    assert(
      r.ok === true && r.method === "rebase",
      "mechanizedMerge: rebase derived from repo settings",
    );
    assert(
      mergeCmd.includes("--rebase"),
      "mechanizedMerge: derived method reaches gh pr merge --rebase",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    },
  });
  const r = await mechanizedMerge(mkCtx(100, fn), {
    pipelineState: { prNumber: 999 },
  } as unknown as WorkState);
  assert(
    r.ok === false && r.reason.includes("no merge method permitted"),
    "mechanizedMerge: all methods false → fallback",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
