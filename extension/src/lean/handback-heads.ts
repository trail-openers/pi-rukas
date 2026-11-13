/**
 * lean/handback-heads — the one reading of the step log that says whether a
 * handback is standing over unverified bytes, and which head it should ship.
 *
 * The rule keys on the LOG, not on the stop cause. A `review` step whose fix
 * wave pushed is the only edge in the table that puts unverified bytes on
 * origin's branch while the run is still walking: `machine.ts` routes `fixed`
 * back through `verify`, so a run that reached `handback` with a `fixed` review
 * as its newest WORK step and no decided `verify` behind it never ran that
 * re-verification. How it got there — the deadline between steps, the step cap,
 * a handler that threw, a table edge — changes nothing about what origin holds.
 *
 * The undecided entry the crash left behind is a step the log carries without a
 * verdict, and it is not work the run did: it is the re-verification that never
 * happened. So the newest work step is the last step of a state the run was
 * actually told something by, which is what makes the same reading hold for a
 * run whose process died between the write-ahead and the outcome.
 *
 * `verify` is decided twice over here — the newest DECIDED `verify` must be
 * `green` and must name a head — because "we know a head we can ship" is a
 * different claim from "the run once saw a gate".
 */

import { REPORT_STATES, type Step, newestDecided } from "./state.ts";

/** What the handback ships: the green's head, or nothing. */
export interface HandbackHeads {
  /** True when the newest work step is a `fixed` review with no later decided `verify`. */
  applies: boolean;
  /** The newest decided green `verify`'s head, or `undefined` when the log has none. */
  verifiedHead?: string;
  /** Why nothing is shipped, in the record's own words, when there is no head to ship. */
  reason?: string;
}

/** The newest step that was WORK and carried a verdict; a report state is how a run ended. */
function newestDecidedWorkStep(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined || step.outcome === undefined) continue;
    if (REPORT_STATES.includes(step.state)) continue;
    return step;
  }
  return undefined;
}

/**
 * The head a handback of this log should ship, or the reason it cannot ship one.
 *
 * A log whose newest work step is anything but a `fixed` review gets
 * `{applies: false}` with no reason: that run left origin where its own step
 * left it, and there is nothing to say about it.
 */
export function handbackHeads(steps: Step[]): HandbackHeads {
  const newest = newestDecidedWorkStep(steps);
  if (newest?.state !== "review" || newest.outcome?.kind !== "fixed") return { applies: false };
  const green = newestDecided(steps, "verify");
  if (green?.outcome?.kind !== "green")
    return {
      applies: true,
      reason:
        green === undefined
          ? "no verify step of this run decided anything, so no head is verified"
          : `the newest decided verify is ${String(green.outcome?.kind)}, not green, so no head is verified`,
    };
  const head = green.outcome.verifiedHead;
  if (typeof head !== "string" || head === "")
    return {
      applies: true,
      reason: "the green verify recorded no head, so there is no verified head to ship",
    };
  if (green.key > newest.key)
    return {
      applies: true,
      reason: `a verify decided after the fixed review (${green.key}) already speaks for the head`,
    };
  return { applies: true, verifiedHead: head };
}
