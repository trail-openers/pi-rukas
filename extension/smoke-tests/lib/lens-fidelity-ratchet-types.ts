/**
 * lens-fidelity-ratchet-types — what one ratchet mutant IS.
 *
 * The type is its own module so the three files that speak it (the rig, the
 * policy/ratchet, and the witness) share one definition without any of them
 * importing the others' logic. `redMustContain` is the field worth reading before
 * changing anything: it is what makes a red attributable to the check under test
 * rather than to whatever else happened to break.
 */

/** One entry point the harness claims to verify, and the mutation that must redden
 * a suite if the claim is true. */
export interface HarnessMutant {
  /** Stable id, printed in the report so a reader can point at one row. */
  readonly id: string;
  /** The claim the suite makes about this entry point, in one line. */
  readonly claim: string;
  /** File under `extension/` the mutation edits. */
  readonly file: string;
  /** Exact text to find. A mutation whose `from` is absent is a NO-OP and is
   * refused rather than counted as a red — the same rule `lens-coverage-liveness-
   * probe.ts` applies to its liveness replacement. */
  readonly from: string;
  readonly to: string;
  /** The suite that must redden. */
  readonly suite: string;
  /** Substring at least one red line must contain. Without it a mutant that
   * reddens an unrelated assertion — or crashes the import graph — would count as
   * proof that THIS check can fail. */
  /** The substring that MUST appear in one of the suite's own `✗` lines. Required for
   * an observable mutant — a red that merely happened to appear is not attribution.
   * Absent only when `observable` is false, where no red is owed. */
  readonly redMustContain?: string;
  /**
   * Set to false when the mutation provably cannot change any observable output, with
   * the reason. `redMustContain` is then not asserted and the row reports "unobservable"
   * instead of "proven".
   *
   * WHY THE FIELD EXISTS INSTEAD OF JUST DROPPING THE MUTANT. A mutant whose target is
   * dead code, or whose check is self-confirming at its call site, cannot redden
   * anything — measured, not assumed: deleting P1's guard, deleting
   * `assertHarnessFidelity()`, and hollowing the whole-class helper each left every
   * lens suite at 0 reds. Silently omitting such a mutant is exactly the defect this
   * ratchet was written against: a list that reports "all proven" while covering
   * nothing. So the entry stays, names its target, and states why no red is owed —
   * which is readable, falsifiable, and shows up in the canary that fails the ratchet
   * when the list is emptied.
   */
  readonly observable?: boolean;
  /** Required when `observable` is false: what makes the mutation unobservable, and
   * what holds the target's status in its place. */
  readonly unobservableReason?: string;
}
