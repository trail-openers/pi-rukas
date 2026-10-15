/**
 * work-driver-final-state — the #1189 in-memory terminal-state callback.
 *
 * The driver's in-memory terminal state is handed to the caller via
 * `DriverContext.onFinalState`. The state file lives inside the tree the
 * agents work in and agents run as the same user, so an agent can write it.
 * The callback gives the runner (headless) its own, trusted copy of the
 * terminal state for a divergence check (exit-code.ts / result.ts
 * previously read only the file).
 *
 * This module is a leaf: it imports only `CycleContext` and `WorkState`,
 * so the driver can call `reportFinal` from any of its terminal paths
 * without risking a circular dependency.
 */
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * #1189 — invoke the driver's `onFinalState` callback with a cloned copy of
 * the terminal state. A crash (throw) is not a terminal boundary: the
 * callback is not invoked on the throw path. The snapshot is cloned so a
 * caller that holds a reference cannot be fooled by a later driver mutation
 * of the same object. A throwing callback is traced, not rethrown.
 */
export function reportFinalState(ctx: CycleContext, state: WorkState): void {
  try {
    ctx.onFinalState?.(structuredClone(state));
  } catch (err) {
    trace(`work-driver: onFinalState threw: ${err instanceof Error ? err.message : err}`);
  }
}
