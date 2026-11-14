/**
 * lib/lean-gates-scripted-log — handlers that replay a step log, for a drive whose
 * gate outcomes come from a REAL gate.
 *
 * `lib/lean-gates-engine-drive.ts` queues gate verdicts by name, which is the right
 * rig for a projection case and the wrong one for a writer case: a queued `red` is the
 * test author's own outcome, so it can say the projection prints an attribution without
 * anything ever having recorded one. These handlers replay a `Step[]` the case built from
 * real handler returns, so the attribution a projection prints is one a gate produced and
 * `saveRun`/`loadRun` round-tripped.
 *
 * One handler per state, answering with that state's entries in log order — the queue the
 * engine's own `scripted` helper holds, fed from the log rather than from a plan.
 */

import type { LeanHandlers } from "../../src/lean/engine.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";

/** The handlers that replay `log`, one queue per state. */
export function scriptedLog(log: Step[]): LeanHandlers {
  const queues = new Map<Step["state"], Outcome[]>();
  for (const step of log) {
    if (step.outcome === undefined) continue;
    const queue = queues.get(step.state) ?? [];
    queue.push(step.outcome);
    queues.set(step.state, queue);
  }
  const handlers: LeanHandlers = {};
  for (const [state, queue] of queues)
    handlers[state] = async () => queue.shift() as Outcome;
  return handlers;
}
