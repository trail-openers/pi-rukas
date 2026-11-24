/**
 * work-driver-fetch-reason — a fetch rejection reduced to the one line the
 * explore step puts in its park evidence. Split from `work-driver-explore-run.ts`
 * for module-size hygiene (AGENTS.md §12); the flattening itself is
 * `text-flatten.ts`.
 */
import { flattenAndClip } from "./text-flatten.ts";

/**
 * The message with control characters flattened and at most 300 characters. A
 * rejection that carries no message yields "", which the caller reads as
 * unavailable.
 */
export function fetchFailureReason(reason: unknown): string {
  let message = "";
  if (reason instanceof Error) message = reason.message;
  else if (typeof reason === "string") message = reason;
  return flattenAndClip(message, 300);
}
