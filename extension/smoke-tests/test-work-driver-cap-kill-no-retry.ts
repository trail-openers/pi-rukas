#!/usr/bin/env bun
/**
 * #543 F4(e) — no-retry-on-loop-kill, adversarial side. A loop /
 * token-budget cap-killed workstream is a CAP, not an infra failure: it
 * parks with the fixed-literal cap INSTEAD of `adversarial-infra-failure`,
 * is NOT re-dispatched, and does not spend the #486 per-workstream retry
 * budget (a cap kill is not transient).
 *
 * Split out of test-work-driver-adversarial-reentry.ts (AGENTS.md §12
 * file-size limit). Uses runAdversarial directly, like its sibling: a
 * first-pass cap-hit hands the cycle off to a human, so an in-process
 * driver re-entry would be refused by the entry gate.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult, ExtensionAPI } from "../src/types.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";

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

function makeFakePi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

// #297 — zero the inter-attempt backoff so the in-step retries don't sleep.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// #286 — the test trees carry no real git diffs; disable the empty-diff skip
// so the loop runs as intended (same setting as the other adversarial tests).
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

for (const [killCause, cap] of [
  ["loop", "loop-detected"],
  ["token-budget", "token-budget"],
] as const) {
  const dir = mkdtempSync(path.join(tmpdir(), `work-driver-543-${killCause}-`));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const s = initialState(543, 1_000_000);
    const tree: Record<string, string> = {};
    const streams: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    > = {};
    for (const w of ["task-a", "task-b"]) {
      tree[w] = `${dir}/.worktrees/${w}`;
      streams[w] = { id: w, scope: w, paths: [], outOfScope: [] };
    }
    // Budget already spent (as post-step persistence would leave it), so any
    // retry would park immediately — the point is a cap kill is NOT retried.
    s.pipelineState = {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: tree,
      workstreams: streams,
      branchName: "feature/issue-543",
      adversarialTransientRetries: { "task-a": 3 },
    };
    await writeState(dir, s);

    const failures: Record<string, number> = {};
    const ctx: DriverContext = {
      pi: makeFakePi(),
      repoRoot: dir,
      issue: 543,
      issueBodyFetcherFn: async () => ({ stdout: "mock" }),
      adversarialLoopFn: async (params) => {
        const id = params.workCwd?.split("/").pop() ?? "?";
        failures[id] = (failures[id] ?? 0) + 1;
        if (id === "task-a") {
          return mkResult({
            role: "adversarial-loop",
            ok: false,
            exitCode: 143,
            loopOutcome: "infra-failure",
            killCause,
            text: `Adversarial loop ${killCause} kill. No verdict was produced.`,
            roundsExecuted: 1,
            adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: true }],
          });
        }
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          exitCode: 0,
          loopOutcome: "approved",
          text: "Adversarial APPROVED after round 1.\n",
          adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
        });
      },
      dispatchFn: async () => {
        throw new Error("no dispatch in this instrument");
      },
    };

    const state = await readState(dir, 543)!;
    const after = await runAdversarial(ctx, state, Date.now());
    const caps = after.eventLog.filter((e) => e.kind === "cap-hit" && e.cap === cap);
    const infraCaps = after.eventLog.filter(
      (e) => e.kind === "cap-hit" && e.cap === "adversarial-infra-failure",
    );
    // The cap-killed workstream ran ONCE (no in-step retry) and parked with
    // the fixed-literal cap, NOT the infra cap.
    assert(
      failures["task-a"] === 1,
      `F4e (${killCause}): the cap-killed workstream was NOT re-dispatched (attempts: ${failures["task-a"]}, expected 1)`,
    );
    assert(
      caps.length === 1 && infraCaps.length === 0,
      `F4e (${killCause}): parked with cap='${cap}' INSTEAD of 'adversarial-infra-failure' (got cap-hits: ${JSON.stringify(after.eventLog.filter((e) => e.kind === "cap-hit").map((e) => (e.kind === "cap-hit" ? e.cap : "?")))})`,
    );
    // The budget was NOT spent (a cap kill is not transient).
    assert(
      (after.pipelineState.adversarialTransientRetries?.["task-a"] ?? 0) === 3,
      `F4e (${killCause}): the #486 retry budget was NOT spent on the cap kill (unchanged at 3)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
