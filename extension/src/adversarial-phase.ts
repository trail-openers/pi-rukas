/**
 * adversarial-phase — one inner child of the adversarial loop (a review or a
 * fix dispatch): dispatch-deck lifecycle, the slow-run watch (#799, #907), and
 * the orchestrator's active-child bookkeeping so dispatch_peek / dispatch_steer
 * reach the running child.
 *
 * Split out of adversarial.ts (500-line cap). The loop calls the returned
 * `runPhase` for every review and fix dispatch.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childHandles, registerChildHandle } from "./async-jobs-registry.ts";
import { setOrchestratorActiveChild } from "./async-jobs.ts";
import * as dispatchDeck from "./dispatch-deck.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { type OnSlowCallback, feedSlowProgress, watchSlowDispatch } from "./slow-notice.ts";
import { spawnSpecialist } from "./spawn.ts";
import type { DispatchResult } from "./types.ts";

export type RunPhase = (
  role: "adversarial-developer" | "developer",
  tag: string,
  prompt: string,
  cwd?: string,
) => Promise<DispatchResult>;

/**
 * Run one phase, threading dispatch-deck lifecycle and onProgress so the deck
 * shows whichever phase is running now. Also registers the inner spawn as the
 * orchestrator's `activeChild` so PM can `dispatch_peek` / `dispatch_steer`
 * against the loop's jobId and reach the currently-running inner child.
 */
export function makeRunPhase(opts: {
  runId: string;
  signal: AbortSignal;
  orchestratorJobId: string;
  /** #799 — the slow-run recorder for this loop's inner children. */
  onSlow?: OnSlowCallback;
  /** The parent pi for the slow-run watch (the PM notice half). */
  pi?: ExtensionAPI;
}): RunPhase {
  const { runId, signal, orchestratorJobId } = opts;
  return async (role, tag, prompt, cwd) => {
    const deckKey = `${runId}/${tag}`;
    const label = `${role}[${tag}]`;
    dispatchDeck.startEntry(deckKey, { label, role, tag });
    // #799 — the slow-run watch for this inner child: the deck key is the id
    // dispatch_peek shows, and it is what the PM notice names. The parent pi
    // is threaded so the notice reaches the PM (the watch site has no pi).
    // #907 — the CI-wait span feed for this inner child: the watch chains
    // its span tracker in front of the raw-event hook the spawn receives.
    const slowRaw: (event: PiJsonEvent) => void = () => {};
    const stopSlow = watchSlowDispatch({
      id: deckKey,
      role,
      label,
      ...(opts.onSlow ? { onSlow: opts.onSlow } : {}),
      ...(opts.pi ? { pi: opts.pi } : {}),
      onRawEvent: slowRaw,
    });
    try {
      return await spawnSpecialist(
        { role, prompt, cwd },
        {
          signal,
          runId,
          tag,
          onProgress: (state) => {
            dispatchDeck.updateEntry(deckKey, state);
            feedSlowProgress(deckKey, state);
          },
          onRawEvent: stopSlow.onRawEvent ?? slowRaw,
          onStdin: (stdin) => {
            // Publish this inner spawn as the orchestrator's active child so
            // PM's peek/steer calls against the orchestrator jobId resolve
            // to this stdin. Updated on each round; cleared in the finally.
            setOrchestratorActiveChild(orchestratorJobId, {
              role,
              label,
              deckKey,
              stdin,
            });
            // #799 — also registered under the deck key (steer from the peek id).
            registerChildHandle(deckKey, stdin, label, role);
          },
        },
      );
    } finally {
      stopSlow.stop();
      dispatchDeck.clearEntry(deckKey);
      childHandles.delete(deckKey);
      setOrchestratorActiveChild(orchestratorJobId, null);
    }
  };
}
