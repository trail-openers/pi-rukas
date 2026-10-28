#!/usr/bin/env bun
/**
 * #1863 hotfix (v0.14.30) — the exit grace starts at the KILL, and the kill is
 * observed through the one seam every supervisor already goes through.
 *
 * Field symptom: every subagent was SIGKILLed 15 s after it spawned. The grace
 * in `spawn-exit-await.ts` armed when the await was ENTERED, and `spawn.ts`
 * enters it for the child's whole life, so "wait 15 s more after the kill" read
 * as "die at 15 s".
 *
 * Two halves, two files. The TIMING half — an un-killed child is awaited with no
 * deadline at all, and a wedged one gets exactly the grace and no more — is
 * pinned in `test-work-driver-adversarial-exit-await.ts`. This file pins the
 * COVERAGE half: the predicate is set by `killProcessTree` itself
 * (`spawn-kill.ts`'s `installKillSeam`), so it cannot miss a supervisor the way
 * a list of kill flags would. Each case drives a kill through a DIFFERENT
 * supervisor's own code and asserts the spawn's observer saw it.
 *
 * What "killed" means for the timing, and why the cases below differ: the
 * escalation in `killProcessTree` SIGKILLs a group child at `KILL_GRACE_MS`
 * (2 s). A `node -e "setTimeout(…)"` child dies on that SIGKILL, so its wait is
 * won by the EXIT EVENT and can resolve before the 15 s grace is ever spent —
 * which is correct, and is what an escalation-reachable kill is supposed to do.
 * Only a child that survives the escalation (the TERM-trapping `sh` in the
 * sibling file) tests the grace expiring. So each case here asserts the two
 * things that ARE true for every path: the observer was notified, and the wait
 * ENDED within kill + grace + escalation margin rather than hanging.
 */

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { PiJsonEvent } from "../src/pi-event-shapes.ts";
import { createCapSession } from "../src/spawn-caps.ts";
import { armChildBound } from "../src/spawn-child-bound.ts";
import { awaitExitWithin } from "../src/spawn-exit-await.ts";
import { InFlightTools, createInactivityPoll } from "../src/spawn-inflight.ts";
import { installKillSeam } from "../src/spawn-kill.ts";
import { createKillObserver } from "../src/spawn-kill-observed.ts";
import { attachAbortKill, createWallClockBackstop } from "../src/spawn-supervision.ts";
import { declareKillFlags } from "../src/spawn-watchdog.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const spawned: Array<ReturnType<typeof spawn>> = [];
const tmpDirs: string[] = [];
/** Host value of `PI_ENSEMBLE_DISPATCH_CAPS`, captured before this file clears
 *  it and restored in `finally`. Declared here (not in `try`) so `finally` sees
 *  it even when a case throws before the capture line runs. */
let savedCaps: string | undefined;

function reap(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* gone */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* gone */
  }
}

/** A live child that ignores nothing and dies on the escalation's SIGKILL — the
 *  shape a real `pi --mode rpc` child has for most of its life. */
async function liveChild(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000_000)"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  spawned.push(child);
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  await new Promise((r) => setTimeout(r, 150));
  return child;
}

/** THE ENV, OWNED. Every case that mutates `process.env` goes through here so a
 *  failure in one case cannot hand a poisoned budget to the next one (the kill
 *  budgets are read from the environment on EVERY poll, so a leaked
 *  `PI_ENSEMBLE_*_TIMEOUT_MS` makes later cases kill early and their assertions
 *  mean something else entirely). */
function withEnv<T>(key: string, value: string | undefined, body: () => Promise<T>): Promise<T> {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return body().finally(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
}

/** Start the wait the way `spawn.ts` does: before anyone has killed the child. */
function awaitingExit(
  child: ReturnType<typeof spawn>,
  observer: ReturnType<typeof createKillObserver>,
) {
  return awaitExitWithin(child, {
    graceMs: GRACE_MS,
    pollMs: POLL_MS,
    killed: observer.killed,
    kill: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    },
  });
}

/** A long grace, so an un-killed child is still being awaited when the case
 *  checks. It is NOT the 15 s production grace (`EXIT_AWAIT_GRACE_MS`) — these
 *  cases want a wait that ends inside the test's lifetime, and the timing of the
 *  production grace is pinned by the sibling file. */
const GRACE_MS = 8_000;
const POLL_MS = 100;
/** The bound a resolved wait must beat: the grace, plus the group escalation's
 *  `KILL_GRACE_MS` (2 s, `spawn-kill.ts`) which the kill arms on its own, plus
 *  slack for scheduling. Anything past this is a wait that did not end. */
const CEILING_MS = GRACE_MS + 4_000;

/** The assertions every kill path shares: notified, and the wait ended on its own. */
async function expectResolved(
  label: string,
  observer: ReturnType<typeof createKillObserver>,
  promise: Promise<[number | null, NodeJS.Signals | null]>,
  t0: number,
): Promise<void> {
  const tuple = await promise;
  const elapsed = Date.now() - t0;
  assert(observer.killed() === true, `[${label}] the kill reached the observer via the seam`);
  assert(
    elapsed < CEILING_MS,
    `[${label}] the wait ENDED on its own after the kill (${elapsed}ms < ${CEILING_MS}ms) — not a hang`,
  );
  assert(
    Array.isArray(tuple) && tuple.length === 2,
    `[${label}] resolved a [code, signal] tuple (got ${JSON.stringify(tuple)})`,
  );
}

try {
  // THE ENV THIS FILE ASSUMES. `createCapSession` consults
  // `PI_ENSEMBLE_DISPATCH_CAPS`, and a host that has it set to `off` makes the
  // loop/token cases no-ops whose assertions would then pass on a child nothing
  // killed. Delete it for the whole run and restore it at the end, so the file
  // tests the caps rather than whatever the operator's shell happens to export.
  savedCaps = process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;

  // ── 1. THE WALL-CLOCK BACKSTOP (`spawn-supervision.ts` createWallClockBackstop).
  {
    const child = await liveChild();
    const observer = createKillObserver();
    installKillSeam(child, observer.notifyKill);
    assert(observer.killed() === false, "[backstop] nothing observed before the timer fires");
    const wait = awaitingExit(child, observer);
    const t0 = Date.now();
    const stop = createWallClockBackstop({ child, timeoutMs: 300, onTimeout: () => false });
    await expectResolved("backstop", observer, wait, t0);
    stop();
  }

  // ── 2. PI'S USER-CANCEL (`spawn-supervision.ts` attachAbortKill).
  {
    const child = await liveChild();
    const observer = createKillObserver();
    installKillSeam(child, observer.notifyKill);
    const flags = declareKillFlags();
    const controller = new AbortController();
    const wait = awaitingExit(child, observer);
    const detach = attachAbortKill(child, controller.signal, () => flags.setAborted(true));
    const t0 = Date.now();
    controller.abort();
    await expectResolved("abort", observer, wait, t0);
    detach();
    assert(
      flags.aborted() === true,
      "[abort] the arm still records its own cause (the hotfix did not move attribution)",
    );
  }

  // ── 3. THE PER-CHILD RUN BOUND (`spawn-child-bound.ts`), through its real kill.
  //
  // A committed, unreported child in its own git repo: `settled()` finds HEAD
  // unchanged, so the bound KILLS (rather than ending as done) — the branch
  // under test is `kill()`, and the done branch calls the same function.
  //
  // `childExited: () => false` is a STUB, not this child's liveness: the bound
  // must not talk itself out of killing a child that is in fact alive. Where a
  // case needs the real answer it reads the handle, not a constant — see the
  // liveness assertion below.
  {
    const dir = await mkdtemp(join(tmpdir(), "pi-1863-bound-"));
    tmpDirs.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "f.txt"), "x\n");
    execFileSync("git", ["add", "f.txt"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"], {
      cwd: dir,
    });

    const child = await liveChild();
    const observer = createKillObserver();
    installKillSeam(child, observer.notifyKill);
    const bound = armChildBound({
      child,
      boundMs: 200,
      cwd: dir,
      stdin: child.stdin as Writable,
      reported: () => false,
      childExited: () => false,
      preempted: () => false,
      commits: true,
      graceMs: 0,
    });
    const wait = awaitingExit(child, observer);
    const t0 = Date.now();
    await expectResolved("child-bound", observer, wait, t0);
    bound.stop();
    assert(
      bound.killed() === true,
      "[child-bound] the bound really killed this child (else the case is vacuous)",
    );
    // REAL LIVENESS, read off the handle rather than asserted from the stub: the
    // child is gone, so the wait that resolved did so about a child that died.
    assert(
      child.exitCode !== null || child.signalCode !== null,
      `[child-bound] the child really died (code=${child.exitCode} signal=${child.signalCode}) — liveness read from the handle, not from the case's stub`,
    );
  }

  // ── 4. THE LOOP CAP (`spawn-caps.ts` killChild), via the real session.
  {
    const child = await liveChild();
    const observer = createKillObserver();
    installKillSeam(child, observer.notifyKill);
    const flags = declareKillFlags();
    const caps = createCapSession({
      role: "developer",
      child,
      totalTokens: () => 0,
      timedOut: flags.timedOut,
      inactivityKilled: flags.inactivityKilled,
      toolInactivityKilled: flags.toolInactivityKilled,
      aborted: flags.aborted,
      capKillGraceMs: 0,
      childExited: flags.childExited,
    });
    const wait = awaitingExit(child, observer);
    const t0 = Date.now();
    const observe = caps.loopObserver;
    for (let turn = 0; turn < 12 && !caps.loopKilled(); turn++) {
      observe?.(
        [
          {
            type: "toolCall",
            id: `x${turn}`,
            name: "bash",
            arguments: '{"command":"git log --oneline"}',
          },
        ],
        turn,
      );
    }
    await expectResolved("loop cap", observer, wait, t0);
    caps.cleanup();
    assert(
      caps.loopKilled() === true,
      "[loop cap] the detector really killed this child (else the case is vacuous)",
    );
  }

  // ── 5. THE TOKEN-BUDGET CAP (`spawn-caps.ts` budgetKill), via the real tracker.
  {
    await withEnv("PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER", "100", async () => {
      const child = await liveChild();
      const observer = createKillObserver();
      installKillSeam(child, observer.notifyKill);
      const flags = declareKillFlags();
      const caps = createCapSession({
        role: "developer",
        child,
        onSteer: () => {},
        totalTokens: () => 100_000, // far over the 100-token budget armed above
        timedOut: flags.timedOut,
        inactivityKilled: flags.inactivityKilled,
        toolInactivityKilled: flags.toolInactivityKilled,
        aborted: flags.aborted,
        capKillGraceMs: 0,
        childExited: flags.childExited,
      });
      const wait = awaitingExit(child, observer);
      const t0 = Date.now();
      caps.tokenBudgetTracker?.check(Date.now());
      await expectResolved("token-budget", observer, wait, t0);
      caps.cleanup();
      assert(
        caps.tokenBudgetTracker?.killed === true,
        "[token-budget] the tracker really killed this child (else the case is vacuous)",
      );
    });
  }

  // ── 6. THE INACTIVITY ARMS (`spawn-inflight.ts` createInactivityPoll), both
  //    budgets, each reached through the poll's own kill.
  for (const arm of ["inactivity", "tool-inactivity"] as const) {
    const key =
      arm === "inactivity"
        ? "PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS"
        : "PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS";
    // Only the tool-inactivity arm touches the model-silence budget, and only to
    // shorten it: the poll's period is `min(active budgets)` and its tick
    // re-reads the env every time, so with a span open and the model-silence
    // budget left at its default the period would be the default and no kill
    // would happen inside this test's lifetime. The plain-inactivity arm leaves
    // it ALONE — clearing it here would hand the poll its 30-min default period
    // and hang the case.
    const extras: Array<[string, string | undefined]> =
      arm === "tool-inactivity"
        ? [["PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS", "600"]]
        : [];
    await withEnv(key, "300", async () => {
      for (const [k, v] of extras) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const child = await liveChild();
      const observer = createKillObserver();
      installKillSeam(child, observer.notifyKill);
      const flags = declareKillFlags();
      const inFlightTools = new InFlightTools();
      if (arm === "tool-inactivity") {
        // The public way to open a span is the event feed the spawn itself uses:
        // a `message_end` whose MESSAGE is the assistant turn with a toolCall
        // block (`spanEdges` reads `event.message`, not the event itself). Typed
        // literally — every field below is a declared member of `PiJsonEvent`,
        // `PiMessage` and `PiContentBlock`, so no cast stands between this
        // fixture and a rename of any of them.
        const toolCallEvent: PiJsonEvent = {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: "{}" }],
          },
        };
        inFlightTools.observe(toolCallEvent);
      }
      let cause = "";
      const stop = createInactivityPoll({
        child,
        inFlightTools,
        lastActivityAt: () => Date.now() - 5_000, // permanently silent
        onKill: (c, budgetMs) => {
          cause = c;
          if (c === "tool-inactivity") flags.setToolInactivityKilled(true);
          else flags.setInactivityKilled(true);
          assert(budgetMs === 300, `[${arm}] the poll read the budget this case armed (${budgetMs})`);
        },
      });
      const wait = awaitingExit(child, observer);
      const t0 = Date.now();
      await expectResolved(arm, observer, wait, t0);
      stop();
      assert(cause === arm, `[${arm}] the poll fired its OWN arm (got "${cause}")`);
      assert(
        inFlightTools.active === (arm === "tool-inactivity"),
        `[${arm}] the in-flight set still says what the case built (${arm === "tool-inactivity"})`,
      );
    });
  }

  // ── 7. NO kill, NO deadline: an un-killed child is awaited for its whole life
  //    and keeps its real exit code. (The 20 s version of this, which is what
  //    the field regression measured, is in the sibling file.)
  {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(7), 2_000)"], {
      stdio: "pipe",
    });
    spawned.push(child);
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    const observer = createKillObserver();
    installKillSeam(child, observer.notifyKill);
    const t0 = Date.now();
    // A grace far shorter than the child's life: armed on entry, this resolves at
    // 8 s — no, it resolves at the child's real exit, because nothing armed it.
    const [code] = await awaitExitWithin(child, {
      graceMs: 300,
      pollMs: 50,
      killed: observer.killed,
      kill: () => child.kill("SIGKILL"),
    });
    const elapsed = Date.now() - t0;
    assert(
      elapsed >= 1_900 && code === 7,
      `[no kill] awaited for its whole life and kept its exit code (${elapsed}ms, code ${code})`,
    );
    assert(
      observer.killed() === false,
      "[no kill] a child that exited by itself was never recorded as killed",
    );
  }

  console.log("OK: #1863 hotfix — the exit grace starts at the kill, on every kill path");
} finally {
  if (savedCaps === undefined) delete process.env.PI_ENSEMBLE_DISPATCH_CAPS;
  else process.env.PI_ENSEMBLE_DISPATCH_CAPS = savedCaps;
  for (const child of spawned) reap(child);
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
}

process.exit(exit);
