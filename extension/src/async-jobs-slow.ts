import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as live from "./dispatch-deck-live.ts";
import type { PiJsonEvent } from "./pi-event-shapes.ts";
import { type OnSlowCallback, watchSlowDispatch } from "./slow-notice.ts";

/** #799/#907 — shared slow-watch wiring (watch + CI-wait span feed). */
export function makeSlowWatch(
  id: string,
  role: string,
  label: string,
  pi: ExtensionAPI | undefined,
  onSlow: OnSlowCallback | undefined,
): { hooks: { onRawEvent: (event: PiJsonEvent) => void }; stop: () => void } {
  const slowRaw: (event: PiJsonEvent) => void = (event) => live.feedRawEvent(id, event);
  const watch = watchSlowDispatch({
    id,
    role,
    label,
    ...(pi ? { pi } : {}),
    ...(onSlow ? { onSlow } : {}),
    onRawEvent: slowRaw,
  });
  return { hooks: { onRawEvent: watch.onRawEvent ?? slowRaw }, stop: watch.stop };
}
