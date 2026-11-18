/**
 * headless/inputs-c — the reviewer-containment rows of the `HEADLESS_INPUTS` list
 * (#2352), imported and spliced into place by `inputs-b.ts`.
 *
 * Split out along the same alphabetical seam the list is already sorted on, for the
 * §12 file-size cap: `inputs.ts` and `inputs-b.ts` carry the whole inventory in
 * order, and a third module holds the rows whose reader is one pair of switches in
 * `reviewer-scratch-home.ts`. `inputs-b.ts` splices this block at the position the
 * list's own collation puts it, so the exported array stays sorted by name.
 */

import { type HostInput, flag } from "./entry.ts";

/** The two #2352 switches, in the list's order. */
export const HEADLESS_INPUTS_C: readonly HostInput[] = [
  // #2352 R12 — a read-only child's bash runs with a `HOME` and the four XDG roots
  // of its own, under the per-spawn dir the spawn already makes, so a probe that
  // writes through `$HOME`/`$XDG_STATE_HOME` lands in scratch instead of the
  // operator's live state. Gated together with the guard below: a redirect without
  // the guard is isolation nobody can rely on (R10 — a tool may resolve home through
  // the passwd entry). Reader: `reviewerScratchHomeEnabled`.
  flag("REVIEWER_SCRATCH_HOME", true),
  // #2352 — the read-only role's bash confinement: a write, move, link or delete
  // whose target resolves outside the child's cwd and its per-spawn dir is refused
  // as one tool call. `0` is the operator's escape hatch for a review that must
  // reach outside; the #2200 deletion rule stays armed either way. Reader:
  // `reviewerWriteGuardEnabled` (reviewer-scratch-home.ts).
  flag("REVIEWER_WRITE_GUARD", true),
];
