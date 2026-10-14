#!/usr/bin/env bun
/**
 * #1162 (S4a) — the `interrupted` status, the `interrupted` event, the emit
 * choke point behind DriverHost.emit, and re-entry of an interrupted cycle.
 *
 * Offline: no Pi session, no network. The re-entry case runs the real driver
 * against a stubbed dispatch that throws, so the cycle ends at its first step.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { DriverHost } from "../src/work-driver-host.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { singleCycleQueueEntry } from "../src/work-queue-single-entry.ts";
import { type EmitSink, createEmitSink } from "../src/work-state-emit.ts";
import { renderCycleIndex } from "../src/work-status-index.ts";
import { renderStatus } from "../src/work-status.ts";
import { appendEvent } from "../src/workflow-state-update.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import {
  type WorkEvent,
  type WorkState,
  initialState,
  markInterrupted,
  readState,
  writeState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "work-interrupted-"));
}

function recordingSink(): { sink: EmitSink; emitted: WorkEvent[] } {
  const emitted: WorkEvent[] = [];
  return { sink: createEmitSink((e) => emitted.push(e)), emitted };
}

function step(s: WorkState, name: "explore" | "plan" | "branch", at: number): WorkState {
  return appendEvent(s, { kind: "step-started", step: name, at });
}

// ── 1. Schema: the status and the event kind are accepted; unknowns are not.
{
  const base = initialState(1);
  const interruptedState = appendEvent(
    {
      ...base,
      pipelineState: { ...base.pipelineState, status: "interrupted" },
    },
    { kind: "interrupted", at: 1, reason: "SIGTERM" },
  );
  assert(
    validateDiscriminants(interruptedState).length === 0,
    "validateDiscriminants accepts status `interrupted` and the `interrupted` event",
  );
  const paused = {
    ...base,
    pipelineState: { ...base.pipelineState, status: "paused" },
  };
  const findings = validateDiscriminants(paused);
  assert(
    findings.some((f) => f.includes('status has unknown value "paused"')),
    "validateDiscriminants rejects an unknown status (`paused`) with the existing message",
  );
}

// ── 2. markInterrupted sets the status, appends the event, and persists.
{
  const repo = tmpRepo();
  try {
    await writeState(repo, initialState(77));
    const next = await markInterrupted(repo, 77, "SIGTERM", undefined, 5);
    const back = await readState(repo, 77);
    assert(
      next?.pipelineState.status === "interrupted",
      "markInterrupted returns status `interrupted`",
    );
    assert(back?.pipelineState.status === "interrupted", "markInterrupted persists the status");
    const last = back?.eventLog[back.eventLog.length - 1];
    assert(
      last?.kind === "interrupted" && last.reason === "SIGTERM",
      "markInterrupted appends an `interrupted` event carrying the reason",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. markInterrupted re-reads the file: a caller's stale snapshot cannot drop
//       events another writer appended since the caller read it.
{
  const repo = tmpRepo();
  try {
    const base = initialState(78);
    await writeState(repo, base);
    // Another writer (the live driver) appends an event and persists.
    await writeState(repo, step(base, "explore", 3));
    // The interrupt handler holds the older snapshot.
    await markInterrupted(repo, 78, "SIGINT", undefined, 4);
    const back = await readState(repo, 78);
    assert(
      back?.eventLog.some((e) => e.kind === "step-started" && e.step === "explore") === true,
      "markInterrupted keeps events another writer appended after the caller's snapshot",
    );
    assert(back?.pipelineState.status === "interrupted", "markInterrupted still sets the status");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 4. Emit choke point: every eventLog entry, once, in order, at persist.
{
  const repo = tmpRepo();
  try {
    const { sink, emitted } = recordingSink();
    const at = 10;
    let state = step(initialState(88), "explore", at);
    state = step(state, "plan", at + 1);
    await writeState(repo, state, sink);
    assert(emitted.length === 2, "two appended events are emitted on the first persist");
    await writeState(repo, state, sink);
    assert(emitted.length === 2, "a persist that adds no events emits nothing");
    const stale = { ...state, eventLog: state.eventLog.slice(0, 1) };
    await writeState(repo, stale, sink);
    assert(emitted.length === 2, "a stale (shorter) snapshot emits nothing");
    // The live cycle's full log is what is on disk again before the interrupt.
    await writeState(repo, state, sink);
    await markInterrupted(repo, 88, "SIGINT", sink, at + 2);
    const persisted = await readState(repo, 88);
    assert(
      JSON.stringify(emitted) === JSON.stringify(persisted?.eventLog),
      "emitted events equal the final eventLog, in order",
    );
    await writeState(repo, step(state, "branch", at + 3));
    assert(emitted.length === persisted?.eventLog.length, "a persist with no sink emits nothing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 5. Rewrite-safe watermark: a spliced or rewritten tail is emitted, not dropped.
{
  const repo = tmpRepo();
  try {
    const { sink, emitted } = recordingSink();
    const base = step(initialState(89), "explore", 1);
    const batch = (n: number, from: number): WorkEvent[] =>
      Array.from({ length: n }, (_, i) => ({ kind: "step-started", step: "plan", at: from + i }));
    const withBatch = (evs: WorkEvent[]): WorkState => ({
      ...base,
      eventLog: [...base.eventLog, ...evs],
    });
    await writeState(repo, withBatch(batch(2, 100)), sink);
    assert(emitted.length === 3, "precondition: explore + a two-event batch are emitted");
    // Replace the last batch with a LONGER one: the new events must reach the sink.
    await writeState(repo, withBatch(batch(3, 200)), sink);
    assert(emitted.length === 6, "a batch replaced by a longer batch emits the new events");
    assert(
      emitted[3]?.at === 200 && emitted[5]?.at === 202,
      "the replacement tail is emitted in order",
    );
    // Replace it with a SHORTER batch: the new events must still reach the sink.
    await writeState(repo, withBatch(batch(1, 300)), sink);
    assert(
      emitted.length === 7 && emitted[6]?.at === 300,
      "a batch replaced by a shorter batch emits its new event",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 6. Sink isolation: a throwing sink never rejects the write, and the
//       watermark still advances so the next persist emits what follows.
{
  const repo = tmpRepo();
  try {
    const delivered: WorkEvent[] = [];
    let throwNext = true;
    const sink = createEmitSink((e) => {
      if (throwNext) {
        throwNext = false;
        throw new Error("sink down");
      }
      delivered.push(e);
    });
    let state = step(initialState(90), "explore", 1);
    await writeState(repo, state, sink).then(
      () => assert(true, "writeState resolves when the sink throws"),
      () => assert(false, "writeState resolves when the sink throws"),
    );
    const onDisk = await readState(repo, 90);
    assert(onDisk?.eventLog.length === 1, "the file is updated although the sink threw");
    state = step(state, "plan", 2);
    await writeState(repo, state, sink);
    assert(
      delivered.length === 1 &&
        delivered[0]?.kind === "step-started" &&
        delivered[0].step === "plan",
      "the next persist emits the following event, not the one that threw",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 7. Re-entry: an interrupted cycle resumes at the step it was interrupted in.
{
  const repo = tmpRepo();
  try {
    const base = initialState(99);
    await writeState(repo, {
      ...base,
      pipelineState: { ...base.pipelineState, currentStep: "plan" },
    });
    await markInterrupted(repo, 99, "SIGTERM", undefined, 1);
    const notices: string[] = [];
    const host: DriverHost = {
      sendUserMessage: (text) => {
        notices.push(text);
      },
      emit: () => undefined,
    };
    const ctx = {
      host,
      repoRoot: repo,
      issue: 99,
      issueBodyFetcherFn: async () => ({
        stdout: "title:\tmock #99\nstate:\tOPEN\n\nnon-empty mock body",
      }),
      dispatchFn: async () => {
        throw new Error("stub: first dispatch fails");
      },
    } as unknown as DriverContext;
    await runWorkDriver(ctx).catch(() => undefined);
    const after = (await readState(repo, 99)) as WorkState;
    const interruptIdx = after.eventLog.findIndex((e) => e.kind === "interrupted");
    const startedAfter = after.eventLog
      .slice(interruptIdx + 1)
      .filter((e) => e.kind === "step-started")
      .map((e) => (e as { step: string }).step);
    assert(
      !notices.some((n) => n.includes("already terminated")),
      "re-entry does not refuse an interrupted cycle as already terminated",
    );
    assert(
      startedAfter[0] === "plan",
      `re-entry starts at the interrupted step (plan), not a later or earlier one — started: ${startedAfter.join(", ") || "none"}`,
    );
    assert(after.pipelineState.status !== "interrupted", "the resumed cycle leaves `interrupted`");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 8. Rendering: /work-status, the cycle index and the queue entry name it.
{
  const repo = tmpRepo();
  try {
    await writeState(repo, initialState(55));
    const state = (await markInterrupted(repo, 55, "SIGTERM", undefined, 1)) as WorkState;
    const status = renderStatus(state, repo);
    assert(
      status.includes("INTERRUPTED") && status.includes("reason: SIGTERM"),
      "renderStatus names the interrupted status and its reason",
    );
    const index = renderCycleIndex([{ issue: 55, state }], Date.now());
    assert(
      index.includes("interrupted at explore (SIGTERM)") && index.includes("/work 55 resumes it"),
      "the cycle index lists the interrupted cycle with its reason and resume action",
    );
    const entry = await singleCycleQueueEntry(repo, 55);
    assert(
      entry?.outcome === "parked" &&
        entry.reason === "cycle interrupted: SIGTERM" &&
        entry.humanAction === "resume with /work 55",
      "the queue summary entry for an interrupted cycle names the reason and the resume action",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

process.exit(exit);
