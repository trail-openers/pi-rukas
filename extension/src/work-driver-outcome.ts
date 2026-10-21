/**
 * work-driver-outcome — the shape a `runWorkDriver` call answers with.
 *
 * The LEAF the driver and its pre-loop guards both need: the guards produce a
 * `StartRefusal`, the driver returns a `DriverOutcome` built on top of one, and
 * neither should have to import the other to name the shape. Split from
 * `work-driver.ts` for the §12 file-size cap.
 *
 * The one thing worth reading is `repeatPark`. The #1743 guard refuses a third
 * identical park, and the refusal used to carry only a SENTENCE — so a renderer
 * wanting the count, the cap or the arming issue had to parse that sentence
 * back into fields it never wrote. `repeatPark` carries the guard's own record
 * reading beside the prose. The reason string stays what `isRepeatParkRefusal`
 * recognises, which keeps the headless projection working for an outcome that
 * arrives without a verdict.
 */

import type { RepeatParkVerdict } from "./work-driver-park-memory.ts";

/**
 * A start that will not run, refused before any step is dispatched. `reason` is
 * the prose the driver returns on `{started:false}` and what the notify quotes;
 * `repeatPark` is set only by the #1743 repeat-park guard — absent on every
 * other pre-loop refusal, which has no record behind it.
 */
export interface StartRefusal {
  reason: string;
  repeatPark?: RepeatParkVerdict;
}

/** Outcome of a `runWorkDriver` call: `{started: true}`, or a refusal. */
export type DriverOutcome = { started: true } | ({ started: false } & StartRefusal);
