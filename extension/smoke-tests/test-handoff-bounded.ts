#!/usr/bin/env bun
/**
 * S6 — writing a park comment must never cost 26 minutes.
 *
 * lantern's `.pi/work-state/626.json`: after two killed explore dispatches the
 * cycle reached handoff and logged
 * `dispatch-completed handoff ops:handoff ms=1547126` — 25.8 minutes to post a
 * comment whose body was already on disk. It COMPLETED, so neither the
 * inactivity watchdog (25 min of total silence) nor the runaway backstop (2 h)
 * bounded it; nothing did. Six healthy handoffs in this repo's own work-state
 * took 6.7 s - 17.8 s.
 *
 * The canary below is the timeout path: an ops dispatch that outlives the
 * bound must not hold the cycle hostage — the driver stops waiting and the
 * in-process `gh` fallback still produces a handoff record.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { handoffDispatchTimeoutMs, runHandoff } from "../src/work-driver-handoff.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fakePi = {
  sendUserMessage: () => undefined,
} as unknown as ExtensionAPI;

function mkResult(text: string): DispatchResult {
  return {
    role: "ops",
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-handoff-transcript.json",
  };
}

function cappedState() {
  const s = initialState(626, 1_000_000);
  return appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "step-failed:explore",
    reviewRound: 0,
    nextStep: "handoff",
  });
}

// The bound has to be tiny here or the test would take minutes; production
// reads the default. `ms` on the recorded event proves which one applied.
process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS = "200";

// 1. CANARY — a dispatch that outlives the bound still yields a handoff.
//
// Pre-fix, runHandoff simply awaits the dispatch, so this took the full 4 s
// the fake ops child sleeps (in production: 25.8 min) and the elapsed
// assertion failed.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-bound-"));
  try {
    const SLOW_MS = 4_000;
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: () =>
        new Promise<DispatchResult>((resolve) => {
          setTimeout(
            () =>
              resolve(
                mkResult("posted https://github.com/o/r/issues/626#issuecomment-999 and labelled"),
              ),
            SLOW_MS,
          ).unref();
        }),
    };
    const t0 = Date.now();
    const next = await runHandoff(ctx, cappedState(), Date.now());
    const elapsed = Date.now() - t0;

    assert(
      elapsed < SLOW_MS - 1_000,
      `slow ops dispatch does not hold the cycle: returned in ${elapsed}ms, dispatch sleeps ${SLOW_MS}ms`,
    );
    const failed = next.eventLog.find(
      (e) => e.kind === "dispatch-failed" && e.label === "ops:handoff",
    );
    assert(failed !== undefined, "exceeding the bound records a dispatch-failed for ops:handoff");
    assert(
      failed?.kind === "dispatch-failed" &&
        (failed.errorTail ?? "").includes("PI_ENSEMBLE_HANDOFF_TIMEOUT_MS"),
      "the recorded failure names the knob that bounded it",
    );
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted !== undefined,
      "handoff-emitted is still appended — the fallback wrote the record",
    );
    assert(
      emitted?.kind === "handoff-emitted" && emitted.handoffBodyPath.endsWith("handoff-comment.md"),
      "the handoff body file the operator can post by hand is named in the event",
    );
    assert(
      next.pipelineState.status === "aborted" || next.pipelineState.status === "handoff",
      "the cycle still reaches a terminal status",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. INVARIANT (must hold both before and after the fix) — a healthy ops
// handoff is NOT disturbed by the bound. Guards against a fix that simply
// stops dispatching, or a bound so eager the fallback becomes the normal path.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-fast-"));
  try {
    let dispatched = 0;
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async () => {
        dispatched += 1;
        return mkResult("commented https://github.com/o/r/issues/626#issuecomment-4242, label set");
      },
    };
    const next = await runHandoff(ctx, cappedState(), Date.now());
    assert(dispatched === 1, "invariant: the ops handoff dispatch still happens");
    const emitted = next.eventLog.find((e) => e.kind === "handoff-emitted");
    assert(
      emitted?.kind === "handoff-emitted" &&
        emitted.commentUrl === "https://github.com/o/r/issues/626#issuecomment-4242",
      "invariant: a fast ops reply's comment URL is still parsed and recorded",
    );
    assert(
      !next.eventLog.some((e) => e.kind === "dispatch-failed"),
      "invariant: a fast handoff records no bound failure",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3. The bound is env-overridable and defaults to minutes, not hours — the
// numbers that failed to bound #626 were 25 min and 2 h.
{
  assert(handoffDispatchTimeoutMs() === 200, "PI_ENSEMBLE_HANDOFF_TIMEOUT_MS is honoured");
  const saved = process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS;
  process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS = "";
  const dflt = handoffDispatchTimeoutMs();
  process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS = saved;
  assert(
    dflt >= 60_000 && dflt < 25 * 60_000,
    `default bound is minutes and below the inactivity watchdog (got ${dflt}ms)`,
  );
}

// 4. The handoff must NEVER throw: it runs when something has already gone
// wrong, and a throw here costs the operator the only explanation of the run.
{
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-throw-"));
  try {
    const ctx: DriverContext = {
      host: fakePi,
      repoRoot: dir,
      issue: 626,
      dispatchFn: async () => {
        throw new Error("ops dispatch exploded");
      },
    };
    let threw = false;
    let emitted = false;
    try {
      const next = await runHandoff(ctx, cappedState(), Date.now());
      emitted = next.eventLog.some((e) => e.kind === "handoff-emitted");
    } catch {
      threw = true;
    }
    assert(!threw, "a throwing ops dispatch does not propagate out of runHandoff");
    assert(emitted, "a throwing ops dispatch still leaves a handoff-emitted record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(exit === 0 ? "\nAll handoff-bound assertions passed." : "\nFAILURES above.");
process.exit(exit);
