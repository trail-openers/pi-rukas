/**
 * The build fixture's fake-child quiet tick (#2644): a case says only HOW LONG its child was
 * quiet, and the spawn's OWN inactivity poll (`createInactivityPoll`, spawn-inactivity-poll.ts) is
 * what measures the silence and fires the arm. The case does not call the step's progress hook and
 * does not evaluate the rule: the tick that decides a stall is the poll's timer, the arm's `fire` is
 * the step's freezing of the verdict, and the canaries below are the only way a case proves its own
 * fixture was live.
 *
 * **The reader measures; it does not assert.** The reading the poll is handed is the production
 * `stallLever`'s own — `Date.now() - childProgress.lastProgressAt` and `InFlightTools.active` — over
 * the two real trackers, and the only thing the case puts into them is its child's own stdout lines,
 * pushed through the real `createStdoutLineHandler` and `attachStdoutLinePump`. A case states a
 * duration and a set of tool calls; it never states a conclusion. That distinction is the whole point
 * of this file: an earlier version substituted `sinceMs: 0` whenever the case claimed a tool in
 * flight, and with that substitution the #951 exemption could be deleted from `stallBreach` and every
 * "a tool in flight is never a stall" case stayed green — the fixture had zeroed the very condition
 * the rule is about. So there is no `toolInFlight` knob here at all: a case that means work in flight
 * hands its child a `toolCall` line whose `toolResult` never arrives, and the real tracker decides
 * what that means.
 *
 * **How a case states a duration without writing a reading.** The production reader asks
 * `Date.now() - childProgress.lastProgressAt`, so the fixture gives `ChildProgress` a clock anchored
 * at the instant the case begins and delivers the child's lines at their own real instants on it;
 * the case's silence is then a SHIFT of that same anchor, applied once the stream has gone quiet.
 * The reader's `Date.now()` is never touched, so what the poll compares against is the real wall
 * since the child's last line — the fixture does not compute a silence, it lets one happen.
 */

import { ChildProgress } from "../../src/child-progress.ts";
import type { CapSession } from "../../src/spawn-caps.ts";
import type { SpawnOptions } from "../../src/pi-event-shapes.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import { emptyRunningState } from "../../src/progress.ts";
import { createInactivityPoll, stallLever as spawnStallLever } from "../../src/spawn-inactivity-poll.ts";
import {
  InFlightTools,
  attachStdoutLinePump,
  createStdoutLineHandler,
} from "../../src/spawn-inflight.ts";
import type { ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import type { DispatchResult } from "../../src/types.ts";

/** The poll's cadence: the case drives the poll's own supervision pass this many times, so the
 *  wait stays a case's wait rather than the 30 s a poll with only a wide lever would take. */
const TICK_MS = 250;
/** How many supervision passes one phase gets: four spans the shortest window these cases use
 *  twice over, so a single pass landing early cannot decide a cell on its own. */
const PASSES = 4;
/** How long the case lets the stream deliver its lines before it drives the supervision passes. */
const DELIVERY_MS = 60;

/** The child's stream in the shape Pi stamps it. A case that declares no tool call still gets the
 *  text turn a real cell child had before its request hung — it wrote code and ran tests — and
 *  nothing beyond it. A case may add lines of its own through `extraLines`, and the real trackers
 *  read those too; what no case may do is state a conclusion its stream does not carry. With no
 *  `toolResult` for a `toolCall`, the real `InFlightTools` keeps that call open, which is the ONLY
 *  way this fixture can mean "a tool is running" (#951). */
function childStream(declared: unknown[], extra: unknown[]): string[] {
  const lines = [
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "endTurn",
        content: [{ type: "text", text: "working" }],
      },
    }),
  ];
  if (declared.length > 0) {
    lines.push(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: declared.map((call, i) => ({
            type: "toolCall",
            id: `tc-${String(i)}`,
            name: (call as { name?: string }).name ?? "bash",
            arguments: (call as { arguments?: Record<string, unknown> }).arguments,
          })),
        },
      }),
    );
  }
  for (const line of extra) lines.push(JSON.stringify(line));
  return lines;
}

export interface QuietTickOpts {
  /** The case's measured silence, ms; a function so a case can vary it per dispatch. The ONLY
   *  conclusion-shaped fact a case may state: a duration, never a verdict. */
  silentMs?: number | (() => number);
  /** The child's tool calls. Each opens a span through the real stream and is never answered, so
   *  the real `InFlightTools` reports work in flight — which is what keeps the child clear of the
   *  lever (#951). There is no other way to mean it. */
  toolUses?: unknown[] | (() => unknown[]);
  /** Extra child events (the Pi shapes of `pi-event-shapes.ts`) delivered through the real pump
   *  after the turn above — for the arm no declared tool list can express, such as a call the
   *  child opened AND answered. Each is one line of the child's own stream; none may state a
   *  silence, an in-flight bit, or a verdict. */
  extraLines?: unknown[] | (() => unknown[]);
  /** The child's own counts when the spawn's progress hook fires: the turns it had completed and
   *  the tokens it had spent. EVERY real cell child has both — a developer works for dozens of
   *  turns before its request hangs — and the snapshot the hook receives must carry them, because
   *  an arm that read `turns`/`totalTokens` off a hand-made zero snapshot would be judged on a
   *  reading no production spawn ever handed it. */
  worked?: { turns: number; totalTokens: number };
  /** The child's own history, ms before its last line: how long it had been emitting lines before
   *  the ones this case declares. Default: as long as the case's silence, which is the hung-request
   *  shape — the child began at the origin, worked, and its stream stopped there. A case meaning
   *  "quiet for less than the window" states a duration SHORTER than its silence, because a child
   *  that began at the same instant its last line arrived has no history to measure and would
   *  otherwise be read as quiet for the whole span. Like every other fact here it is a duration the
   *  case owns, never a reading: the trackers still derive the silence themselves. */
  childAgeMs?: number | (() => number);
}

/** What one quiet tick observed, for the case's own canaries. `fires` is how often the poll handed
 *  a breach to the step's `fire`: the lever is one-shot, so more than one is a poll that did not
 *  stand itself down after ending its child. */
export interface QuietTickReport {
  /** Turn ticks that reached the step's hook, and the count the moment the stream went quiet — the
   *  pair that tells a tick delivered BEFORE the silence from one that arrives inside it. */
  turns: { delivered: number; beforeSilence: number };
  /** Tool calls the real tracker still holds open when the tick finished. */
  inFlight: () => boolean;
  /** The cause the poll's OWN supervision stack named when it ended this child, or `undefined`
   *  while it ended nothing. `undefined` is not "supervised and held its fire" — that answer is
   *  `fires() === 0` beside `supervised`; a cause here is a death the case never armed, and the
   *  difference between `"stall"` and `"no-progress"` is the difference between the rule under
   *  test and the poll's opt-in `PI_ENSEMBLE_PROGRESS_SILENCE_MS` arm stealing the verdict. */
  killed?: () => string | undefined;
  /** What the PRODUCTION reader reported on the poll's LAST supervision pass —
   *  `Date.now() - childProgress.lastProgressAt`, not a value this file computed, and not sampled
   *  afterwards: the reader reads the real wall, so a reading taken after the passes is older by
   *  whatever the case itself spent between them. A case's duration is a statement about its child;
   *  this is the measurement of it at the instant the poll asked, and the two agreeing is the canary
   *  that the fixture's clock and the reader's clock are the same clock. `undefined` until the tick
   *  has run, so a case cannot mistake "no reading" for "quiet for nothing". */
  silence: () => number | undefined;
  /** What the reader reported on the FIRST pass, before any breach could have stood the poll down. */
  firstSilence: () => number | undefined;
  /** Whether the tick ran the supervision loop at all: `false` means the poll never supervised
   *  this child, which is not the same answer as a poll that supervised it and held its fire. */
  supervised: boolean;
  /** Breaches the poll handed to the step's freezing of the verdict. */
  fires: () => number;
  /** How long the poll took, so a canary can tell a missing tick from a missing decision. */
  supervisedMs: () => number;
}

/**
 * Whether this child's stream was quiet past the armed window, and the abort it produced.
 *
 * The two decisions are the production ones. The ARMS are the step's — `armBudget` froze the window
 * and owns the abort — and the reading is the spawn's: the same two trackers `spawn.ts` builds over
 * the child's lines, the same `stallLever` that turns them into the arm, and `createInactivityPoll`
 * which alone decides that a silence is a stall and hands the breach to the arm's `fire`. The case
 * supplies only how long its child sat quiet and which lines it emitted before it stopped.
 */
export async function deliverQuietTick(
  role: DispatchResult["role"],
  o: { stall?: BudgetOpts["stall"]; onProgress?: BudgetOpts["onProgress"] },
  opts: QuietTickOpts,
): Promise<QuietTickReport> {
  const worked = opts.worked ?? { turns: 0, totalTokens: 0 };
  const report: QuietTickReport = {
    turns: { delivered: 0, beforeSilence: 0 },
    inFlight: () => false,
    silence: () => undefined,
    firstSilence: () => undefined,
    supervised: false,
    fires: () => 0,
    supervisedMs: () => 0,
  };
  // The cause reads the live `killed` binding, so the early return below keeps `undefined` — a poll
  // that never ran names no cause, which is a different answer from one that ran and held its fire.
  report.killed = () => killed;
  if (o.stall === undefined || o.onProgress === undefined) return report;
  const declared = typeof opts.toolUses === "function" ? opts.toolUses() : (opts.toolUses ?? []);
  const extra = typeof opts.extraLines === "function" ? opts.extraLines() : (opts.extraLines ?? []);
  const silent = typeof opts.silentMs === "function" ? opts.silentMs() : (opts.silentMs ?? 0);
  const inFlightTools = new InFlightTools();
  report.inFlight = () => inFlightTools.active;
  // The child, the stream, and the handler `spawn.ts` builds over its lines.
  const input = new Readable({ read() {} });
  const child = {
    kill: () => true,
    on: () => undefined,
    stdout: input as unknown as NodeJS.ReadableStream,
  } as unknown as ChildProcess;
  // ONE anchor for every clock in this fixture: the tracker's stamps, the handler's spawn start and
  // the poll's activity clock are all derived from it, so the reader's arithmetic has one origin to
  // be wrong about. The origin sits `age` before the supervision passes run and the child's declared
  // lines are delivered while the anchor still reads that age — so the child has the history the
  // case states, and the silence the case states is what is left after its last line. The reader
  // asks the real wall against `progressAt`, and `progressAt` is on the same anchor: the two differ
  // by exactly the duration the case named, plus the real milliseconds the passes themselves took.
  const age = typeof opts.childAgeMs === "function" ? opts.childAgeMs() : (opts.childAgeMs ?? silent);
  const start = Date.now() - age;
  const childProgress = new ChildProgress(() => start);
  const pumpStamp = () => start;
  let fires = 0;
  // The cause the poll's OWN supervision stack named, if it ended this child at all. Assigned only
  // by `onKill` below, so "supervised and held its fire" and "never supervised" stay distinguishable
  // from a death the case never armed.
  let killed: string | undefined;
  const stepFire = o.stall.fire;
  const handler = createStdoutLineHandler({
    start,
    inFlightTools,
    childProgress,
    appendStderr: () => undefined,
    runningState: emptyRunningState(role),
    // The two arms the stream's hot path feeds but this fixture never consults: the #543 cap session
    // and the #1991 budget steer. Both are required by the handler's own signature, so the fixture
    // states them inertly rather than leaving them out — a child whose caps did something no case
    // asked for would be a second, unrelated cause of death for the child under observation.
    caps: {} as CapSession,
    budgetProgress: { onAssistantTurn: () => undefined, stop: () => undefined },
    // The spawn's own progress hook, which in production is the step's: it carries the counts
    // `spawn.ts` builds by ingesting the child's lines, so a lever that looked at them would be
    // judged on the reading a real spawn hands it — which is what this fixture used to fake away.
    // `worked` is the case's SNAPSHOT of those counts, not a stream-derived reading: no rule under
    // test here reads them (the poll's decider sees only the silence and the in-flight bit), and the
    // turns/tokens priority is pinned through a real `armBudget` in (b5) rather than through this hook.
    onProgress: () => {
      report.turns.delivered++;
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
    },
    onAgentEnd: () => undefined,
  });
  const pump = attachStdoutLinePump({ child, handler, onLine: () => undefined });
  // The spawn's own composer of the arm over the spawn's own two trackers: this is the function
  // `spawn.ts` calls, so the enforced threshold, the minutes a verdict prints, the reader's stamp
  // and the in-flight bit are all production's.
  const arm = spawnStallLever({ stall: o.stall } as SpawnOptions, childProgress, inFlightTools);
  if (arm === undefined) throw new Error("the spawn armed no lever for a declared stall");
  // The step handed the spawn a placeholder reader — it had no stream to read at arm time — and
  // `spawn.ts` is what replaces it with one over the child's own trackers. That replacement is
  // precisely the half the old fixture faked by writing a case-authored reading over it, so the
  // fixture installs the PRODUCTION reader and carries the identical object from here on.
  o.stall.silence = arm.silence;
  const poll = createInactivityPoll({
    child,
    inFlightTools,
    // The pump's clock, stated on the same anchor as everything above. The poll's own silence
    // budgets are switched off below and the caller's lever measures on the reader, so this seam
    // contributes nothing to the decision; it is passed through rather than adjusted.
    lastActivityAt: pumpStamp,
    childProgress,
    // The poll's own silence budgets are switched OFF for this fixture: the case is exercising the
    // caller's lever, and a child quiet for 28 minutes would be ended by `inactivity` — a cause the
    // case never armed — long before the lever's own window closed. The `budgets` override covers
    // the two timeout knobs; `progressSilenceMs` (the no-progress arm) is read per tick from the
    // case's own env, and the case reads the cause back through `killed` rather than trusting it
    // stayed off: `test-lean-request-stall-worked.ts` (b3) pins that with the knob SET the poll
    // still ends this child as a `stall`, not under the wrong cause.
    budgets: () => ({ inactivityMs: 0, toolInactivityMs: 0 }),
    onKill: (cause) => {
      killed = cause;
    },
    stall: {
      ...arm,
      // The enforced threshold the step froze. A caller that forwarded only the whole minutes
      // (`runLensChild`, the adversarial phase) has no ms to give, and that arm is `stallLever`'s
      // coarse form — this fixture always arms through `armBudget`, which always has one.
      windowMs: arm.windowMs as number,
      // The step's freezing of the verdict, wrapped ONLY to count. The wrapper deliberately does not
      // swallow a repeat the way the step's own `fire` does (`if (hit !== undefined) return;`): the
      // poll is meant to stand itself down the moment it ends a child, and a counter sitting behind a
      // one-shot abort cannot see the difference between one breach and four. Every pass after the
      // breach would re-read the silence and re-kill a dead child, and only this count sees it.
      ...(stepFire === undefined
        ? {}
        : {
            fire: (b: Parameters<NonNullable<typeof stepFire>>[0]) => {
              fires++;
              report.fires = () => fires;
              stepFire(b);
            },
          }),
    },
  });
  for (const line of childStream(declared, extra)) input.push(`${line}\n`);
  await new Promise((r) => setTimeout(r, DELIVERY_MS));
  // The stream has gone quiet, and nothing below states a silence: the passes read what the
  // production reader measures from when these lines arrived. A tick counted at this instant is one
  // the child delivered BEFORE the silence — the baseline the turn-tick canary compares against.
  report.turns.beforeSilence = report.turns.delivered;
  let ms = 0;
  for (let i = 0; i < PASSES; i++) {
    await new Promise((r) => setTimeout(r, TICK_MS));
    // Read on the pass itself, not after it: the reader is live, so a reading taken later is a
    // different measurement — it would include the time the case spent between the passes.
    const reading = arm.silence();
    report.silence = () => reading.sinceMs;
    if (i === 0) report.firstSilence = () => reading.sinceMs;
    poll.tick();
    ms += TICK_MS;
  }
  report.supervisedMs = () => ms;
  report.supervised = true;
  poll.stop();
  pump.close();
  input.destroy();
  return report;
}
