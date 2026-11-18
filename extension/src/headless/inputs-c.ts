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

import { type HostInput, flag, str } from "./entry.ts";

/** The #2352 reviewer-containment rows, in the list's order. */
export const HEADLESS_INPUTS_C: readonly HostInput[] = [
  // #2352 R12 — a read-only child's bash runs with a `HOME` and the four XDG roots
  // of its own, under the per-spawn dir the spawn already makes, so a probe that
  // writes through `$HOME`/`$XDG_STATE_HOME` lands in scratch instead of the
  // operator's live state. Gated together with the guard below: a redirect without
  // the guard is isolation nobody can rely on (R10 — a tool may resolve home through
  // the passwd entry). Reader: `reviewerScratchHomeEnabled`.
  flag("REVIEWER_SCRATCH_HOME", true),
  // #2352 C2 — set by the spawn layer (`spawn-child-env.ts`) on a reviewer child the
  // isolation choke point could NOT relocate, never by the operator or a host: on the
  // fail-open the child's cwd IS the reviewed tree, and the reviewer write guard reads
  // this name to drop that cwd from the child's writable roots. `internal`, like the
  // spawn's own temp root and the role stamp. Reader: `reviewerRootsFrom`
  // (write-fence-reviewer.ts) through `UNISOLATED_CHILD_ENV` (reviewer-tree.ts).
  str("REVIEWER_UNISOLATED", null, "internal"),
  // #2352 — the read-only role's bash confinement: a write, move, link or delete
  // whose target resolves outside the child's cwd and its per-spawn dir is refused
  // as one tool call. `0` is the operator's escape hatch for a review that must
  // reach outside; the #2200 deletion rule stays armed either way. Reader:
  // `reviewerWriteGuardEnabled` (reviewer-scratch-home.ts).
  flag("REVIEWER_WRITE_GUARD", true),
];
