/**
 * lean-arms-recorder — the one sink the #2660 site tests install in the three dispatching
 * fixtures (`lean-build-fixture`, `lean-challenge-fixture`, `lean-specify-fixture`).
 *
 * A fixture's fake dispatch pushes the bound arms the step handed it, in dispatch order, so
 * a case scores the deadline's arithmetic on the bytes the seam ACTUALLY received rather
 * than on what `lean-step-bound.ts` would return if asked directly. A site whose wiring
 * dropped the bound is invisible any other way. One implementation for all three fixtures,
 * so a field renamed on `SpawnOptions` is one edit and not three silent regressions.
 */
import type { BudgetOpts } from "../../src/lean/step-budget.ts";

/** What a fixture's fake dispatch was armed with, as the seam received it (#2660). */
export type ArmedOptsSink = BudgetOpts[];

/** Record one dispatch's arms, when the case asked to see them. Absent keys mean the
 *  dispatch received none — an empty object is what an unbounded arm looks like. */
export function recordArmedOpts(
  sink: ArmedOptsSink | undefined,
  o: {
    childBoundMs?: number;
    childBoundGraceMs?: number;
    budgetTurns?: number;
    stall?: BudgetOpts["stall"];
  },
): void {
  sink?.push({
    ...(o.childBoundMs === undefined ? {} : { childBoundMs: o.childBoundMs }),
    ...(o.childBoundGraceMs === undefined ? {} : { childBoundGraceMs: o.childBoundGraceMs }),
    ...(o.budgetTurns === undefined ? {} : { budgetTurns: o.budgetTurns }),
    ...(o.stall === undefined ? {} : { stall: o.stall }),
  });
}
