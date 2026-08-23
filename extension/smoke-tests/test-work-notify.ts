#!/usr/bin/env bun
/**
 * #388 — the notification hook, and the guarantee that it cannot hurt.
 *
 * Before this, nothing `/work` produced reached a human outside the Pi
 * session: `grep -rniE 'osascript|terminal-notifier|notify-send|webhook|
 * slack'` over `src/` returned nothing, and the GitHub comment + label fired
 * only on the `runHandoff` path — not on a queue halt, not on
 * `awaiting-human-merge`, not on a driver crash. Fire over eight issues, go
 * to lunch, come back to a queue that stopped after twenty minutes.
 *
 * A notification is an OBSERVER. The load-bearing tests here are not the ones
 * proving it fires — they are the ones proving that a broken hook (missing
 * binary, non-zero exit, one that hangs forever) leaves the queue outcome
 * completely unchanged. An observer that can break the thing it observes is
 * worse than no observer.
 */

import { spawn } from "node:child_process";
import {
  type Notification,
  formatNotification,
  notify,
  notifyCommand,
} from "../src/work-notify.ts";
import { runWorkQueue } from "../src/work-queue.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const withCmd = async <T>(cmd: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.PI_ENSEMBLE_NOTIFY_CMD;
  if (cmd === undefined) delete process.env.PI_ENSEMBLE_NOTIFY_CMD;
  else process.env.PI_ENSEMBLE_NOTIFY_CMD = cmd;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_NOTIFY_CMD;
    else process.env.PI_ENSEMBLE_NOTIFY_CMD = prev;
  }
};

// ------------------------------------------------------------ the message

{
  const n: Notification = {
    kind: "parked",
    issues: [287],
    reason: "cap intent-park:underspecified",
    action: "add acceptance criteria or a concrete description to #287",
  };
  const text = formatNotification(n);
  assert(/#287/.test(text), "the message names the issue");
  assert(
    /add acceptance criteria/.test(text),
    "and carries the ACTION — 'issue #287 parked' is not actionable, this is",
  );
  assert(
    text.split("\n").length === 2,
    "two lines: what happened, what to do (lock screens truncate)",
  );
}
{
  const merge = formatNotification({
    kind: "awaiting-merge",
    issues: [5],
    reason: "cap awaiting-human-merge",
    action: "review and merge #300 yourself",
  });
  assert(
    /waiting on you to merge/.test(merge) && !/parked|HALTED/.test(merge),
    "#380's merge hold reads as finished-and-waiting, not as a failure — the work IS done",
  );
}
{
  const halted = formatNotification({
    kind: "halted",
    issues: [1, 2, 3],
    reason: "provider spend cap reached",
    action: "top up the account, then re-run",
  });
  assert(/#1, #2, #3/.test(halted), "a multi-issue group names every issue");
  assert(/HALTED/.test(halted), "and a halt is visibly different from a park");
}

// --------------------------------------------------------- unset is inert

{
  await withCmd(undefined, async () => {
    assert(notifyCommand() === undefined, "with no PI_ENSEMBLE_NOTIFY_CMD there is no hook");
    let spawned = 0;
    const fake = ((..._a: unknown[]) => {
      spawned++;
      throw new Error("should never be reached");
    }) as unknown as typeof spawn;
    const r = await notify({ kind: "parked", issues: [1], reason: "r", action: "a" }, fake);
    assert(!r.sent && spawned === 0, "nothing is spawned at all — byte-identical to pre-#388");
  });
  await withCmd("   ", async () => {
    assert(notifyCommand() === undefined, "a whitespace-only command counts as unset");
  });
}

// ------------------------------------------------------------- it delivers

{
  await withCmd("cat > /dev/null", async () => {
    const r = await notify({ kind: "parked", issues: [1], reason: "r", action: "a" });
    assert(r.sent, "a hook that reads stdin and exits 0 is reported as sent");
  });
}
{
  // The message must reach the hook via stdin, not via the command string.
  const seen: string[] = [];
  await withCmd("cat", async () => {
    const fake = ((cmd: string, opts: { env?: Record<string, string> }) => {
      seen.push(cmd);
      const child = spawn("cat", { shell: true, stdio: ["pipe", "ignore", "ignore"], ...opts });
      return child;
    }) as unknown as typeof spawn;
    await notify(
      {
        kind: "parked",
        // Untrusted text: an issue title or a provider error could contain
        // this, and building a shell line out of it would be an injection seam
        // in the one component whose whole job is to be harmless.
        issues: [1],
        reason: '"; touch /tmp/pi-ensemble-notify-pwned; echo "',
        action: "a",
      },
      fake,
    );
    assert(
      seen[0] === "cat",
      "the command string is the operator's verbatim — untrusted text is NOT interpolated into it",
    );
  });
}

// ------------------------------------------ a broken hook cannot hurt

{
  await withCmd("exit 3", async () => {
    const r = await notify({ kind: "parked", issues: [1], reason: "r", action: "a" });
    assert(!r.sent && /exited 3/.test(r.reason ?? ""), "a non-zero exit is reported, not thrown");
  });
}
{
  await withCmd("this-binary-does-not-exist-9f3a", async () => {
    const r = await notify({ kind: "parked", issues: [1], reason: "r", action: "a" });
    assert(!r.sent, "a missing binary resolves cleanly instead of rejecting");
  });
}
{
  // The one that would hang a walk-away run forever.
  const started = Date.now();
  await withCmd("sleep 60", async () => {
    const r = await notify({ kind: "parked", issues: [1], reason: "r", action: "a" });
    assert(!r.sent && /within/.test(r.reason ?? ""), "a hook that never exits is timed out");
  });
  assert(
    Date.now() - started < 20_000,
    "...and the timeout is enforced in seconds, not minutes — the queue does not wait on it",
  );
}

// ------------------------------ the queue outcome is unchanged either way

{
  const mkParked = (issue: number): WorkState =>
    ({
      schemaVersion: 1,
      issue,
      pipelineState: { status: "handoff", currentStep: "develop", lastCompletedStep: "branch" },
      eventLog: [{ kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 3, nextStep: "handoff" }],
      // biome-ignore lint/suspicious/noExplicitAny: partial fixture, only queue-read fields matter
    }) as any;

  const groups = [
    { id: "g1", issues: [401], fanout: { mode: "sequential" as const } },
    { id: "g2", issues: [402], fanout: { mode: "sequential" as const } },
  ];
  const run = async () =>
    runWorkQueue({
      repoRoot: "/repo",
      groups,
      restart: false,
      runGroup: async () => {},
      readStateFn: async (_r, issue) => mkParked(issue),
    });

  const baseline = await withCmd(undefined, run);
  // Every failure mode at once: a command that does not exist AND would exit
  // non-zero if it did.
  const withBrokenHook = await withCmd("this-binary-does-not-exist-9f3a || exit 7", run);

  assert(
    JSON.stringify(baseline.entries) === JSON.stringify(withBrokenHook.entries),
    "a completely broken hook leaves the queue entries byte-identical",
  );
  assert(
    baseline.parked === 2 && withBrokenHook.parked === 2,
    "...both groups still park, and both still run — the observer changed nothing",
  );
}

{
  // A merged group asks nothing of the operator, so notifying on it is noise
  // — and noise is indistinguishable from no hook at all.
  let calls = 0;
  await withCmd("true", async () => {
    const fake = ((..._a: unknown[]) => {
      calls++;
      return spawn("true", { shell: true, stdio: ["pipe", "ignore", "ignore"] });
    }) as unknown as typeof spawn;
    await notify({ kind: "parked", issues: [1], reason: "r", action: "a" }, fake);
  });
  assert(calls === 1, "the hook runs once per notification, not once per event");

  const summary = await withCmd("true", async () =>
    runWorkQueue({
      repoRoot: "/repo",
      groups: [{ id: "g1", issues: [500], fanout: { mode: "sequential" } }],
      restart: false,
      runGroup: async () => {},
      readStateFn: async () =>
        ({
          schemaVersion: 1,
          issue: 500,
          pipelineState: { status: "merged", currentStep: "merged" },
          eventLog: [],
          // biome-ignore lint/suspicious/noExplicitAny: partial fixture
        }) as any,
    }),
  );
  assert(
    summary.merged === 1 && summary.parked === 0,
    "a clean merge produces no park to notify on",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
