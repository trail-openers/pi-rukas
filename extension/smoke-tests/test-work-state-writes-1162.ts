#!/usr/bin/env bun
/**
 * #1162 (S4a, hand-review round 3) — the state-write seam.
 *
 *   - a failed write leaves no tmp file behind;
 *   - writes to one state file are serialised in call order, so a growing log
 *     ends on disk exactly once and the emit stream equals it;
 *   - the emit watermark is never truncated by a strict-prefix snapshot;
 *   - an interrupt is durable: a driver write of an older `running` snapshot
 *     after `markInterrupted` leaves the file `interrupted`, with one event;
 *   - driver-path modules persist only through `persistCycle`.
 *
 * Offline: temp directories only.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type EmitSink, createEmitSink } from "../src/work-state-emit.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { interruptIfRequested } from "../src/work-driver-interrupt.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import type { WorkState } from "../src/workflow-state-schema.ts";
import { appendEvent } from "../src/workflow-state-update.ts";
import {
  initialState,
  markInterrupted,
  persistCycle,
  readState,
  workStateDir,
  workStateFile,
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

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "work-state-writes-"));
}

function recordingSink(): { sink: EmitSink; emitted: WorkEvent[] } {
  const emitted: WorkEvent[] = [];
  return { sink: createEmitSink((e) => emitted.push(e)), emitted };
}

function stepEvents(base: WorkState, n: number, from = 0): WorkState {
  let s = base;
  for (let i = 0; i < n; i++) {
    s = appendEvent(s, { kind: "step-started", step: "plan", at: from + i });
  }
  return s;
}

function tmpFiles(repo: string): string[] {
  return readdirSync(workStateDir(repo)).filter((f) => f.endsWith(".tmp"));
}

// ── 1. A failed rename removes its tmp file and rejects.
{
  const repo = tmpRepo();
  try {
    // A directory at the target makes rename(2) fail after the tmp write.
    mkdirSync(workStateFile(repo, 91), { recursive: true });
    let rejected = false;
    await writeState(repo, initialState(91)).catch(() => {
      rejected = true;
    });
    assert(rejected, "writeState rejects when the rename fails");
    assert(tmpFiles(repo).length === 0, "a failed rename leaves no *.tmp file behind");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 2. Concurrent writes of a growing log: the longest snapshot lands last,
//       and the emit stream equals the final log exactly once.
{
  const repo = tmpRepo();
  try {
    const { sink, emitted } = recordingSink();
    const base = initialState(92);
    const writes: Promise<void>[] = [];
    for (let n = 1; n <= 25; n++) {
      writes.push(writeState(repo, stepEvents(base, n), sink));
    }
    await Promise.all(writes);
    const back = await readState(repo, 92);
    assert(back?.eventLog.length === 25, "the longest snapshot is the one left on disk");
    assert(
      JSON.stringify(emitted) === JSON.stringify(back?.eventLog),
      "emitted events equal the final eventLog exactly once, in order",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 3. Watermark: a strict-prefix snapshot never truncates what was emitted.
{
  const repo = tmpRepo();
  try {
    const { sink, emitted } = recordingSink();
    const full = stepEvents(initialState(93), 4);
    await writeState(repo, full, sink);
    await writeState(repo, { ...full, eventLog: full.eventLog.slice(0, 2) }, sink);
    await writeState(repo, full, sink);
    assert(emitted.length === 4, "a strict-prefix snapshot does not re-emit the tail");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 4. Interrupt durability (headless S4, #1024): markInterrupted applies only
//       while the cycle is running. A terminal status is never rewritten, and a
//       second interrupt adds no second event. The driver records its own
//       interrupt through persistCycle (work-driver-interrupt.ts), so there is no
//       storage-layer override that could rewrite a later persist.
{
  const repo = tmpRepo();
  try {
    const { sink, emitted } = recordingSink();
    const older = stepEvents(initialState(94), 1);
    await writeState(repo, older, sink);
    await markInterrupted(repo, 94, "SIGTERM", sink, 50);
    await markInterrupted(repo, 94, "SIGINT", sink, 51);
    const back = await readState(repo, 94);
    assert(back?.pipelineState.status === "interrupted", "markInterrupted sets interrupted");
    const interrupts = back?.eventLog.filter((e) => e.kind === "interrupted") ?? [];
    assert(interrupts.length === 1, "a second interrupt adds no second interrupted event");
    assert(
      JSON.stringify(emitted) === JSON.stringify(back?.eventLog),
      "the emit stream equals the final log after the interrupt",
    );
    // Terminal status is never rewritten.
    const merged = {
      ...older,
      pipelineState: { ...older.pipelineState, status: "merged" as const },
    };
    await writeState(repo, merged, sink);
    await markInterrupted(repo, 94, "SIGTERM", sink, 52);
    const term = await readState(repo, 94);
    assert(
      term?.pipelineState.status === "merged",
      "markInterrupted never rewrites a terminal status",
    );
    // A later driver write is not overridden by an earlier interrupt (no sticky flag).
    await persistCycle({ repoRoot: repo, emitSink: sink }, older);
    const after = await readState(repo, 94);
    assert(
      after?.pipelineState.status === "running",
      "no storage-layer override survives a later write",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 5. The driver's own interrupt (headless S4, #1024): interruptIfRequested
//       records the interrupt once; a driver persist after it re-emits nothing.
{
  const repo = tmpRepo();
  try {
    const { sink, emitted } = recordingSink();
    const running = stepEvents(initialState(95), 1);
    await writeState(repo, running, sink);
    const ac = new AbortController();
    ac.abort("signal");
    // Only repoRoot, emitSink and signal are read on this path.
    const ctx = { repoRoot: repo, emitSink: sink, signal: ac.signal } as unknown as DriverContext;
    const interrupted = await interruptIfRequested(ctx, running);
    assert(interrupted.pipelineState.status === "interrupted", "the driver records its own interrupt");
    const again = await interruptIfRequested(ctx, interrupted);
    assert(again === interrupted, "a second driver check adds no second interrupted event");
    const later = appendEvent(interrupted, { kind: "step-started", step: "plan", at: 60 });
    await persistCycle(ctx, later);
    const back = await readState(repo, 95);
    assert(
      JSON.stringify(emitted) === JSON.stringify(back?.eventLog),
      "driver persist after its interrupt: emit stream equals the final log exactly once",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ── 6. Smoke grep: no module outside the seam calls writeState( directly.
//       Comments are stripped first, so prose that names writeState( is not a call.
//       workflow-state.ts is the seam itself and is the one exempt file.
{
  const src = path.resolve(import.meta.dir, "../src");
  const names = readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "workflow-state.ts");
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const offenders = names.filter((f) =>
    /\bwriteState\(/.test(stripComments(readFileSync(path.join(src, f), "utf8"))),
  );
  assert(
    names.length > 0 && offenders.length === 0,
    `no module outside workflow-state.ts calls writeState( directly (offenders: ${offenders.join(", ") || "none"})`,
  );
}

process.exit(exit);
