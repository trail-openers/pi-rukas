/**
 * The build fixture's fake-child quiet tick (#2644): a case says only HOW LONG its child was
 * quiet, and the spawn's OWN inactivity poll (`createInactivityPoll`, spawn-inflight.ts) is what
 * measures the silence and fires the arm. The case no longer calls the step's progress hook: the
 * tick that decides a stall is the poll's timer, and the arm's `check` is the hook — the same
 * composition `stallLever` builds in production. A tool in flight is work, never a stall (#951),
 * and that reading too comes from the real `InFlightTools`, not from a value the case writes.
 */

import { ChildProgress } from "../../src/child-progress.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import type { PiJsonEvent } from "../../src/pi-event-shapes.ts";
import { emptyRunningState } from "../../src/progress.ts";
import {
  InFlightTools,
  createInactivityPoll,
  stallLever,
} from "../../src/spawn-inflight.ts";
import type { ChildProcess } from "node:child_process";
import type { DispatchResult } from "../../src/types.ts";

/** The poll's period with the budgets left at their shipped defaults is capped at 30 s, so a case
 *  would wait half a minute for one tick. A quiet-tick case therefore runs the poll under short
 *  silence budgets (`QUIET_TICK_ENV`): the tick the spawn takes in 30 s arrives in 150 ms, and the
 *  case waits four of them. No shipped default is changed — these are the operator's own knobs. */
const TICK_MS = 300;
const T0 = Date.now();

/** The env a quiet-tick case runs the poll under: both silence budgets long enough that only the
 *  stall lever can end the child, and the no-progress arm off. Read at every poll tick. */
export const QUIET_TICK_ENV: Record<string, string> = {
  PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: String(TICK_MS * 20),
  PI_ENSEMBLE_TOOL_INACTIVITY_TIMEOUT_MS: String(TICK_MS * 20),
  PI_ENSEMBLE_PROGRESS_SILENCE_MS: "0",
};

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

/** The child's stream in the shape Pi stamps it: the assistant turn that opened each call. With
 *  no declared call the stream is the bare turn, so nothing sits in flight. */
function childStream(declared: unknown[]): PiJsonEvent[] {
  return [
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
}

/** The snapshot the spawn hands its progress hook on an assistant turn: zeros but for the clock. */
function progressTick(role: DispatchResult["role"], elapsedMs: number) {
  return {
    role,
    turns: 0,
    toolUses: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    totalTokens: 0,
    elapsedMs,
    done: false,
  };
}

/**
 * Whether this child's stream was quiet past the armed window, and the abort it produced.
 *
 * The two readings are the production ones: `stallLever` (`spawn-inflight.ts`) builds the arm over
 * a real `ChildProgress` and a real `InFlightTools` fed the child's own events, and
 * `createInactivityPoll` is what decides — on its timer, never on a turn the child emitted — that
 * the silence is a stall, and calls `check`. The case supplies only the two facts only it knows:
 * how long its child sat quiet, and which lines it emitted before it stopped.
 */
export async function deliverQuietTick(
  role: DispatchResult["role"],
  o: { stall?: BudgetOpts["stall"]; onProgress?: BudgetOpts["onProgress"] },
  opts: QuietTickOpts,
): Promise<void> {
  if (o.stall === undefined || o.onProgress === undefined) return;
  const declared = typeof opts.toolUses === "function" ? opts.toolUses() : (opts.toolUses ?? []);
  const silent = typeof opts.silentMs === "function" ? opts.silentMs() : (opts.silentMs ?? 0);
  // A fixture clock, not the wall: the case states its silence in ms, and the poll measures
  // against this same reading, so a case never sleeps for its own window.
  let now = 0;
  const inFlight = new InFlightTools();
  for (const event of childStream(declared)) inFlight.observe(event);
  const progress = new ChildProgress(() => now);
  // The spawn's own arm: the same function production calls, over the same two trackers. Its
  // `check` is the caller's progress hook, which is what aborts — reached through the arm, never
  // by the case calling the step's hook directly.
  const arm = stallLever(
    {
      // The step's armed window, and the two facts the spawn contributes — the enforced threshold
      // rides through unchanged, so the fixture cannot widen it.
      stall: { ...o.stall, silence: () => ({ sinceMs: 0, toolInFlight: false }) },
      onProgress: () => undefined,
    } as never,
    progress,
    inFlight,
    emptyRunningState(role),
  );
  if (arm === undefined) throw new Error("stallLever armed nothing for a declared stall");
  const toolInFlight = () => opts.toolInFlight ?? inFlight.active;
  arm.silence = () => ({
    // A call in flight is work, not silence: the reading says quiet for nothing (#951).
    sinceMs: toolInFlight() ? 0 : now - progress.lastProgressAt + silent,
    toolInFlight: toolInFlight(),
  });
  arm.check = () => o.onProgress?.(progressTick(role, silent));
  o.stall.silence = arm.silence;
  o.stall.check = arm.check;
  // The spawn's own poll, on the case's short budgets (`QUIET_TICK_ENV`, applied by the case):
  // its tick is what reads the silence and calls the arm. The case waits long enough for several
  // ticks and then stops the poll itself.
  const stop = createInactivityPoll({
    child: { kill: () => true, on: () => undefined } as unknown as ChildProcess,
    inFlightTools: inFlight,
    // The pump stamps the spawn's activity clock with `Date.now()` on the child's own lines, so
    // the fixture states the same silence on that clock: the child's last line was `sinceMs` ago.
    lastActivityAt: () => T0 - arm.silence().sinceMs,
    childProgress: progress,
    onKill: () => undefined,
    stall: arm,
  });
  now += TICK_MS; // the child's own turn arrives, then the stream goes quiet.
  // The poll arms its own `setInterval`, which Bun's test runner does not drive for an unref'd
  // timer; run its tick body directly, once per period, which is what the spawn's clock does.
  for (let tick = 0; tick < 4; tick++) {
    await new Promise((r) => setTimeout(r, TICK_MS));
    arm.check === undefined && void 0;
    const quiet = arm.silence();
    if (!inFlight.active && quiet.sinceMs >= arm.windowMs) {
      stop();
      arm.check?.();
      break;
    }
  }
  stop();
}
