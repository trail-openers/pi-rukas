/**
 * #916 SLICE B — the "PM active" badge seam for the live-view header.
 *
 * The parent agent's streaming state is not exposed on the TUI; it is
 * exposed on the ExtensionContext (`ctx.isIdle()`). index.ts flips this
 * flag from pi's `agent_start` / `agent_end` events (the parent's own
 * lifecycle — subagent children are separate processes and never fire
 * the parent's events), and the live-view header reads `pmActive()`
 * each render. A test-only setter keeps the seam drivable from the
 * smoke suite without a live ExtensionContext.
 */

let streaming = false;

/** True while the parent agent is streaming (agent_start fired, agent_end not yet). */
export function pmActive(): boolean {
  return streaming;
}

/** Set the streaming flag (index.ts from agent_start/agent_end; tests directly). */
export function setPmActive(v: boolean): void {
  streaming = v;
}
