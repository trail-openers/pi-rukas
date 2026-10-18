#!/usr/bin/env bun
/**
 * #1468 — the `--continue-pr` lookup runs at explore, before any dispatch.
 *
 * Each case drives runStep("explore") with a fake gh and a dispatchFn that
 * throws: 0 PRs, 2 PRs, a fork, a null headRepository, forge=gitlab and the
 * unsafe heads each cap with zero dispatches, no `pwned` file and no new
 * ref. PI_ENSEMBLE_PR_PREFLIGHT=0 does not switch the lookup off.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Forge } from "../src/forge-types.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { continuePrPreflight } from "../src/work-driver-continue-pr-lookup.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { runStep } from "../src/work-driver-run-step.ts";
import { execp } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

gitTestEnv();
process.env.PI_ENSEMBLE_FORGE = "github";
const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1468-lookup-"));
const repo = path.join(root, "repo");
await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);

const prRow = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  headRefName: `feature/issue-5-x${n}`,
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  isCrossRepository: false,
  headRepository: { name: "repo" },
  body: "Fixes #5",
  ...over,
});

function ctxFor(rows: unknown[], dispatched: string[], forge?: Forge): CycleContext {
  const verifyExecFn: VerifyExecFn = async (cmd, opts) => {
    if (cmd === "gh") return { stdout: JSON.stringify(rows) };
    return execp(cmd, opts);
  };
  return {
    repoRoot: repo,
    issue: 5,
    continuePr: true,
    verifyExecFn,
    ...(forge ? { forge } : {}),
    dispatchFn: async () => {
      dispatched.push("dispatch");
      throw new Error("the continue-pr lookup must cap before any dispatch");
    },
  } as unknown as CycleContext;
}

async function refs(): Promise<string> {
  return (await execFileP("git", ["for-each-ref"], { cwd: repo })).stdout;
}

async function capAtExplore(
  label: string,
  rows: unknown[],
  cap: string,
  forge?: Forge,
): Promise<WorkState | undefined> {
  const dispatched: string[] = [];
  const before = await refs();
  const out = await runStep(ctxFor(rows, dispatched, forge), initialState(5), "explore").catch(
    (err: Error) => {
      console.error(`  ${label}: ${err.message}`);
      return undefined;
    },
  );
  const hit = out?.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    hit?.kind === "cap-hit" && hit.cap === cap && hit.nextStep === "handoff",
    `${label}: explore caps ${cap}`,
  );
  assert(dispatched.length === 0, `${label}: zero dispatches`);
  assert((await refs()) === before, `${label}: no ref changed`);
  return out;
}

try {
  await capAtExplore("0 PRs", [prRow(9, { headRefName: "x", body: "" })], "continue-pr-not-found");
  const two = await capAtExplore(
    "2 PRs",
    [prRow(358), prRow(360, { headRefName: "y" })],
    "continue-pr-ambiguous",
  );
  const twoHit = two?.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    twoHit?.kind === "cap-hit" &&
      /#358/.test(twoHit.evidence ?? "") &&
      /#360/.test(twoHit.evidence ?? ""),
    "2 PRs: the evidence lists both numbers",
  );
  await capAtExplore("fork", [prRow(358, { isCrossRepository: true })], "continue-pr-fork");
  await capAtExplore(
    "null headRepository",
    [prRow(358, { headRepository: null })],
    "continue-pr-fork",
  );
  await capAtExplore("forge=gitlab", [prRow(358)], "continue-pr-not-found", {
    forge: "gitlab",
  } as unknown as Forge);

  const pwned = path.join(repo, "pwned");
  await capAtExplore(
    "head x$(touch pwned)",
    [prRow(358, { headRefName: "feature/issue-5-x$(touch pwned)" })],
    "continue-pr-unsafe-head",
  );
  await capAtExplore(
    "head with a backtick",
    [prRow(358, { headRefName: "feature/issue-5-`id`" })],
    "continue-pr-unsafe-head",
  );
  await capAtExplore(
    "head equal to main",
    [prRow(358, { headRefName: "main" })],
    "continue-pr-unsafe-head",
  );
  await capAtExplore(
    "base release",
    [prRow(358, { baseRefName: "release" })],
    "continue-pr-unsafe-head",
  );
  assert(!existsSync(pwned) && !existsSync(path.join(process.cwd(), "pwned")), "no pwned file");

  process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";
  await capAtExplore("PI_ENSEMBLE_PR_PREFLIGHT=0", [], "continue-pr-not-found");
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_PR_PREFLIGHT");

  {
    const dispatched: string[] = [];
    const out = await continuePrPreflight(ctxFor([prRow(358)], dispatched), initialState(5), 1000);
    assert(out === undefined, "one safe PR: the preflight passes and writes nothing");
  }
  {
    const dispatched: string[] = [];
    const ctx = { ...ctxFor([], dispatched), continuePr: false } as CycleContext;
    const out = await continuePrPreflight(ctx, initialState(5), 1000);
    assert(out === undefined, "without the flag the preflight does nothing");
  }
  {
    const dispatched: string[] = [];
    const state = initialState(5);
    const resumed: WorkState = {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        continuedPr: {
          number: 358,
          headRefName: "feature/issue-5-x358",
          headSha: "a".repeat(40),
          mainlineSha: "b".repeat(40),
          conflictPaths: [],
          matchedBy: "both",
        },
      },
    };
    const out = await continuePrPreflight(ctxFor([], dispatched), resumed, 1000);
    assert(out === undefined, "a cycle that already continues a PR is not looked up again");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
