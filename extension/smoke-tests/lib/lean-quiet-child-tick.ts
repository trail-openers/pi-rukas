/**
 * The build fixture's fake-child quiet tick (#2644): a case says only HOW LONG its child was
 * quiet, and the spawn's OWN inactivity poll (`createInactivityPoll`, spawn-inactivity-poll.ts) is
 * what measures the silence and fires the arm. The case no longer calls the step's progress hook:
 * the tick that decides a stall is the poll's timer, and the arm's `fire` is the step's freezing of
 * the verdict — the same composition `stallLever` builds in production. A tool in flight is work,
 * never a stall (#951), and that reading too comes from the real `InFlightTools`, not from a value
 * the case writes.
 */

import { ChildProgress } from "../../src/child-progress.ts";
import type { SpawnOptions } from "../../src/pi-event-shapes.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import type { PiJsonEvent } from "../../src/pi-event-shapes.ts";
import { emptyRunningState } from "../../src/progress.ts";
import { createInactivityPoll, stallLever as spawnStallLever } from "../../src/spawn-inactivity-poll.ts";
import { InFlightTools } from "../../src/spawn-inflight.ts";
import type { ChildProcess } from "node:child_process";
import type { DispatchResult } from "../../src/types.ts";

/** The poll's cadence: the case drives the poll's own supervision pass this many times, so the
 *  wait stays a case's wait rather than the 30 s a poll with only a wide lever would take. */
const TICK_MS = 300;

export interface QuietTickOpts {
  /** The case's measured silence, ms; a function so a case can vary it per dispatch. */
  silentMs?: number | (() => number);
  /** The child's declared tool calls; non-empty means work in flight, not silence. */
  toolUses?: unknown[] | (() => unknown[]);
  /** Force the in-flight reading, overriding what the stream's own events say — the arm no
   *  hand-built event stream can reach, because production closes a call on a result the fake
   *  child never sends. Used only to show a live child stays clear of the check. A FUNCTION is
   *  asked once per dispatch, so a case that means its FIRST child cannot leak the reading into
   *  every later one. */
  toolInFlight?: boolean | (() => boolean);
  /** The child's own counts when the poll asks the lever: the turns it had completed and the
   *  tokens it had spent. EVERY real cell child has both — a developer works for dozens of turns
   *  before its request hangs — and the snapshot the hook receives must carry them, because an
   *  arm that read `turns`/`totalTokens` off a hand-made zero snapshot would be judged on a
   *  reading no production spawn ever handed it. */
  worked?: { turns: number; totalTokens: number };
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

/**
 * Whether this child's stream was quiet past the armed window, and the abort it produced.
 *
 * The two decisions are the production ones. The ARMS are the step's — `armBudget` froze the window
 * and owns the abort — and the reading is the spawn's: the same two trackers `spawn.ts` builds over
 * the child's lines, the same `stallLever` that turns them into the arm, and `createInactivityPoll`
 * which alone decides that a silence is a stall and hands the breach to the arm's `fire`. The case
 * supplies only the two facts only it knows: how long its child sat quiet, and which lines it
 * emitted before it stopped.
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
  // The spawn's own composer of the arm over the spawn's own two trackers: this is the function
  // `spawn.ts` calls, so the enforced threshold, the minutes a verdict prints, the reader's stamp,
  // the in-flight bit and the step's `fire` are all production's, and the fixture cannot widen them
  // (only the placeholder reader the step handed the spawn, which the spawn replaces in production,
  // is overwritten below with this case's own length of silence).
  const arm = spawnStallLever({ stall: o.stall } as SpawnOptions, progress, inFlight);
  if (arm === undefined) throw new Error("the spawn armed no lever for a declared stall");
  const armWindowMs = arm.windowMs ?? arm.windowMinutes * 60_000;
  const forced = typeof opts.toolInFlight === "function" ? opts.toolInFlight() : opts.toolInFlight;
  const toolInFlight = () => forced ?? inFlight.active;
  const quiet = (): { sinceMs: number; toolInFlight: boolean } => ({
    // A call in flight is work, not silence: the reading says quiet for nothing (#951).
    sinceMs: toolInFlight() ? 0 : now - progress.lastProgressAt + silent,
    toolInFlight: toolInFlight(),
  });
  // The one fact the case owns is the length of its own silence; everything else about the reading,
  // the threshold and the verdict is the production composition's.
  o.stall.silence = quiet;
  arm.silence = quiet;
  const check = (): void => {
    // A turn tick still reaches the step's hook, and it carries the counts `spawn.ts` builds by
    // ingesting the child's own lines — the case's declared turns and tokens, not zeros. A lever
    // that looked at these fields must be judged on the reading a real spawn hands it, which is
    // what this fixture used to fake away. The fixture's own tick calls it once, after the stream's
    // turn has arrived, so a case that arms no poll still sees its hook exercised.
    const worked = opts.worked ?? { turns: 0, totalTokens: 0 };
    o.onProgress?.({
      ...emptyRunningState(role),
      turns: worked.turns,
      totalTokens: worked.totalTokens,
      usage: {
        ...emptyRunningState(role).usage,
        turns: worked.turns,
        input: worked.totalTokens,
      },
      elapsedMs: silent,
    });
  };
  arm.silence = quiet;
  o.stall.silence = quiet;
  // The spawn's own poll, on the case's short budgets (`QUIET_TICK_ENV`, applied by the case):
  // its tick is what reads the silence and calls the arm. The case waits long enough for several
  // ticks and then stops the poll itself.
  const poll = createInactivityPoll({
    child: { kill: () => true, on: () => undefined } as unknown as ChildProcess,
    inFlightTools: inFlight,
    // The pump stamps the spawn's activity clock with `Date.now()` on the child's own lines, so
    // the fixture states the same silence on that clock: the child's last line was `sinceMs` ago.
    lastActivityAt: () => Date.now() - arm.silence().sinceMs,
    childProgress: progress,
    // The poll's own silence budgets are switched OFF for this fixture: the case is exercising the
    // caller's lever, and a child quiet for 28 minutes would be ended by `inactivity` — a cause the
    // case never armed — long before the lever's own window closed.
    budgets: () => ({ inactivityMs: 0, toolInactivityMs: 0 }),
    onKill: () => undefined,
    // The arm as the spawn composes it, with the one fact only the case knows: how long its child
    // sat quiet. The step's `fire` — the hook that freezes the verdict and aborts — is the step's.
    stall: { ...arm, windowMs: armWindowMs, silence: quiet },
  });
  now += TICK_MS; // the child's own turn arrives, then the stream goes quiet.
  check();
  // The poll's own supervision pass makes the decision — the same body its `setInterval` runs, and
  // driven here because Bun's runner does not deliver an unref'd timer inside a case's wait. The
  // fixture never re-implements the decision: it calls the poll and observes what the poll did.
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, TICK_MS));
    poll.tick();
  }
  poll.stop();
}
