/**
 * The build fixture's fake-child quiet tick (#2644): a case says only HOW LONG its child was
 * quiet, this stands where the spawn's stream stamp would and calls the arm's OWN hook, so the
 * step measures the silence and fires its own abort. A tool in flight is work, never a stall (#951).
 */

import { ChildProgress } from "../../src/child-progress.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import type { PiJsonEvent } from "../../src/pi-event-shapes.ts";
import { emptyRunningState } from "../../src/progress.ts";
import { InFlightTools, stallLever } from "../../src/spawn-inflight.ts";
import type { DispatchResult } from "../../src/types.ts";

export interface QuietTickOpts {
  /** The case's measured silence, ms; a function so a case can vary it per dispatch. */
  silentMs?: number | (() => number);
  /** The child's declared tool calls; non-empty means work in flight, not silence. */
  toolUses?: unknown[] | (() => unknown[]);
  /** Force the in-flight reading, overriding what the stream's own events say — the arm no
   *  hand-built event stream can reach, because production closes a call on a result the fake
   *  child never sends. Used only to show a live child stays clear of the check. */
  toolInFlight?: boolean;
}

/**
 * The stream reader the spawn itself uses, built by the SAME function production builds it with
 * (`stallLever` in `spawn-inflight.ts`) over a real `ChildProgress` and a real `InFlightTools`.
 * The case feeds it the child's own events, so `toolInFlight` is what the production pump reports
 * rather than a value the test writes into the arm.
 *
 * `sinceMs` is the case's measured silence, because a long tool call is silent by definition and
 * only the case knows how long its child went quiet. When the production tracker says a call IS in
 * flight the reading is reported as not-quiet: that is the arm the #951 case turns on, and the
 * production tick cadence is what keeps a live child out of the check entirely.
 */
function productionSilence(
  opts: QuietTickOpts,
  events: PiJsonEvent[],
): { sinceMs: number; toolInFlight: boolean } {
  const progress = new ChildProgress();
  const inFlight = new InFlightTools();
  for (const event of events) {
    progress.observe(event);
    inFlight.observe(event);
  }
  const arm = stallLever(
    { stall: { windowMinutes: 0, silence: () => ({ sinceMs: 0, toolInFlight: false }) } } as never,
    progress,
    inFlight,
    emptyRunningState("developer"),
  );
  if (arm === undefined) throw new Error("stallLever armed nothing for a declared stall");
  const silent = typeof opts.silentMs === "function" ? opts.silentMs() : (opts.silentMs ?? 0);
  const toolInFlight = opts.toolInFlight ?? arm.silence().toolInFlight;
  return { sinceMs: toolInFlight ? 0 : silent, toolInFlight };
}

/** Whether this child's stream was quiet past the armed window, and the abort it produced. */
export function deliverQuietTick(
  role: DispatchResult["role"],
  o: { stall?: BudgetOpts["stall"]; onProgress?: BudgetOpts["onProgress"] },
  opts: QuietTickOpts,
): void {
  if (o.stall === undefined || o.onProgress === undefined) return;
  const declared = typeof opts.toolUses === "function" ? opts.toolUses() : (opts.toolUses ?? []);
  const silent = typeof opts.silentMs === "function" ? opts.silentMs() : (opts.silentMs ?? 0);
  // The child's stream in the shape Pi stamps it: the assistant turn that opened each call. With
  // no declared call the stream is the bare turn, so nothing sits in flight.
  const events: PiJsonEvent[] = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: declared.map((call, i) => ({
          type: "toolCall",
          id: `tc-${String(i)}`,
          name: (call as { name?: string }).name ?? "bash",
          arguments: (call as { arguments?: Record<string, unknown> }).arguments,
        })),
      },
    },
  ];
  // The reader stands where the spawn's own stamp would, on the arm's live opts object — and it is
  // the production reader, not a literal the case asserts against.
  o.stall.silence = () => productionSilence(opts, events);
  o.onProgress({
    role,
    turns: 0,
    toolUses: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    totalTokens: 0,
    elapsedMs: silent,
    done: false,
  });
}
