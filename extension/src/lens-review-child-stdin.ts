/**
 * lens-review-child-stdin — how one lens child's steer reaches its stdin (#952).
 *
 * `runLensChild` owns the spawn, the retry loop, the deck entry and the handle
 * registration; this module owns the one write a steer is. The rule lives here rather
 * than inline because the guard it applies is a property of the handle, not of the
 * round: a child that has already exited takes the #932 closed-stdin treatment, and a
 * steer that cannot land is reported — never thrown — so the caller's retry loop and
 * the round's levers are unaffected by a handle that closed underneath it.
 */

import type { Writable } from "node:stream";
import { trace } from "./trace.ts";

/**
 * #952 — write one RPC steer envelope to this lens's captured stdin (the handle `onStdin` registers).
 * A child that has already exited takes the #932 closed-stdin guard: a traced no-op, never a throw and
 * never an EPIPE. The handle is read through a getter because `onStdin` fills it asynchronously — the
 * steer closure is built before the spawn exists.
 */
export function deliverLensSteer(
  deckKey: string,
  stdin: () => Writable | undefined,
  message: string,
): boolean {
  const lensStdin = stdin();
  if (!lensStdin) {
    trace(`lens steer skipped (${deckKey}): stdin not yet captured`);
    return false;
  }
  if (
    lensStdin.destroyed === true ||
    lensStdin.writable === false ||
    lensStdin.writableEnded === true
  ) {
    trace(`lens steer skipped (${deckKey}): stdin closed`);
    return false;
  }
  try {
    lensStdin.write(`${JSON.stringify({ type: "steer", message })}\n`, () => {
      /* #932 — the write callback swallows the write's own error; the stdin `error` listener at
         spawn time traces it. */
    });
  } catch (err) {
    trace(`lens steer write failed (${deckKey}): ${(err as Error).message}`);
    return false;
  }
  return true;
}
