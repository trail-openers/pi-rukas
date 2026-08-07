#!/usr/bin/env bun
/**
 * The `merged` step end-to-end, driven through `runWorkDriver` (issue #323).
 *
 * Split out of test-work-driver-merged-mechanized.ts, which holds the unit
 * tests for the same subsystem (deriveMergeMethod, executeAndVerifyMerge,
 * mechanizedMerge, restoreCheckout) and hit the 500-line cap (AGENTS.md §12).
 * These three cover the whole flow instead: mechanized merge + checkout
 * restoration, the LLM-ops fallback path, and crash-resume idempotency.
 *
 * Since #380 every one of them has to pass the merge gate, so each grants
 * authority the way `/work N --merge` does and answers `gh` green. The gate
 * itself — including the no-grant refusal — lives in test-merge-authority.ts
 * and test-work-driver-pr10-core.ts. No real Pi spawn; all calls are mocked.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "ops",
    ok: true,
    text: "",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  } as DispatchResult;
}

function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

function mkCtx(
  issue: number,
  exec: VerifyExecFn,
  opts: { dispatchFn?: DriverContext["dispatchFn"]; repoRoot: string },
): DriverContext {
  return {
    repoRoot: opts.repoRoot,
    issue,
    pi: mkPi(),
    verifyExecFn: exec,
    mergeGrant: true, // #380 — granted the way `/work N --merge` would
    issueBodyFetcherFn: async () => ({ stdout: `title:\ttest #${issue}\nstate:\tOPEN\n\nbody` }),
    ...(opts.dispatchFn ? { dispatchFn: opts.dispatchFn } : {}),
  } as DriverContext;
}

function mkState(issue: number, pr: number, branch: string): WorkState {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "merged",
      lastCompletedStep: "ci",
      branchName: branch,
      prNumber: pr,
    },
  } as WorkState;
}

/** #380 — answer the merge gate's evidence probe green. */
function mergeGateGreen(cmd: string): { stdout: string } | undefined {
  if (cmd.includes("mergeStateStatus"))
    return { stdout: '{"mergeStateStatus":"CLEAN","state":"OPEN"}' };
  if (cmd.includes("gh pr checks"))
    return { stdout: '[{"name":"ci","bucket":"pass","isRequired":true}]' };
  return undefined;
}

/** #380 — answer the merge gate's evidence probe green; the gate itself is covered by test-merge-authority.ts. */
function mergeGateGreen(cmd: string): { stdout: string } | undefined {
  if (cmd.includes("mergeStateStatus"))
    return { stdout: '{"mergeStateStatus":"CLEAN","state":"OPEN"}' };
  if (cmd.includes("gh pr checks"))
    return { stdout: '[{"name":"ci","bucket":"pass","isRequired":true}]' };
  return undefined;
}

function mkExecFull(calls: string[], branch: string, throwFirstView: boolean): VerifyExecFn {
  let vc = 0;
  return async (cmd: string) => {
    calls.push(cmd);
    const green = mergeGateGreen(cmd);
    if (green) return green;
    if (cmd.includes("gh pr view")) {
      vc++;
      if (throwFirstView && vc === 1)
        return Promise.reject(Object.assign(new Error("not merged"), { stderr: "not merged" }));
      return { stdout: "MERGED\n" };
    }
    if (cmd.includes("gh pr merge")) return { stdout: "Merged" };
    if (cmd.includes("gh repo view"))
      return {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    if (cmd.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
    if (cmd.includes("git rev-parse")) return { stdout: `${branch}\n` };
    return { stdout: "" };
  };
}

// T18. Full mechanized merge + restoration.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-full-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    await writeState(dir, mkState(960, 9601, "feature/issue-960"));
    const calls: string[] = [];
    await runWorkDriver(
      mkCtx(960, mkExecFull(calls, "feature/issue-960", true), {
        repoRoot: dir,
        dispatchFn: async () => mkResult({ role: "driver", text: "Mechanized merge succeeded." }),
      }),
    );
    const after = await readState(dir, 960);
    assert(after?.pipelineState.status === "merged", "T18: status='merged'");
    const ev = (after?.eventLog ?? []).find((e: any) => e.kind === "merged");
    assert(ev?.kind === "merged" && ev.prNumber === 9601, "T18: merged event has PR number");
    assert(ev?.mergeCommit === undefined, "T18: mergeCommit undefined for mechanized path");
    const hasRestoration =
      calls.some((c) => c.includes("git fetch origin --prune")) &&
      calls.some((c) => c.includes("git checkout")) &&
      calls.some((c) => c.includes("git pull --ff-only"));
    assert(hasRestoration, "T18: restoration (fetch+checkout+pull) executed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T19. Fallback dispatch carries mergeMethod into prompt.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-fallback-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    await writeState(dir, mkState(961, 9611, "feature/issue-961"));
    process.env.PI_ENSEMBLE_MECHANIZE_OPS = "0";
    let capturedPrompt = "";
    // The gate runs regardless of PI_ENSEMBLE_MECHANIZE_OPS.
    const exec: VerifyExecFn = async (cmd) => mergeGateGreen(cmd) ?? { stdout: "" };
    await runWorkDriver(
      mkCtx(961, exec, {
        repoRoot: dir,
        dispatchFn: async (_pi, spec, opts) => {
          if (opts?.label !== "ops:merge") throw new Error(`unexpected: ${opts?.label}`);
          capturedPrompt = spec.prompt;
          return mkResult({
            role: "ops",
            text: "PR merged.\nmerge-commit: def1234567\n",
          });
        },
      }),
    );
    process.env.PI_ENSEMBLE_MECHANIZE_OPS = undefined;
    assert(
      capturedPrompt.includes("--squash --delete-branch"),
      "T19: prompt carries squash as default hint when mechanized ops disabled",
    );
    assert(!/adjust the flags/i.test(capturedPrompt), "T19: no escape clause in prompt");
    const after = await readState(dir, 961);
    assert(after?.pipelineState.status === "merged", "T19: status='merged' after LLM ops fallback");
    const ev = (after?.eventLog ?? []).find((e: any) => e.kind === "merged");
    assert(
      ev?.kind === "merged" && ev.mergeCommit === "def1234567",
      "T19: mergeCommit captured from ops merge-commit marker",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// T20. Already-merged idempotent on resume.
{
  const dir = mkdtempSync(path.join(tmpdir(), "wd-idem-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    await writeState(dir, mkState(962, 9621, "feature/issue-962"));
    const calls: string[] = [];
    await runWorkDriver(
      mkCtx(962, mkExecFull(calls, "feature/issue-962", false), {
        repoRoot: dir,
        dispatchFn: async () => mkResult({ role: "driver", text: "Mechanized merge succeeded." }),
      }),
    );
    const after = await readState(dir, 962);
    assert(
      after?.pipelineState.status === "merged",
      "T20: idempotent status='merged' when PR already merged",
    );
    assert(
      !calls.some((c) => c.includes("gh pr merge")),
      "T20: gh pr merge NOT called (short-circuited)",
    );
    assert(
      calls.some((c) => c.includes("git fetch")),
      "T20: restoration runs even when merge short-circuits",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
