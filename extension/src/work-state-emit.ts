/**
 * work-state-emit — the choke point behind `DriverHost.emit` (S4a, #1162).
 *
 * Every eventLog entry a /work cycle records is emitted exactly once, in
 * order, at the persist that first makes it durable: `writeState` calls
 * `emitPersisted` after its atomic rename. `appendEvent` stays pure, and a
 * persist that adds no events emits nothing.
 *
 * A sink is bound per state file by the cycle entry (`enterCycle`). A state
 * file with no bound sink persists normally and emits nothing. The watermark
 * starts at 0 on bind, so a bound sink sees the whole eventLog from its first
 * persist — including events a resumed cycle recorded before this process
 * started.
 */

import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";

interface Binding {
  emit: (event: WorkEvent) => void;
  /** Count of eventLog entries already emitted through this binding. */
  emitted: number;
}

const bindings = new Map<string, Binding>();

/**
 * Bind an emit sink to a state file path. Returns an unbind function that
 * removes only this binding (a later bind for the same file is untouched).
 */
export function bindStateEmitter(file: string, emit: (event: WorkEvent) => void): () => void {
  const binding: Binding = { emit, emitted: 0 };
  bindings.set(file, binding);
  return () => {
    if (bindings.get(file) === binding) bindings.delete(file);
  };
}

/**
 * Emit the eventLog entries of `state` that the bound sink has not yet seen.
 * Called by `writeState` after a successful write. A stale snapshot (shorter
 * than the watermark) emits nothing.
 */
export function emitPersisted(file: string, state: WorkState): void {
  const binding = bindings.get(file);
  if (!binding) return;
  for (const event of state.eventLog.slice(binding.emitted)) {
    binding.emit(event);
    binding.emitted++;
  }
}
