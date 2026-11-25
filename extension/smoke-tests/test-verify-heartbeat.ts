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
 * it was written before the beat existed. The host-line assertion runs against
 * the REAL emit sink, because a beat held in memory emits zero lines — which is
 * how the earlier periodic watch here died.
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
  startVerifyHeartbeat,
  VERIFY_HEARTBEAT_DEFAULT_MS,
} from "../src/work-driver-verify-events.ts";
import { appendEvent, initialState, persistCycle, type WorkState } from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { fmtEvent } from "../src/work-status-events.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import {
  ctxFor,
  installVerifyCmd,
  makeExec,
  stateFor,
} from "./lib/consolidated-verify-exec.ts";
import { fixture } from "./lib/consolidated-verify-fixture.ts";
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

{
  let unrefCalls = 0;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const stop = armVerifyHeartbeat({
    ctx: { repoRoot: "/nonexistent", emitSink: createEmitSink(() => {}) } as unknown as CycleContext,
    state: baseState(),
    started: startedEvent(),
    intervalMs: INTERVAL,
    startedAt: T0,
    clock: {
      now: () => T0,
      schedule: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        unrefCalls++;
        return () => {
          t.cleared = true;
        };
      },
    },
  });
  assert(unrefCalls === 1 && timers.length === 1, "arm: the ctx seam arms the pump's timer once");
  stop();
  assert(timers.every((t) => t.cleared), "arm: the caller's stop clears it");
  const noRun = armVerifyHeartbeat({
    ctx: { repoRoot: "/nonexistent", emitSink: createEmitSink(() => {}) } as unknown as CycleContext,
    state: baseState(),
    started: undefined,
    intervalMs: INTERVAL,
    startedAt: T0,
  });
  noRun();
  assert(timers.length === 1, "arm: no started event means no run to beat for, so nothing arms");
}

{
  let unrefed = 0;
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as { setTimeout?: unknown }).setTimeout = ((fn: () => void, ms: number) => {
    const t = realSetTimeout(fn, ms);
    return Object.assign(t, {
      unref: () => {
        unrefed++;
        return t;
      },
    });
  }) as typeof setTimeout;
  try {
    const stop = armVerifyHeartbeat({
      ctx: { repoRoot: "/nonexistent", emitSink: createEmitSink(() => {}) } as unknown as CycleContext,
      state: baseState(),
      started: startedEvent(),
      intervalMs: INTERVAL,
      startedAt: T0,
    });
    assert(unrefed === 1, `arm: the real timer is unref'd, so a beat cannot keep the process alive (unref calls: ${unrefed})`);
    stop();
  } finally {
    (globalThis as { setTimeout?: unknown }).setTimeout = realSetTimeout;
  }
}

// ───────────────────────── the gate, through verifyStepOutcome ────────────────

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-2625-"));

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

  // ── the host's line stream, through the real emit sink ───────────────────
  {
    const f = await fixture(root, "host-lines", ["default"]);
    installVerifyCmd(f.repo, "never-written.txt");
    const emitted: WorkEvent[] = [];
    const ctx = {
      ...ctxFor(f.repo, 2629, makeExec({ runs: [], repoRoot: f.repo })),
      emitSink: createEmitSink((e) => emitted.push(e)),
    } as unknown as { repoRoot: string; emitSink: ReturnType<typeof createEmitSink> };
    let state = stateFor(f, 2629);
    const started = startedEvent();
    const completed = { ...started, kind: "verify-completed" as const, status: "success" as const, ok: true, ms: 900_000 };
    const beat = (at: number, elapsedSeconds: number): Heartbeat => ({
      kind: "verify-heartbeat",
      at,
      step: "develop",
      command: started.command,
      elapsedSeconds,
    });
    // One persist carrying the whole run: the log is what the sink replays.
    state = appendEvent(state, started, beat(T0 + 300_000, 300), beat(T0 + 600_000, 600), {
      ...completed,
      at: T0 + 900_000,
    });
    await persistCycle(ctx, state);
    const lines = emitted.map((e) => e.kind);
    assert(
      JSON.stringify(lines) ===
        JSON.stringify(["verify-started", "verify-heartbeat", "verify-heartbeat", "verify-completed"]),
      `host: the stream carries started, both beats and the end, in order, with no re-emission (got ${JSON.stringify(lines)})`,
    );
    const rendered = emitted.map((e) => fmtEvent(e));
    assert(
      rendered.filter((l) => l.includes("verify-heartbeat")).length === 2 &&
        rendered[3]?.includes("15m00s") === true,
      `host: /work-status renders each beat with its elapsed (${JSON.stringify(rendered)})`,
    );
    const findings = validateDiscriminants(state);
    assert(findings.length === 0, `host: a log carrying beats validates (${JSON.stringify(findings)})`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
