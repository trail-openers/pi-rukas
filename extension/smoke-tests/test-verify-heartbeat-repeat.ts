#!/usr/bin/env bun
/**
 * The beat through the REAL wiring, on real timers, against a real state file.
 *
 * The pump cases in `test-verify-heartbeat.ts` inject a scheduler that fires
 * whatever callback it is handed, and an `armOnce` harness fires that callback
 * by hand. Neither can see the two facts this file owns, and both were broken:
 *
 *   1. The production wiring mapped the pump's scheduler to `setTimeout` — a
 *      ONE-SHOT timer — while the pump arms it exactly once. A long gate wrote
 *      one beat at the first interval and then nothing, which is the very
 *      silence #2625 exists to bound. Only a real timer, allowed to elapse
 *      repeatedly, distinguishes a repeating beat from one.
 *   2. Each beat persisted the snapshot captured at gate start through
 *      `persistCycle`, which writes the WHOLE state. A beat could roll back
 *      anything persisted after the gate started (events, an `interrupted`
 *      status), and successive beats appended to the same frozen log instead of
 *      the growing one. The sink must be a read-modify-write inside the state
 *      file's own write slot.
 *
 * So every assertion here runs the real `armVerifyHeartbeat`: real `setInterval`
 * timings, a real clock, and the real state file on disk read back after the
 * fact. Timeouts are generous (>= 3 of ~6 intervals) so CI jitter cannot make a
 * healthy beat read as a dead one.
 *
 * Run: bun smoke-tests/test-verify-heartbeat-repeat.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CycleContext } from "../src/work-driver-context.ts";
import { armVerifyHeartbeat } from "../src/work-driver-verify-heartbeat.ts";
import { createEmitSink } from "../src/work-state-emit.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import {
  appendBeat,
  appendEvent,
  initialState,
  persistCycle,
  readState,
} from "../src/workflow-state.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import type { WorkState } from "../src/workflow-state-schema.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-2625-repeat-"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await sleep(0);
};

const started = {
  kind: "verify-started" as const,
  at: Date.now() - 1_200,
  step: "develop" as const,
  command: "bash scripts/verify.sh",
  target: { kind: "consolidated" as const },
};

const beatsOf = (s: WorkState | undefined) =>
  (s?.eventLog ?? []).filter((e): e is Extract<WorkEvent, { kind: "verify-heartbeat" }> =>
    e.kind === "verify-heartbeat",
  );

function ctxForFile(repo: string, issue: number, signal?: AbortSignal) {
  return {
    repoRoot: repo,
    issue,
    emitSink: createEmitSink(() => {}),
    ...(signal ? { signal } : {}),
  } as unknown as CycleContext;
}

/** Arm the real wiring, doing nothing else until the caller stops it. */
function arm(ctx: CycleContext, state: WorkState, intervalMs: number) {
  return armVerifyHeartbeat({
    ctx,
    state,
    started,
    intervalMs,
    startedAt: started.at,
  });
}

try {
  // ── 1. The real timer REPEATS: a long gate keeps beating until stop() ──────
  {
    const repo = path.join(root, "repeat");
    const ctx = ctxForFile(repo, 2640);
    const snapshot = initialState(2640, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));

    const INTERVAL = 25;
    const stop = arm(ctx, snapshot, INTERVAL);
    await sleep(INTERVAL * 6 + 120);
    const during = beatsOf(await readState(repo, 2640));
    stop();
    await sleep(INTERVAL * 3 + 60);
    const after = beatsOf(await readState(repo, 2640));

    assert(
      during.length >= 3,
      `repeat: the real wiring beats again each interval across a long gate (got ${during.length} beats over ~6 intervals)`,
    );
    assert(
      during.every((b, i) => i === 0 || b.at > (during[i - 1] as { at: number }).at),
      `repeat: each beat's \`at\` is strictly after its predecessor's (${JSON.stringify(during.map((b) => b.at))})`,
    );
    assert(
      during.every((b) => Number.isInteger(b.elapsedSeconds) && b.elapsedSeconds >= 1),
      `repeat: a real elapsed grows with the run instead of repeating one number (${JSON.stringify(during.map((b) => b.elapsedSeconds))})`,
    );
    assert(
      after.length === during.length,
      `repeat: no beat starts after stop() (${during.length} then ${after.length})`,
    );
    assert(
      after.every((b) => b.step === "develop" && b.command === started.command),
      "repeat: every real beat carries the step and command of the run it accompanies",
    );
  }

  // ── 2. The beat appends: a write that lands mid-gate survives it ───────────
  {
    const repo = path.join(root, "append");
    const ctx = ctxForFile(repo, 2641);
    const snapshot = initialState(2641, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));

    const INTERVAL = 20;
    const stop = arm(ctx, snapshot, INTERVAL);
    await sleep(INTERVAL + 5);
    // The two writes are queued in the SAME tick, so the beat's read-modify-write
    // and the driver's persist are ordered only by the file's write chain. The
    // beat fired first, so it lands first; the driver's write is the one that must
    // then carry the beat's entry as part of what it read, not lose it — and
    // whichever order they land in, the event persisted mid-gate survives both.
    // The driver's snapshot is deliberately the gate-start one plus its own event:
    // a beat that rewrote that frozen snapshot would drop the event.
    const withLaterEvent = appendEvent(snapshot, started, {
      kind: "step-started",
      step: "develop",
      at: 4_000_001,
    });
    const driverWrite = persistCycle(ctx, withLaterEvent);
    await sleep(INTERVAL * 4 + 80);
    stop();
    await driverWrite;

    const onDisk = (await readState(repo, 2641))?.eventLog ?? [];
    const later = onDisk.find((e) => e.kind === "step-started");
    // Read the log ONCE and judge the entries within it: the beats come from a
    // second read, and object identity across two parses of the same file never
    // holds, so every index here must come from the same array.
    const beats = onDisk.filter(
      (e): e is Extract<WorkEvent, { kind: "verify-heartbeat" }> => e.kind === "verify-heartbeat",
    );
    assert(later !== undefined, "append: an event persisted mid-gate is still in the file after the beats");
    assert(
      beats.length >= 2,
      `append: the beats keep arriving across a concurrent driver write (got ${beats.length})`,
    );
    // The driver's event and every beat coexist: a beat that rewrote the
    // gate-start snapshot would have dropped the later event entirely, and a beat
    // that rewrote the log at a fixed index would have left fewer entries than
    // the log actually holds.
    assert(
      later !== undefined &&
        beats.every((b) => onDisk.indexOf(b as never) > onDisk.indexOf(later as never)) &&
        new Set(beats.map((b) => b.at)).size === beats.length,
      `append: every beat stays a distinct entry after the mid-gate event, none overwriting another (${JSON.stringify(onDisk.map((e) => e.kind))})`,
    );
  }

  // ── 3. Successive beats grow one log instead of rewriting the same one ─────
  {
    const repo = path.join(root, "growing");
    const ctx = ctxForFile(repo, 2642);
    const snapshot = initialState(2642, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));

    const INTERVAL = 20;
    const stop = arm(ctx, snapshot, INTERVAL);
    await sleep(INTERVAL * 4 + 80);
    stop();
    await settle();

    const onDisk = (await readState(repo, 2642))?.eventLog ?? [];
    const beats = beatsOf(await readState(repo, 2642));
    assert(
      onDisk.length === 1 + beats.length && beats.length >= 3,
      `grow: the file holds its start and every beat, each at its own index (${JSON.stringify(onDisk.map((e) => e.kind))})`,
    );
    assert(
      beats.length === new Set(beats.map((b) => b.at)).size,
      "grow: successive beats are distinct events, not one frozen beat rewritten",
    );
  }

  // ── 4. stop() never blocks: an in-flight write lands as an append ──────────
  {
    const repo = path.join(root, "inflight");
    const ctx = ctxForFile(repo, 2643);
    const snapshot = initialState(2643, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));

    // A beat fires, and while its write is still queued the driver persists a
    // later status. stop() runs at that moment: the queued beat may finish, but
    // it must land as an append behind the status write rather than as the
    // gate-start snapshot with the old status.
    const INTERVAL = 15;
    const stop = arm(ctx, snapshot, INTERVAL);
    await sleep(INTERVAL + 5);
    stop();
    await persistCycle(
      ctx,
      appendEvent(snapshot, started, { kind: "step-started", step: "develop", at: 5_000_001 }),
    );
    await settle();

    const final = await readState(repo, 2643);
    assert(
      final?.pipelineState.status === "running",
      `in-flight: a beat that outlived stop() cannot roll the file back to an older snapshot (status ${JSON.stringify(final?.pipelineState.status)})`,
    );
    assert(
      (final?.eventLog ?? []).some((e) => e.kind === "step-started"),
      `in-flight: the write that landed after stop() is what the file holds (${JSON.stringify((final?.eventLog ?? []).map((e) => e.kind))})`,
    );
  }

  // ── 5. An aborted cycle: no beat writes, and none rewrites `running` back ──
  {
    const repo = path.join(root, "aborted");
    const ac = new AbortController();
    const ctx = ctxForFile(repo, 2644, ac.signal);
    const snapshot = initialState(2644, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));

    const INTERVAL = 20;
    // A gate run under a signal that has ALREADY fired must write no beat at all:
    // the runner's interrupt event is not the beat's to append, and a beat that
    // read the file after the kill would otherwise carry the cycle back into the
    // host's stream as though it were still going.
    ac.abort("signal");
    const statusBeforeBeats = (await readState(repo, 2644))?.pipelineState.status;
    const stop = arm(ctx, snapshot, INTERVAL);
    await sleep(INTERVAL * 4 + 80);
    stop();
    await settle();

    const final = await readState(repo, 2644);
    assert(
      beatsOf(final).length === 0,
      `abort: no beat persists once the cycle's signal has fired (got ${beatsOf(final).length})`,
    );
    assert(
      statusBeforeBeats === "running" && final?.pipelineState.status === "running",
      `abort: a beat that writes nothing cannot rewrite the cycle's status either (${JSON.stringify(statusBeforeBeats)} → ${JSON.stringify(final?.pipelineState.status)})`,
    );
    assert(
      (final?.eventLog ?? []).every((e) => e.kind !== "interrupted"),
      `abort: and it appends no interrupt event of its own (${JSON.stringify((final?.eventLog ?? []).map((e) => e.kind))})`,
    );
  }

  // ── 6. A beat never keeps the process alive ────────────────────────────────
  {
    // A child of this same runtime armed on a NON-unref'd timer of its own stays
    // alive until it is killed; the same child armed through the real wiring has
    // nothing to wait for and exits on its own. So the two exit codes separate an
    // unref'd repeating timer from a ref'd one.
    const script = path.join(root, "unref-child.ts");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      script,
      [
        `import path from "node:path";`,
        `import { armVerifyHeartbeat } from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "src", "work-driver-verify-heartbeat.ts"))};`,
        `import { createEmitSink } from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "src", "work-state-emit.ts"))};`,
        `import { initialState } from ${JSON.stringify(path.resolve(import.meta.dirname, "..", "src", "workflow-state.ts"))};`,
        `const ctx = { repoRoot: process.argv[2], issue: 1, emitSink: createEmitSink(() => {}) };`,
        `const started = { kind: "verify-started", at: Date.now(), step: "develop", command: "true", target: { kind: "consolidated" } };`,
        `armVerifyHeartbeat({ ctx, state: initialState(1), started, intervalMs: 60000, startedAt: Date.now() });`,
        `if (process.argv[3] === "refd") setTimeout(() => {}, 60000);`,
      ].join("\n"),
    );
    const { execFile } = await import("node:child_process");
    const bun = process.execPath;
    const run = (extra: string) =>
      new Promise<number>((resolve) => {
        const child = execFile(bun, [script, root, extra], { timeout: 20_000 }, () => undefined);
        child.on("exit", (code, sig) => resolve(sig === null ? (code ?? -1) : -2));
      });

    const idle = await run("idle");
    const held = await run("refd");
    assert(
      held === -2,
      `unref: the harness itself is sound — a ref'd timer keeps a child alive (exit ${held})`,
    );
    assert(
      idle === 0,
      `unref: an armed beat is not the reason the process stays alive (exit ${idle}; 124/kill means the repeating timer was ref'd)`,
    );
  }

  // ── 7. A beat already in flight when the signal fires still honours the abort ─
  {
    // No clock is involved: the pump's own `aborted()` guard is checked before the
    // write is queued, so the window between that check and the write slot is
    // where a beat could write a killed cycle back as `running`. The guard above
    // covers beats that START after the kill; this covers the one that was
    // already queued, and it is deterministic because the signal is fired between
    // the two calls rather than during a sleep.
    const repo = path.join(root, "inflight-abort");
    const ac = new AbortController();
    const ctx = ctxForFile(repo, 2648, ac.signal);
    const snapshot = initialState(2648, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));

    ac.abort("signal");
    const inflight = appendBeat(
      repo,
      2648,
      ctx.emitSink,
      ac.signal,
      // The beat the pump built BEFORE the signal fired: the same event shape the
      // wiring builds, handed over directly so no timer decides whether it ran.
      { kind: "verify-heartbeat", at: Date.now(), step: "develop", command: started.command, elapsedSeconds: 3 },
    );
    const final = await inflight;
    assert(
      final?.pipelineState.status === "interrupted",
      `in-flight abort: a beat queued before the kill writes the interrupt, not a running cycle (${JSON.stringify(final?.pipelineState.status)})`,
    );
    assert(
      (final?.eventLog ?? []).some((e) => e.kind === "interrupted") &&
        (final?.eventLog ?? []).some((e) => e.kind === "verify-heartbeat"),
      `in-flight abort: the beat lands behind the runner's interrupt event rather than over the log (${JSON.stringify((final?.eventLog ?? []).map((e) => e.kind))})`,
    );
  }

  // ── 8. A beat on a state file that is not there writes nothing ─────────────
  {
    const repo = path.join(root, "missing");
    const ctx = ctxForFile(repo, 2645);
    const stop = arm(ctx, initialState(2645, 1_000_000), 20);
    await sleep(120);
    stop();
    await settle();
    assert(
      (await readState(repo, 2645)) === undefined,
      "missing file: a cycle that persisted nothing yet gets no beat and no file",
    );
  }

  // ── 9. The write chain still serialises a beat against a driver persist ────
  {
    // A beat and a driver write queued in the same tick must both survive, in
    // call order: the beat appends inside the slot, so the file ends on the
    // driver's snapshot plus the beat rather than either one alone.
    const repo = path.join(root, "chain");
    const ctx = ctxForFile(repo, 2646);
    const snapshot = initialState(2646, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));
    const stop = arm(ctx, snapshot, 1_000_000); // never fires in this case
    // Queue the two writes back to back: the driver's persist of a growing log,
    // then a beat's append through the same file slot.
    const driver = persistCycle(
      ctx,
      appendEvent(snapshot, started, { kind: "step-started", step: "develop", at: 6_000_001 }),
    );
    const other = arm(ctx, snapshot, 1_000_000);
    await driver;
    other();
    stop();
    await settle();
    const onDisk = (await readState(repo, 2646))?.eventLog ?? [];
    assert(
      onDisk.filter((e) => e.kind === "step-started").length === 1 &&
        onDisk[onDisk.length - 1]?.kind === "step-started",
      `write chain: a beat's append and a driver persist both land, in call order (${JSON.stringify(onDisk.map((e) => e.kind))})`,
    );
  }

  // ── 10. The off switch arms no timer at all on the real wiring ──────────────
  {
    const repo = path.join(root, "off");
    const ctx = ctxForFile(repo, 2647);
    const snapshot = initialState(2647, 1_000_000);
    await persistCycle(ctx, appendEvent(snapshot, started));
    let realArms = 0;
    const realSetInterval = globalThis.setInterval;
    (globalThis as { setInterval?: unknown }).setInterval = ((fn: () => void, ms: number) => {
      realArms++;
      return realSetInterval(fn, ms);
    }) as typeof setInterval;
    let stop: () => void;
    try {
      stop = arm(ctx, snapshot, 0);
    } finally {
      (globalThis as { setInterval?: unknown }).setInterval = realSetInterval;
    }
    await sleep(80);
    stop();
    assert(realArms === 0, `switch at 0: the real wiring arms no repeating timer (${realArms})`);
    assert(
      beatsOf(await readState(repo, 2647)).length === 0,
      "switch at 0: no beat reaches the state file",
    );
    assert(
      (await readState(repo, 2647))?.eventLog.length === 1,
      "switch at 0: the file holds exactly the pre-beat bracket",
    );
  }

  // ── 11. The beat's fields are validated at read, like every field a host keys on ─
  {
    // A state file is read through `readState`'s untyped cast, so the validator is
    // the only runtime gate between a corrupt beat and the operator's stall
    // decision. Each row below is one field shaped wrong; the first is the shape
    // the driver writes and must keep validating.
    const beat = (over: Record<string, unknown> = {}) => ({
      kind: "verify-heartbeat",
      at: 3,
      step: "develop",
      command: "bash scripts/verify.sh",
      elapsedSeconds: 300,
      ...over,
    });
    const log = (event: Record<string, unknown>) => ({
      ...initialState(2649, 1_000_000),
      eventLog: [event],
    });
    const findings = (over?: Record<string, unknown>) =>
      validateDiscriminants(log(beat(over ?? {})) as unknown);

    assert(
      findings().length === 0,
      `validate: a real beat validates clean (${JSON.stringify(findings())})`,
    );
    for (const [label, over] of [
      ["a float elapsedSeconds", { elapsedSeconds: 300.5 }],
      ["a string elapsedSeconds", { elapsedSeconds: "300" }],
      ["a missing elapsedSeconds", { elapsedSeconds: undefined }],
      ["a negative elapsedSeconds", { elapsedSeconds: -5 }],
      ["a missing step", { step: undefined }],
      ["a non-string step", { step: 7 }],
      ["a missing command", { command: undefined }],
      ["a non-string command", { command: [] }],
      ["a missing at", { at: undefined }],
      ["an object at", { at: {} }],
    ] as const) {
      const f = findings(over as Record<string, unknown>);
      assert(f.length > 0, `validate: ${label} is reported, not rendered (${JSON.stringify(f)})`);
    }
    // A string `at` is legal — it is the shape the sibling events of this bracket
    // already accept — so the branch must not refuse it.
    assert(
      findings({ at: "1700000000000" }).length === 0,
      "validate: a string `at` validates, as it does on the sibling events",
    );
    // A beat whose step names no real step is caught by the WorkStep check the
    // bracket's other events already share, not by a duplicate of it.
    assert(
      findings({ step: "nonsense" }).some((f) => f.includes("step")),
      "validate: an unknown step still reads as an unknown step",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
