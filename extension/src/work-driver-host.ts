/**
 * The seam between the compiled /work drivers and the host they run in (#1020,
 * epic #1018).
 *
 * Driver paths used to hold Pi's `ExtensionAPI` directly (`DriverContext.pi`).
 * That made every driver module depend on the interactive Pi session even
 * though the only capability they exercise is "send a line to the agent" —
 * the steer delivery in `notifyAgent`, the terminal line in
 * `deliverTerminalLine`, and the report delivery in `startJob`. This module
 * names that capability once.
 *
 * `DriverHost` is structural: any object with a steer-delivering
 * `sendUserMessage` satisfies it, so tests can record messages without a Pi
 * session and the driver modules never name `ExtensionAPI`. The Pi-session
 * host (`piSessionHost`) is the only function here that touches Pi; it keeps
 * `deliverAs: "steer"` on every send, so a message sent mid-turn queues rather
 * than throwing and vanishing (see agent-message.ts).
 *
 * Throws propagate. `deliverTerminalLine` depends on a synchronous throw to
 * skip the `handoffDeliveredAt` marker, so the host must not swallow them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchHost } from "./async-jobs-lifecycle.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * What a driver needs from its host. Same shape as the dispatch-side seam,
 * plus `emit` (S4a, #1162): the progress channel for every eventLog entry, fed
 * by `writeState` (see work-state-emit.ts). Optional so hosts with no progress
 * channel implement it as a no-op; the Pi-session host does, and the headless
 * runner (#1024) is the first host that uses it.
 */
export type DriverHost = DispatchHost & {
  emit: (event: WorkEvent) => void;
};

/**
 * Wrap the interactive Pi session as a DriverHost. This is the only
 * driver-side module that names the ExtensionAPI type. It forwards the
 * caller's deliverAs (typed to "steer" under the DispatchHost type) rather
 * than hard-coding it, so the no-behaviour-change guarantee is visible at the
 * call site.
 */
export function piSessionHost(pi: Pick<ExtensionAPI, "sendUserMessage">): DriverHost {
  return {
    sendUserMessage: (text, options) => {
      pi.sendUserMessage(text, { deliverAs: options.deliverAs });
    },
    // The Pi session already renders progress through its messages.
    emit: () => undefined,
  };
}
