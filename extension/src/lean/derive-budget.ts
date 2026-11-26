/**
 * lean/derive-budget — the ceiling on the spec-intake child, spelled once.
 *
 * Its own leaf because its two readers sit on opposite sides of a cycle:
 * `lean/config.ts` names the row in `DEFAULT_BUDGETS` (so `budgets.derive` in
 * `.pi/work.json` overrides it) and `lean/spec-derive.ts`, which imports that
 * loader, arms the child with it. Declaring the number in either would make the
 * other import it back. The child reads text already in its prompt and has no
 * repository to explore, so it needs neither a builder's turns nor a reviewer's wall clock.
 */

import type { Budget } from "./config.ts";

/** The shipped ceiling for the deriving child: one short, read-only drafting pass. */
export const DERIVE_DEFAULT_BUDGET: Budget = Object.freeze({
  turns: 30,
  tokens: 2_000_000,
  minutes: 10,
});
