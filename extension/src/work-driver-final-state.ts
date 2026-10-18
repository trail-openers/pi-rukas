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
import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { type WorkState, workStateDir } from "./workflow-state.ts";

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

/**
 * PR12 — refuse to start a cycle over a state file that already reached a
 * terminal status, and tell the operator the one verb that does start one
 * (`--restart`) with the file they would remove instead. Split from
 * work-driver.ts (§12 size limit); the reason string is part of the surface —
 * a smoke test pins "already terminated as handoff".
 *
 * `async` only to match its sibling `refuseAttentionLabelled` at the call
 * site; nothing here awaits.
 */
export async function refuseAlreadyTerminated(
  ctx: Pick<CycleContext, "host" | "repoRoot" | "issue">,
  state: WorkState,
): Promise<string> {
  const terminalStatus = state.pipelineState.status;
  const at = new Date().toISOString();
  notifyAgent(
    ctx.host,
    `pi-rukas:driver-event v1 kind=refused issue=${ctx.issue} at=${at}\npi-rukas: /work for issue #${ctx.issue} already terminated as ${terminalStatus}. To start a fresh cycle (e.g., after revising the issue via /plan), re-run with --restart:\n  /work ${ctx.issue} --restart\nOr rm ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json manually. The prior cycle's event log is preserved in the state file until you restart or remove it.`,
  );
  return `already terminated as ${terminalStatus}`;
}
