#!/usr/bin/env bun
/**
 * The develop gate writes its `verify-started` and then prints nothing until the
 * command returns, so a host whose stall rule watches the runner's progress
 * stream stops a healthy cycle in the middle of a long gate. The gate now beats
 * while it waits: `verify-heartbeat` rides `persistCycle` at a fixed interval and
 * `verify-completed` closes the run, so the stream carries the gate's whole span.
 *
 * The pump is tested as a pump — `startVerifyHeartbeat` with every dependency
 * injected and the registered callback fired by hand, so the beat count is the
 * pump's output and not a race. The gate is tested once, through
 * `verifyStepOutcome`, with a command that returns immediately: the beat must be
 * armed with the caller's step and stopped in the `finally` on both the normal
 * and the throwing path, and the switch at `0` must leave the stream exactly as
 * it was written before the beat existed. The host's own line stream is
 * `test-verify-heartbeat-stream.ts`; the real-wiring cases run through
 * `lib/verify-heartbeat-arm.ts`.
 *
 * Run: bun smoke-tests/test-verify-heartbeat.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isStableKind, NDJSON_VERSION, formatLine } from "../src/headless/ndjson.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import {
  armVerifyHeartbeat,
  beginVerifyRun,
  finishVerifyRun,
  startVerifyHeartbeat,
  VERIFY_HEARTBEAT_DEFAULT_MS,
} from "../src/work-driver-verify-events.ts";
import { appendEvent, initialState, type WorkState } from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import {
  ctxFor,
  installVerifyCmd,
  makeExec,
  stateFor,
} from "./lib/consolidated-verify-exec.ts";
import { fixture } from "./lib/consolidated-verify-fixture.ts";
import { armOnce, countTimerArms, withUnrefProbe } from "./lib/verify-heartbeat-arm.ts";
import { runGate } from "./lib/verify-heartbeat-gate.ts";

// The frontend-only classification and the consolidated-skip would let the gate
// pass without ever running the project's command; with both off, every case
// below really starts a run.
process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";
process.env.PI_ENSEMBLE_CONSOLIDATED_VERIFY_SKIP = "0";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const T0 = 1_700_000_000_000;
const INTERVAL = 300_000;
/** A fixed `Date.now` for the wiring case, so a beat's stamp is predictable. */
const STAMP = T0 + 125_000;

type Heartbeat = Extract<WorkEvent, { kind: "verify-heartbeat" }>;

const baseState = (): WorkState => initialState(2625, T0);
const startedEvent = (): Extract<WorkEvent, { kind: "verify-started" }> => ({
  kind: "verify-started",
  at: T0,
  step: "develop",
  command: "bash scripts/verify.sh",
  target: { kind: "consolidated" },
});

/** The pump with a fake scheduler: `tick()` fires the one registered callback. */
function pump(opts: {
  intervalMs?: number | undefined;
  ticks?: number;
  now?: () => number;
  persist?: (s: WorkState) => Promise<unknown>;
  aborted?: () => boolean;
  /** ms the fake clock advances per tick; 0 leaves it where `now` puts it. */
  stepMs?: number;
} = {}) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const persisted: WorkState[] = [];
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));
  // One fake clock drives both halves: `now` stamps the beat and `tick` moves
  // the instant, exactly as the real timer and `Date.now` do together in
  // production. Distinct `at`s are load-bearing: the emit watermark fingerprints
  // on `index|kind|at`, so colliding beats would be one line, not N.
  let t = T0;
  const stepMs = opts.stepMs === undefined ? INTERVAL : opts.stepMs;
  const stop = startVerifyHeartbeat({
    intervalMs: opts.intervalMs === undefined ? INTERVAL : opts.intervalMs,
    now: opts.now ?? (() => t),
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
    // A beat's failure never reaches the caller: the pump swallows it, so the
    // only way to see whether it was handled rather than dropped is the trace it
    // writes. `PI_ENSEMBLE_DEBUG=1` puts those on stderr, captured here.
    clearInterval: (cancel) => cancel?.(),
    persist:
      opts.persist ??
      (async (s) => {
        persisted.push(s);
      }),
    state: baseState(),
    step: "develop",
    command: startedEvent().command,
    startedAt: T0,
    ...(opts.aborted ? { aborted: opts.aborted } : {}),
  });
  return {
    stop,
    persisted,
    timers,
    /** Advance the fake clock one interval, then fire every uncancelled timer. */
    async tick(n = 1) {
      for (let i = 0; i < n; i++) {
        t += stepMs;
        // Every registered callback is fired, the cancelled ones included: a
        // pump that stopped guarding its own beat must be caught here, and a
        // fake scheduler that hid cancelled callbacks would hide that defect.
        // The return is awaited: a beat whose persist rejected must settle before
        // the next tick, so two beats are never mid-write over the same log.
        for (const timer of timers) await timer.fn();
        await settle();
      }
    },
    armed: () => timers.filter((x) => !x.cleared).length,
  };
}

const beatsOf = (states: WorkState[]): Heartbeat[] =>
  states.flatMap((s) => s.eventLog.filter((e): e is Heartbeat => e.kind === "verify-heartbeat"));

// ─────────────────────────────── the pump, driven by hand ─────────────────────

{
  const p = await pump();
  await p.tick(3);
  const beats = beatsOf(p.persisted);
  assert(p.timers.length === 1, "pump: one interval arms exactly one timer");
  assert(p.timers[0]?.ms === INTERVAL, `pump: the timer is armed at the interval (got ${p.timers[0]?.ms})`);
  assert(beats.length === 3, `pump: N ticks give N beats (got ${beats.length})`);
  assert(
    beats.every((b) => b.kind === "verify-heartbeat" && b.step === "develop" && b.command === "bash scripts/verify.sh"),
    "pump: every beat carries the step and the command of the run it accompanies",
  );
  const ats = beats.map((b) => b.at);
  assert(new Set(ats).size === ats.length, `pump: beats have distinct \`at\`s (${JSON.stringify(ats)})`);
  assert(
    beats.every((b) => Number.isInteger(b.elapsedSeconds) && b.elapsedSeconds >= 0),
    `pump: elapsedSeconds is a non-negative integer (${JSON.stringify(beats.map((b) => b.elapsedSeconds))})`,
  );
  p.stop();
  await p.tick(2);
  assert(beatsOf(p.persisted).length === 3, "pump: nothing persists after stop()");
  assert(p.armed() === 0, "pump: stop() clears the timer rather than leaving it running");
  await p.tick(1);
  assert(beatsOf(p.persisted).length === 3, "pump: stop() is idempotent and stays stopped");
}

{
  // A non-minute-aligned interval and clock of the test's own: the floor is
  // visible, and a beat that rounded or reported a float fails here rather than
  // in a host's stall rule. `stepMs: 0` because this case's `now` moves the
  // clock itself — each beat is stamped one 90.5s further on.
  let t = T0;
  const p = await pump({ now: () => (t += 90_500), stepMs: 0 });
  await p.tick(3);
  const beats = beatsOf(p.persisted);
  assert(
    JSON.stringify(beats.map((b) => b.elapsedSeconds)) === JSON.stringify([90, 181, 271]),
    `pump: elapsedSeconds is the floor of ms/1000 off the run's origin (${JSON.stringify(beats.map((b) => b.elapsedSeconds))})`,
  );
  p.stop();
}

{
  // A clock that stepped backwards past the run's origin (an NTP correction, or
  // a beat stamped by `Date.now` while `startedAt` was taken before an
  // adjustment): the docs promise a host a NON-NEGATIVE integer, because this
  // is the number a stall rule reads. Without the clamp the line renders
  // `verify-heartbeat · develop · -5s`.
  const p = await pump({ now: () => T0 - 5_000, stepMs: 0 });
  await p.tick(2);
  const beats = beatsOf(p.persisted);
  assert(
    beats.length === 2 &&
      beats.every((b) => b.elapsedSeconds === 0 && Number.isInteger(b.elapsedSeconds)),
    `pump: a clock behind the run's origin clamps elapsedSeconds to 0, never negative (${JSON.stringify(beats.map((b) => b.elapsedSeconds))})`,
  );
  p.stop();
}

{
  const p = await pump({ intervalMs: 0 });
  await p.tick(3);
  assert(p.timers.length === 0, "pump: intervalMs 0 arms no timer at all");
  assert(p.persisted.length === 0, "pump: intervalMs 0 persists nothing, so the stream is byte-identical");
  p.stop();
}

{
  const p = await pump({ intervalMs: undefined });
  await p.tick(1);
  assert(
    p.timers.length === 1 && p.timers[0]?.ms === VERIFY_HEARTBEAT_DEFAULT_MS,
    `pump: an unresolved interval falls back to the shipped default, not to off (got ${JSON.stringify(p.timers.map((t) => t.ms))})`,
  );
  p.stop();
}

{
  let aborted = false;
  const p = await pump({ aborted: () => aborted });
  await p.tick(1);
  assert(p.persisted.length === 1, "pump: beats while the cycle is running");
  aborted = true;
  await p.tick(2);
  assert(p.persisted.length === 1, "pump: once the cycle's signal has fired, no beat persists anything");
  p.stop();
}

{
  let failed = 0;
  // A persist that fails is the case the beat must survive twice over: it must
  // not throw into the gate, and it must not stop the following beats. The pump
  // swallows the failure, so what proves it was HANDLED rather than dropped is
  // the trace line it writes — captured from stderr with the trace switched on.
  const traces: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.env.PI_ENSEMBLE_DEBUG = "1";
  (process.stderr as { write?: unknown }).write = ((chunk: string | Uint8Array) => {
    traces.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let threw = false;
  try {
    const p = await pump({
      persist: () => {
        failed++;
        return Promise.reject(new Error("disk full"));
      },
    });
    try {
      await p.tick(3);
    } catch {
      threw = true;
    }
    p.stop();
  } finally {
    (process.stderr as { write?: unknown }).write = realWrite;
    delete process.env.PI_ENSEMBLE_DEBUG;
  }
  assert(!threw, "pump: a persist that throws never throws into the gate");
  assert(failed === 3, `pump: the beats keep coming after a failing write (attempted ${failed})`);
  assert(
    traces.filter((l) => l.includes("verify-heartbeat not persisted")).length === 3,
    `pump: every failed beat is traced, not dropped (${JSON.stringify(traces.map((l) => l.slice(0, 70)))})`,
  );
}

// Everything from here on drives real fixtures, state files and emit sinks
// under one temp dir.
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-2625-"));
{
  // The wiring seam: the only assertions that prove a beat reaches
  // `persistCycle` and
  // therefore the host's stream, that the abort guard is wired to the cycle's
  // signal, and that a beat's elapsed is measured off the CALLER's `startedAt`.
  // Replacing any of those wiring lines with a no-op or a constant must fail
  // here, not only in the pump's own dependency-injected cases.
  const live = await armOnce(root, "arm-live", 2631, {
    started: startedEvent(),
    startedAt: T0,
    intervalMs: INTERVAL,
    stamp: STAMP,
  });
  assert(
    live.emitted.filter((e) => e.kind === "verify-heartbeat").length === 1,
    `arm: one fired tick puts exactly ONE beat on the real host stream through the real persistCycle (${JSON.stringify(live.emitted.map((e) => e.kind))})`,
  );
  {
    const beat = live.emitted.find((e) => e.kind === "verify-heartbeat") as Heartbeat | undefined;
    assert(
      beat?.at === STAMP && beat?.elapsedSeconds === Math.floor((STAMP - T0) / 1000),
      `arm: the beat is stamped with the wiring's clock and its elapsed is measured off the CALLER's startedAt, not a constant (at ${JSON.stringify(beat?.at)}, elapsed ${JSON.stringify(beat?.elapsedSeconds)}, expected ${Math.floor((STAMP - T0) / 1000)})`,
    );
    assert(
      beat?.step === "develop" && beat?.command === startedEvent().command,
      `arm: the beat carries the step and command of the start event it accompanies (${JSON.stringify([beat?.step, beat?.command])})`,
    );
  }

  const killed = await armOnce(root, "arm-abort", 2632, {
    started: startedEvent(),
    startedAt: T0,
    intervalMs: INTERVAL,
    stamp: STAMP,
    aborted: true,
  });
  assert(
    killed.emitted.filter((e) => e.kind === "verify-heartbeat").length === 0,
    `arm: with the cycle's signal fired, the wired aborted guard persists no beat to the host stream (${JSON.stringify(killed.emitted.map((e) => e.kind))})`,
  );

  // No start event means no run to beat for: the gate wrote nothing, so a beat
  // would be a line for a command that never existed.
  const noRunArms = await countTimerArms(() =>
    armVerifyHeartbeat({
      ctx: {
        repoRoot: "/nonexistent",
        emitSink: createEmitSink(() => {}),
      } as unknown as CycleContext,
      state: baseState(),
      started: undefined,
      intervalMs: INTERVAL,
      startedAt: T0,
    })(),
  );
  assert(noRunArms === 0, "arm: no started event means no run to beat for, so nothing arms");

  // A beat must never be the reason a process stays alive.
  const unrefed = await withUnrefProbe(() =>
    armVerifyHeartbeat({
      ctx: {
        repoRoot: "/nonexistent",
        emitSink: createEmitSink(() => {}),
      } as unknown as CycleContext,
      state: baseState(),
      started: startedEvent(),
      intervalMs: INTERVAL,
      startedAt: T0,
    })(),
  );
  assert(
    unrefed === 1,
    `arm: the real timer is unref'd, so a beat cannot keep the process alive (unref calls: ${unrefed})`,
  );
}

// ───────────────────────── the gate, through verifyStepOutcome ────────────────

// The gate cases drive a real fixture, state file and emit sink through the
// shared harness in lib/verify-heartbeat-gate.ts.

try {
  {
    const r = await runGate(root, "beat-armed", 2625, { heartbeatMs: INTERVAL });
    assert(r.armed().length === 1, `gate: the run arms exactly one beat (armed ${r.armed().length})`);
    assert(
      r.armed()[0]?.step === "develop" && r.armed()[0]?.command === r.cmd,
      `gate: the beat names the CALLER's step and the command (got ${JSON.stringify(r.armed()[0]?.step)}/${JSON.stringify(r.armed()[0]?.command)})`,
    );
    assert(r.armed()[0]?.intervalMs === INTERVAL, "gate: the driver's interval reaches the pump");
    assert(
      r.stopped() === 1,
      `gate: the beat is stopped in the finally on the normal path (stopped ${r.stopped()})`,
    );
    const completed = r.gate?.verifyEvents?.[1];
    assert(
      completed?.kind === "verify-completed" && completed.status === "success",
      `gate: the existing verify-started / verify-completed pair is unchanged (${JSON.stringify(r.gate?.verifyEvents?.map((e) => e.kind))})`,
    );
  }

  {
    // The throwing path. The gate has one arm that makes the gate's own await
    // reject — the project's command exiting non-zero — and every other
    // rejection the span can raise is folded into a verdict before it reaches
    // here. The `finally` is what must stop the beat either way: on the arm that
    // rejects, and on the arm that settles into a failure verdict.
    const spy = await runGate(root, "beat-rejects", 2626, { heartbeatMs: INTERVAL, fail: true });
    assert(spy.armed().length === 1, "gate: the rejecting arm still armed its beat");
    assert(
      spy.stopped() === 1,
      `gate: the finally stops the beat when the command's own arm rejects (stopped ${spy.stopped()})`,
    );
    const completed = spy.gate?.verifyEvents?.[1];
    assert(
      completed?.kind === "verify-completed" && completed.status === "failure",
      `gate: the rejected run still writes its one end event (got ${JSON.stringify(completed)})`,
    );

    // An executor that blows up mid-gate: the span settles as a failure and the
    // beat is still stopped, so no beat can outlive a gate that ended badly.
    const boom = await runGate(root, "beat-throwing", 2630, { heartbeatMs: INTERVAL });
    assert(boom.armed().length === 1, "gate: a mid-gate executor failure still armed its beat");
    assert(
      boom.stopped() === 1,
      `gate: the finally stops the beat on the path where the span settles as a failure (stopped ${boom.stopped()})`,
    );
  }

  {
    // `beginVerifyRun` used to hardcode `step: "develop"`. It is now the
    // CALLER's step, and the two bracket kinds are a host contract that a reader
    // matches started→completed on, so the parameter is pinned here at the
    // function that owns it — on both arms. (The commit-pr GATE does not reach
    // this function: `verifyStepOutcome`'s commit-pr arm runs no verify command,
    // so it writes no bracket; the commit-pr beat is armed at the integrate
    // verify step, which is where that gate's long span actually lives.)
    const atSink = async (name: string, issue: number, step: "develop" | "commit-pr") => {
      const f = await fixture(root, name, ["default"]);
      installVerifyCmd(f.repo, "never-written.txt");
      const emitted: WorkEvent[] = [];
      const ctx = {
        ...ctxFor(f.repo, issue, makeExec({ runs: [], repoRoot: f.repo })),
        emitSink: createEmitSink((e) => emitted.push(e)),
      } as unknown as CycleContext;
      const started = await beginVerifyRun(ctx, stateFor(f, issue), step);
      return { emitted, started };
    };

    const dev = await atSink("step-develop", 2633, "develop");
    const cp = await atSink("step-commit-pr", 2634, "commit-pr");
    assert(
      dev.started?.step === "develop" && cp.started?.step === "commit-pr",
      `beginVerifyRun: the bracket's step is the CALLER's, not a hardcoded develop (${JSON.stringify([dev.started?.step, cp.started?.step])})`,
    );
    assert(
      cp.emitted[0]?.kind === "verify-started" &&
        (cp.emitted[0] as Extract<WorkEvent, { kind: "verify-started" }>).step === "commit-pr",
      `beginVerifyRun: the commit-pr start event reaches the host stream carrying commit-pr (${JSON.stringify(cp.emitted.map((e) => e.kind))})`,
    );
    // The end event inherits its start's step, so the pair cannot disagree.
    const pair = finishVerifyRun(cp.started, true);
    assert(
      pair[0]?.kind === "verify-started" &&
        pair[1]?.kind === "verify-completed" &&
        pair[0].step === "commit-pr" &&
        pair[1].step === "commit-pr",
      `finishVerifyRun: the end agrees with its start's step (${JSON.stringify(pair.map((e) => [e.kind, e.step]))})`,
    );
  }

  {
    // The off switch, against a real run rather than a spy: with the real pump on
    // the ctx seam, an interval of 0 must write no line and an interval on must
    // write its bracket — and the two streams must be the same lines once the
    // beats are removed, which is what "byte-identical to today's" means.
    const off = await runGate(root, "off", 2627, { heartbeatMs: 0, viaPump: true });
    const on = await runGate(root, "on", 2628, { heartbeatMs: INTERVAL, viaPump: true });
    assert(off.beats().length === 0, `switch at 0: no heartbeat line at all (got ${off.beats().length})`);
    assert(
      on.beats().length === 0,
      `a gate whose command returns inside one interval writes no beat either (${on.beats().length})`,
    );
    const kindsOf = (es: WorkEvent[]) => es.map((e) => e.kind);
    assert(
      JSON.stringify(kindsOf(off.emitted)) === JSON.stringify(kindsOf(on.emitted)),
      `switch at 0: the same lines in the same order (off ${JSON.stringify(kindsOf(off.emitted))} vs on ${JSON.stringify(kindsOf(on.emitted))})`,
    );
    // Byte-identity is the host's own comparison: the lines it actually
    // receives, normalised only where they must differ between two runs (each
    // run mints its own `at`, `ms` and idempotency key). An event that leaked
    // onto the off arm — a beat, or a beat-shaped field on the bracket — would
    // change these lines and fail here.
    const lines = (es: WorkEvent[]) =>
      es
        .filter((e) => e.kind !== "verify-heartbeat")
        .map((e, i) =>
          formatLine({
            v: NDJSON_VERSION,
            kind: e.kind,
            at: "<at>",
            issue: 2627,
            key: `<key:${i}>`,
            event: JSON.parse(JSON.stringify({ ...e, at: 0, ms: 0 })),
            ...(isStableKind(e.kind) ? {} : { unstable: true as const }),
          }),
        );
    assert(
      JSON.stringify(lines(off.emitted)) === JSON.stringify(lines(on.emitted)),
      "switch at 0: the host's lines are byte-identical to the on arm once its beats are removed",
    );
    assert(
      off.emitted.length === 1 && off.emitted[0]?.kind === "verify-started",
      `switch at 0: the gate's span puts exactly the pre-change start line on the stream, nothing else (${JSON.stringify(kindsOf(off.emitted))})`,
    );
  }

  // The host's line stream — the emit sink's exactly-once watermark and the
  // /work-status rendering — is test-verify-heartbeat-stream.ts.
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
