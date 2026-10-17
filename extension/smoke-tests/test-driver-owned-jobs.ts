#!/usr/bin/env bun
/**
 * The PM can tell the /work driver's children from its own, and cannot
 * quietly destroy or double up on them.
 *
 * The incident: at a slow-run notice the PM took the driver's develop child
 * for a job it had mis-dispatched, sent it `dispatch_kill`, and dispatched
 * its own developer with `cwd` = the driver's worktree — two writers in one
 * tree for twenty minutes. No surface it read said whose job that was.
 *
 *   - dispatch_status / dispatch_peek rows and the slow-run notice name a
 *     driver-owned job as the driver's; PM jobs read exactly as before
 *   - dispatch_kill refuses a driver-owned job, leaves it running, and kills
 *     it only with `force: true`; the cycle's own job is refused regardless
 *   - killJob — the operator's agent-list `x` — is not gated at all
 *   - dispatch_specialist / dispatch_parallel refuse a writing role whose cwd
 *     is inside a LIVE cycle's worktree; read-only roles and finished cycles
 *     are let through
 *
 * No Pi process spawned, no network.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DRIVER_OWNED_NOTICE,
  clearJobsForTesting,
  jobStatusSnapshot,
  killJob,
  startJob,
} from "../src/async-jobs.ts";
import { snapshot as deckSnapshot } from "../src/dispatch-deck.ts";
import { renderPeek } from "../src/dispatch-peek.ts";
import { registerDispatchStatusTool } from "../src/dispatch-status.ts";
import { assertNotDriverWorktree, registerDispatchTools } from "../src/dispatch.ts";
import type { RunningState } from "../src/progress.ts";
import { clearSlowWatchesForTesting } from "../src/slow-notice.ts";
import type { DispatchResult } from "../src/types.ts";
import { claimCycle, liveCycleOwning, resetRegistry } from "../src/work-driver-registry.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface Tool {
  name: string;
  execute: (
    id: string,
    raw: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}
const tools: Tool[] = [];
const notices: string[] = [];
// biome-ignore lint/suspicious/noExplicitAny: testing seam — the minimum shape the tools need.
const pi: any = {
  registerTool: (t: Tool) => tools.push(t),
  sendUserMessage: (text: string) => notices.push(text),
};
registerDispatchStatusTool(pi as ExtensionAPI);
registerDispatchTools(pi as ExtensionAPI);
const tool = (name: string): Tool => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
};
const text = async (name: string, raw: unknown = {}) =>
  (await tool(name).execute("t", raw)).content[0]?.text ?? "";

/** A job that stays in flight and records whether its abort fired. */
function hangingJob(input: { label: string; role: string; driver?: boolean; skipDeck?: boolean }) {
  const seen: { signal?: AbortSignal; progress?: (s: RunningState) => void } = {};
  const { jobId } = startJob(pi, {
    label: input.label,
    role: input.role,
    ...(input.skipDeck ? { skipDeck: true } : {}),
    ...(input.driver ? { ownerKind: "driver" as const } : {}),
    work: (signal, hooks) => {
      seen.signal = signal;
      seen.progress = hooks.onProgress;
      return new Promise<DispatchResult>(() => undefined);
    },
  });
  return { jobId, seen };
}

function stateAt(turns: number): RunningState {
  return {
    role: "developer",
    turns,
    toolUses: turns,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns },
    totalTokens: 0,
    elapsedMs: 1000,
    lastToolName: "bash",
    done: false,
  };
}

clearJobsForTesting();
clearSlowWatchesForTesting();
resetRegistry();
process.env.PI_ENSEMBLE_SLOW_NOTICE_TURNS = "2";
process.env.PI_ENSEMBLE_AUTO_STEER = "0";

// ------------------------------------------------ 1. status + peek say whose
const mine = hangingJob({ label: "developer", role: "developer" });
const theirs = hangingJob({ label: "developer[default]", role: "developer", driver: true });
{
  const lines = (await text("dispatch_status")).split("\n");
  const mineLine = lines.find((l) => l.includes(mine.jobId)) ?? "";
  const theirLine = lines.find((l) => l.includes(theirs.jobId)) ?? "";
  assert(
    /owned by the \/work driver/.test(theirLine),
    `status names the driver's job (${theirLine})`,
  );
  assert(!/driver/.test(mineLine), `status leaves the PM's own job unmarked (${mineLine})`);
  const rows = jobStatusSnapshot();
  assert(
    rows.find((r) => r.jobId === theirs.jobId)?.driverOwned === true &&
      rows.find((r) => r.jobId === mine.jobId)?.driverOwned === undefined,
    "snapshot rows carry driverOwned only for the driver's job",
  );
  const peek = renderPeek(deckSnapshot()).split("\n");
  assert(
    /owned by the \/work driver/.test(peek.find((l) => l.includes(theirs.jobId)) ?? ""),
    "peek names the driver's job",
  );
  assert(
    !/driver/.test(peek.find((l) => l.includes(mine.jobId)) ?? "driver"),
    "peek leaves the PM's own job unmarked",
  );
}

// ------------------------------------------------ 2. the slow-run notice
{
  notices.length = 0;
  theirs.seen.progress?.(stateAt(3));
  mine.seen.progress?.(stateAt(3));
  const theirNotice = notices.find((n) => n.includes(theirs.jobId)) ?? "";
  const mineNotice = notices.find((n) => n.includes(mine.jobId)) ?? "";
  assert(theirNotice.startsWith("[ensemble:slow]"), "the driver's child still notifies the PM");
  assert(theirNotice.includes(DRIVER_OWNED_NOTICE), "its notice says it is the driver's child");
  assert(/dispatch_kill \S+ with force: true/.test(theirNotice), "and names the forced kill");
  assert(
    mineNotice.startsWith("[ensemble:slow]") && !mineNotice.includes("driver"),
    "a PM job's notice is unchanged",
  );
}

// ------------------------------------------------ 3. dispatch_kill
{
  const refused = await tool("dispatch_kill").execute("t", { jobId: theirs.jobId });
  assert(/^Refused/.test(refused.content[0]?.text ?? ""), "kill of the driver's job is refused");
  assert(
    (refused.content[0]?.text ?? "").includes(DRIVER_OWNED_NOTICE),
    "the refusal says whose job it is",
  );
  assert(refused.details.killed === false, "details.killed is false on a refusal");
  assert(theirs.seen.signal?.aborted === false, "the refused job was NOT aborted");

  const forced = await text("dispatch_kill", { jobId: theirs.jobId, force: true });
  assert(theirs.seen.signal?.aborted === true, "force: true kills the driver's (hung) child");
  assert(
    /driver's child/.test(forced) && /Do NOT dispatch a replacement/.test(forced),
    `the forced kill still says whose it was (${forced})`,
  );

  const own = await text("dispatch_kill", { jobId: mine.jobId });
  assert(mine.seen.signal?.aborted === true, "a PM job is killed without force");
  assert(own.startsWith("Sent SIGTERM to job"), "and reports as before");

  const cycle = hangingJob({
    label: "work-driver",
    role: "work-driver",
    driver: true,
    skipDeck: true,
  });
  const cycleKill = await text("dispatch_kill", { jobId: cycle.jobId, force: true });
  assert(
    /^Refused/.test(cycleKill) && cycle.seen.signal?.aborted === false,
    "the cycle's own job is refused even with force — the abort would not stop it",
  );

  const op = hangingJob({ label: "developer[default]", role: "developer", driver: true });
  assert(
    killJob(op.jobId) === true && op.seen.signal?.aborted === true,
    "killJob (the operator's agent-list path) is not gated",
  );
}

// ------------------------------------------------ 4. the driver's worktree
{
  clearJobsForTesting();
  const wt = "/repo/.worktrees/issue-56-default";
  assert(liveCycleOwning(wt) === undefined, "no live cycle → no owner");
  const claimed = claimCycle(56, [56, 57]);
  if (!claimed.ok) throw new Error("claim failed");
  assert(liveCycleOwning(wt) === 56, "a live cycle owns its worktree");
  assert(liveCycleOwning(`${wt}/extension/src`) === 56, "and every directory inside it");
  assert(liveCycleOwning("/repo/.worktrees/issue-560-default") === undefined, "#560 is not #56");
  assert(liveCycleOwning("/repo") === undefined, "the repo root is not a cycle worktree");

  const throws = (fn: () => void) => {
    try {
      fn();
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  };
  const dev = { role: "developer", prompt: "x", cwd: wt };
  assert(
    /^Refused.*cycle for #56/.test(throws(() => assertNotDriverWorktree(dev))),
    "developer refused",
  );
  assert(throws(() => assertNotDriverWorktree({ ...dev, role: "ops" })) !== "", "ops refused");
  assert(
    throws(() => assertNotDriverWorktree({ ...dev, role: "explore" })) === "",
    "explore (read-only) may look inside",
  );
  assert(
    throws(() => assertNotDriverWorktree({ ...dev, cwd: "/repo" })) === "",
    "repo root allowed",
  );

  const viaTool = await tool("dispatch_specialist")
    .execute("t", dev)
    .then(
      () => "",
      (err: Error) => err.message,
    );
  assert(/^Refused/.test(viaTool), "dispatch_specialist refuses the driver's worktree");
  const viaBatch = await tool("dispatch_parallel")
    .execute("t", { specs: [{ role: "explore", prompt: "x", cwd: "/repo" }, dev] })
    .then(
      () => "",
      (err: Error) => err.message,
    );
  assert(/^Refused/.test(viaBatch), "dispatch_parallel refuses a batch with one such member");
  assert(jobStatusSnapshot().length === 0, "a refused dispatch starts nothing");

  claimed.claim.release();
  assert(
    throws(() => assertNotDriverWorktree(dev)) === "",
    "once the cycle has ended its kept worktree is dispatchable again",
  );
}

clearJobsForTesting();
clearSlowWatchesForTesting();
resetRegistry();
console.log(exit === 0 ? "\nALL PASS" : "\nexit 1");
process.exit(exit);
