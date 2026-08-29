#!/usr/bin/env bun
/**
 * #536 — ops-fallback branch step does NOT call provisionWorktree; emit a
 * machine-readable `worktree-provisioned` event with
 * `outcome: "ops-fallback-unprovisioned"` so the develop gate can give the
 * right depsHint (the ops path is the root cause for the #533 incident).
 *
 * The mechanized path DOES call provisionWorktree and records the outcome
 * ("hook-ran" / "hook-failed" / "symlink" / "none"), so the develop gate
 * can distinguish between a broken hook, a bare worktree, and a worktree
 * that was never provisioned at all.
 *
 * Two fixtures:
 *
 *  1. Mechanized path (clean): worktree-provisioned events appear with the
 *     real provision outcome — not ops-fallback-unprovisioned.
 *  2. Ops-fallback path (mechanized worktree-add threw): worktree-provisioned
 *     events appear with ops-fallback-unprovisioned for each worktree the
 *     ops reply named (and for the default repoRoot fallback when it carries
 *     no ## Worktrees block).
 *
 * Both fixtures use an injected exec — this test is offline.
 */

import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const REPO = "/repo";
const WT = path.join(REPO, ".worktrees", "issue-536-default");
// Disable resume state writes (they would try to mkdir '/repo/.pi/work-state/')
// and the PR preflight gh call (no real git remote in these fixtures).
process.env.PI_ENSEMBLE_RESUME = "0";
process.env.PI_ENSEMBLE_PR_PREFLIGHT = "0";

/**
 * Minimal recorder for the mechanized path. Every command returns empty
 * stdout so `provisionWorktree` sees a bare repo with no `node_modules`
 * (via === "none"). The important assertion is that a `worktree-provisioned`
 * event appears at all — the exact outcome depends on what the bare fixture
 * finds on disk.
 */
function mechanizedRecorder() {
  const execFn: ExecFn = async (cmd) => {
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "origin/main\n" };
    if (cmd.startsWith("git rev-parse --verify --quiet")) return { stdout: "deadbeef\n" };
    // Treat every other git command as success with empty output so
    // worktreeCreate / provisionWorktree complete without throwing.
    return { stdout: "" };
  };
  return execFn;
}

/**
 * Recorder for the ops-fallback path: `git worktree add` throws so the
 * mechanized setup falls through to the ops dispatch. The ops dispatch is
 * stubbed to return a reply that carries a `## Worktrees` block.
 */
function opsFallbackRecorder(opsReply: string) {
  const execFn: ExecFn = async (cmd, o) => {
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "origin/main\n" };
    if (cmd.startsWith("git rev-parse --verify --quiet")) return { stdout: "deadbeef\n" };
    if (cmd.startsWith("git worktree list")) return { stdout: "" };
    // Worktrees are "dirty" enough to be inspected as non-existent → the
    // pre-remove returns quickly and `git worktree add` is reached.
    if (o?.cwd?.includes(".worktrees/")) {
      // Any cmd inside a worktree path: pretend the worktree doesn't exist.
      if (cmd.startsWith("git rev-parse --verify")) throw new Error("not a repo");
    }
    // Mechanized path: `git worktree add` throws → falls back to ops.
    if (cmd.startsWith("git worktree add")) throw new Error("fatal: already exists");
    // Post-ops git commands (rev-parse HEAD, abbrev-ref).
    if (cmd.startsWith("git rev-parse")) return { stdout: "deadbeef\n" };
    if (cmd.startsWith("git rev-parse --abbrev-ref")) return { stdout: "feature/issue-536\n" };
    return { stdout: "" };
  };
  const noopDispatch = async (): Promise<DispatchResult> => ({
    role: "ops",
    ok: true,
    text: opsReply,
    toolUses: [],
    ms: 0,
    exitCode: 0,
  });
  return { execFn, noopDispatch };
}

function branchCtx(execFn: ExecFn, dispatchFn?: () => Promise<DispatchResult>): DriverContext {
  return {
    pi: {},
    issue: 536,
    issues: [536],
    restart: false,
    repoRoot: REPO,
    model: undefined,
    labelOverride: undefined,
    verifyExecFn: execFn,
    dispatchFn,
  } as unknown as DriverContext;
}

// ------------------------------------------------------------- fixture 1
// Mechanized path: worktree-provisioned event with a real outcome.
{
  const execFn = mechanizedRecorder();
  const out = await runBranch(branchCtx(execFn), initialState(536), 1000).catch((e) => {
    console.error("fixture 1 threw:", (e as Error).message);
    return undefined;
  });

  const provEvents = out?.eventLog.filter((e) => e.kind === "worktree-provisioned") ?? [];
  assert(
    provEvents.length === 1,
    "mechanized path: exactly one worktree-provisioned event (N=1 default workstream)",
  );
  const pev = provEvents[0];
  assert(
    pev?.kind === "worktree-provisioned" && pev.worktreeId === "default" && pev.worktreePath === WT,
    "the event names the correct workstream id and path",
  );
  const mechanizedOutcomes = ["hook-ran", "hook-failed", "symlink", "none"];
  assert(
    pev?.kind === "worktree-provisioned" && mechanizedOutcomes.includes(pev.outcome),
    "the mechanized path records a real provisioning outcome — NOT ops-fallback-unprovisioned",
  );
  assert(
    pev?.outcome !== "ops-fallback-unprovisioned",
    "canary: the mechanized event is never ops-fallback-unprovisioned",
  );
}

// ------------------------------------------------------------- fixture 2a
// Ops-fallback path with a ## Worktrees block in the reply.
{
  const worktreePath = path.join(REPO, ".worktrees", "issue-536-default");
  const opsReplyWithBlock = [
    "Branch feature/issue-536 created.",
    "",
    "## Worktrees",
    "",
    `- default: ${worktreePath}`,
  ].join("\n");

  const { execFn, noopDispatch } = opsFallbackRecorder(opsReplyWithBlock);
  const out = await runBranch(branchCtx(execFn, noopDispatch), initialState(536), 1000).catch(
    (e) => {
      console.error("fixture 2a threw:", (e as Error).message);
      return undefined;
    },
  );

  const provEvents2a = out?.eventLog.filter((e) => e.kind === "worktree-provisioned") ?? [];
  assert(
    provEvents2a.length >= 1,
    "ops-fallback (worktrees block): at least one worktree-provisioned event emitted",
  );
  assert(
    provEvents2a.every(
      (e) => e.kind === "worktree-provisioned" && e.outcome === "ops-fallback-unprovisioned",
    ),
    "all ops-fallback events carry outcome: ops-fallback-unprovisioned",
  );
  const pathEvent = provEvents2a.find(
    (e) => e.kind === "worktree-provisioned" && e.worktreePath === worktreePath,
  );
  assert(pathEvent !== undefined, "the event names the absolute path from the ## Worktrees block");
}

// ------------------------------------------------------------- fixture 2b
// Ops-fallback path with NO ## Worktrees block (fallback to repoRoot).
{
  const opsReplyNoBlock = "Branch feature/issue-536 created.";
  const { execFn, noopDispatch } = opsFallbackRecorder(opsReplyNoBlock);
  const out = await runBranch(branchCtx(execFn, noopDispatch), initialState(536), 1000).catch(
    (e) => {
      console.error("fixture 2b threw:", (e as Error).message);
      return undefined;
    },
  );

  const provEvents2b = out?.eventLog.filter((e) => e.kind === "worktree-provisioned") ?? [];
  assert(
    provEvents2b.length >= 1,
    "ops-fallback (no worktrees block): worktree-provisioned event emitted for the repoRoot fallback",
  );
  assert(
    provEvents2b.every(
      (e) => e.kind === "worktree-provisioned" && e.outcome === "ops-fallback-unprovisioned",
    ),
    "the repoRoot fallback entry is also marked ops-fallback-unprovisioned",
  );
  const rootEvent = provEvents2b.find(
    (e) => e.kind === "worktree-provisioned" && e.worktreePath === REPO,
  );
  assert(
    rootEvent !== undefined,
    "the event carries the repoRoot path when no ## Worktrees block was parsed",
  );
}

// ------------------------------------------------------------- fixture 3
// N=2 mechanized path: two worktree-provisioned events.
{
  const WT_A = path.join(REPO, ".worktrees", "issue-536-task-a");
  const WT_B = path.join(REPO, ".worktrees", "issue-536-task-b");
  const execFn = mechanizedRecorder();
  const state = {
    ...initialState(536),
    pipelineState: {
      ...initialState(536).pipelineState,
      workstreams: {
        "task-a": { id: "task-a", paths: [], spec: "" },
        "task-b": { id: "task-b", paths: [], spec: "" },
      },
    },
  };
  const out = await runBranch(branchCtx(execFn), state, 1000).catch((e) => {
    console.error("fixture 3 threw:", (e as Error).message);
    return undefined;
  });

  const provEvents3 = out?.eventLog.filter((e) => e.kind === "worktree-provisioned") ?? [];
  assert(
    provEvents3.length === 2,
    "N=2 mechanized path: two worktree-provisioned events (one per workstream)",
  );
  const ids3 = provEvents3
    .filter((e) => e.kind === "worktree-provisioned")
    .map((e) => (e.kind === "worktree-provisioned" ? e.worktreeId : ""))
    .sort();
  assert(ids3.join(",") === "task-a,task-b", "both workstream ids appear in the provision events");
  const paths3 = provEvents3
    .filter((e) => e.kind === "worktree-provisioned")
    .map((e) => (e.kind === "worktree-provisioned" ? e.worktreePath : ""));
  assert(
    paths3.includes(WT_A) && paths3.includes(WT_B),
    "the provision events carry the correct absolute paths for both workstreams",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
