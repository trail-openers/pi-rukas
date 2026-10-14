/**
 * work-state-emit — the choke point behind `DriverHost.emit` (S4a, #1162).
 *
 * Every eventLog entry a /work cycle records is emitted at the persist that
 * first makes it durable: `writeState` calls `emitPersisted` after its atomic
 * rename. `appendEvent` stays pure, and a persist that adds no events emits
 * nothing.
 *
 * The sink is passed EXPLICITLY (`writeState(repoRoot, state, sink)`) — there
 * is no module-level registry of bindings. The cycle entry creates one sink per
 * cycle (`createEmitSink`) and carries it on the DriverContext.
 *
 * ## Watermark
 *
 * The sink keeps one fingerprint per event it has emitted, in order. Its
 * length is the watermark, and its last entry is the fingerprint of the last
 * emitted event. On each persist the log's prefix is compared against those
 * fingerprints:
 *
 *   - Prefix matches and the log grew → emit only the new tail.
 *   - A shorter log that still matches its prefix (a stale snapshot) → emit
 *     nothing and keep the watermark; exactly-once is not weakened. The
 *     watermark is never truncated by a strict prefix.
 *   - A mismatch at index i (the log was spliced or rewritten, e.g. a batch
 *     replaced by a longer or shorter one) → forget fingerprints from i on, and
 *     emit log[i..]. A rewritten event is never silently dropped.
 *
 * Fingerprints are `index|kind|at`. Two events that differ only in payload but
 * share kind, timestamp and position are indistinguishable here by design.
 *
 * Sink isolation: each emit call is guarded. A throwing sink is traced and the
 * watermark still advances, so the same event is never re-emitted and the
 * following events are still delivered on the next persist.
 */

import { trace } from "./trace.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";

export interface EmitSink {
  /** `index` is the event's position in the state's eventLog. */
  emit: (event: WorkEvent, index: number) => void;
  /** One fingerprint per emitted eventLog entry, in log order. Its length is the watermark. */
  fingerprints: string[];
}

/** A fresh sink for one cycle. The watermark starts empty. */
export function createEmitSink(emit: (event: WorkEvent, index: number) => void): EmitSink {
  return { emit, fingerprints: [] };
}

function fingerprint(event: WorkEvent, index: number): string {
  return `${index}|${event.kind}|${event.at}`;
}

/**
 * Emit the eventLog entries of `state` that the sink has not yet seen, from the
 * first index where the log departs from what was already emitted. Never
 * throws: a sink that throws is traced and the watermark still advances.
 */
export function emitPersisted(sink: EmitSink, state: WorkState): void {
  const log = state.eventLog;
  const fps = sink.fingerprints;
  const limit = Math.min(log.length, fps.length);
  let i = 0;
  while (i < limit && fps[i] === fingerprint(log[i] as WorkEvent, i)) i++;
  // A shorter snapshot whose prefix still matches: nothing new, keep the watermark.
  if (i === limit && log.length < fps.length) return;
  if (i < fps.length) {
    trace(
      `work-state-emit: eventLog rewritten at index ${i} (watermark was ${fps.length}); re-emitting from there`,
    );
    fps.length = i;
  }
  for (let j = i; j < log.length; j++) {
    const event = log[j] as WorkEvent;
    // Advance first: a throwing sink must not cause this event to be re-emitted.
    fps.push(fingerprint(event, j));
    try {
      sink.emit(event, j);
    } catch (err) {
      trace(
        `work-state-emit: sink threw on ${event.kind} at index ${j} — ${(err as Error).message}`,
      );
    }
  }
}
