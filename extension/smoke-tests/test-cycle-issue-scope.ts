#!/usr/bin/env bun
/**
 * A /work cycle's PM is told which issues the cycle owns, and in a session
 * with no terminal it cannot start writing work for any other (#1361).
 *
 * The incident: `/work 112` ran headless. At the slow-run notice for the
 * driver's develop child the PM called it "the developer dispatch for #37",
 * dispatched ops to make a `task-37` worktree and branch in the cycle's
 * repository, then explore to map #37 — 12 minutes and ~1.1M tokens on an
 * issue the cycle was never given. No surface it read named the cycle's issue.
 *
 *   - the slow-run notice, dispatch_status, dispatch_peek and the
 *     dispatch_kill refusal name the live cycle's issues on a driver child
 *   - with no terminal (rpc / print / json), a writing role whose prompt or
 *     cwd names an issue outside the live set is refused, naming both sets
 *   - the cycle's own issues, read-only roles, the TUI, no live cycle, and
 *     numbers that are not issue references all pass
 *
 * No Pi process spawned, no network.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearJobsForTesting, jobStatusSnapshot, startJob } from "../src/async-jobs.ts";
import { snapshot as deckSnapshot } from "../src/dispatch-deck.ts";
import { renderPeek } from "../src/dispatch-peek.ts";
import { registerDispatchStatusTool } from "../src/dispatch-status.ts";
import { assertWithinCycleIssues, registerDispatchTools } from "../src/dispatch.ts";
import type { RunningState } from "../src/progress.ts";
import { clearSlowWatchesForTesting } from "../src/slow-notice.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import { claimCycle, resetRegistry } from "../src/work-driver-registry.ts";

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
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { mode: string },
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
const refusal = (spec: DispatchSpec, mode: "tui" | "rpc" | "print" | "json" | undefined) => {
  try {
    assertWithinCycleIssues(spec, mode);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
};

clearJobsForTesting();
clearSlowWatchesForTesting();
resetRegistry();
process.env.PI_ENSEMBLE_SLOW_NOTICE_TURNS = "2";
process.env.PI_ENSEMBLE_AUTO_STEER = "0";

// The ops prompt the PM actually sent (stream.jsonl:2209), cwd the repo root.
const incident: DispatchSpec = {
  role: "ops",
  cwd: "/home/ops/orchard/work/orchard",
  prompt:
    "Create a git worktree in /home/ops/orchard/work/orchard for issue #37 work.\n\nA previous attempt reported success but the directory does not exist.",
};

// ------------------------------------------------ 1. no live cycle: nothing to guard
assert(refusal(incident, "rpc") === "", "no live cycle → nothing is refused");

const claimed = claimCycle(112);
if (!claimed.ok) throw new Error("claim failed");

// ------------------------------------------------ 2. driver-child surfaces name the cycle's issue
{
  let progress: ((s: RunningState) => void) | undefined;
  const { jobId } = startJob(pi, {
    label: "developer[default]",
    role: "developer",
    ownerKind: "driver",
    work: (_signal, hooks) => {
      progress = hooks.onProgress;
      return new Promise<DispatchResult>(() => undefined);
    },
  });
  const status = (await tool("dispatch_status").execute("t", {})).content[0]?.text ?? "";
  assert(
    (status.split("\n").find((l) => l.includes(jobId)) ?? "").includes("(cycle #112)"),
    "dispatch_status names the cycle's issue on the driver's row",
  );
  assert(
    (
      renderPeek(deckSnapshot())
        .split("\n")
        .find((l) => l.includes(jobId)) ?? ""
    ).includes("(cycle #112)"),
    "dispatch_peek names it too",
  );
  const kill = (await tool("dispatch_kill").execute("t", { jobId })).content[0]?.text ?? "";
  assert(/owns #112 and no other issue/.test(kill), "the dispatch_kill refusal names it");
  notices.length = 0;
  progress?.({
    role: "developer",
    turns: 3,
    toolUses: 3,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 },
    totalTokens: 0,
    elapsedMs: 1000,
    lastToolName: "bash",
    done: false,
  });
  const slow = notices.find((n) => n.includes(jobId)) ?? "";
  assert(
    slow.startsWith("[ensemble:slow]") && /owns #112 and no other issue/.test(slow),
    `the slow-run notice names the cycle's issue (${slow.slice(0, 80)}…)`,
  );
  clearJobsForTesting();
  clearSlowWatchesForTesting();
}

// ------------------------------------------------ 3. the guard
{
  const msg = refusal(incident, "rpc");
  assert(
    /^Refused: this ops dispatch names #37/.test(msg),
    `the incident's ops dispatch is refused (${msg})`,
  );
  assert(
    msg.includes("owns #112 and no other issue"),
    "and the refusal says which issue the cycle owns",
  );
  assert(
    refusal(incident, "print") !== "" && refusal(incident, "json") !== "",
    "print and json too",
  );
  assert(
    refusal({ ...incident, prompt: "do it", cwd: "/repo/.worktrees/task-37" }, "rpc") !== "",
    "a cwd naming a task-37 worktree is refused",
  );
  assert(
    refusal({ role: "developer", prompt: "Run `gh issue view 37` and fix it." }, "rpc") !== "",
    "`gh issue view 37` counts as naming #37",
  );
  assert(
    refusal(incident, "tui") === "",
    "the TUI is let through — the operator may ask for other work",
  );
  assert(refusal(incident, undefined) === "", "no context (a non-tool caller) is let through");
  assert(
    refusal({ ...incident, role: "explore" }, "rpc") === "",
    "read-only roles may look anywhere",
  );
  assert(
    refusal({ ...incident, prompt: "Comment on the PR for issue #112.", cwd: "/repo" }, "rpc") ===
      "",
    "the cycle's own issue passes",
  );
  assert(
    refusal({ ...incident, prompt: "Task 1: rebase. Push PR #45 after step 2." }, "rpc") === "",
    "numbers that are not issue references pass",
  );

  const viaTool = await tool("dispatch_specialist")
    .execute("t", incident, undefined, undefined, { mode: "rpc" })
    .then(
      () => "",
      (err: Error) => err.message,
    );
  assert(/^Refused/.test(viaTool), "dispatch_specialist refuses it");
  const viaBatch = await tool("dispatch_parallel")
    .execute(
      "t",
      { specs: [{ role: "explore", prompt: "map issue #37", cwd: "/repo" }, incident] },
      undefined,
      undefined,
      { mode: "rpc" },
    )
    .then(
      () => "",
      (err: Error) => err.message,
    );
  assert(/^Refused/.test(viaBatch), "dispatch_parallel refuses a batch with one such member");
  assert(jobStatusSnapshot().length === 0, "a refused dispatch starts nothing");
}

// ------------------------------------------------ 4. the cycle ends
claimed.claim.release();
assert(refusal(incident, "rpc") === "", "once the cycle has ended nothing is refused");

clearJobsForTesting();
clearSlowWatchesForTesting();
resetRegistry();
process.exit(exit);
