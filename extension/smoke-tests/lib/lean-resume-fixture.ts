/**
 * The forgeable log of `test-lean-engine-resume.ts`, in one place.
 *
 * Split from the test for the 500-line cap (AGENTS.md §12) and because the
 * file it writes is the thing four cases judge: a state file whose newest `ci`
 * step is RED while its snapshot claims the run still sits at `ci`. The
 * engine's replay path applies recorded outcomes without running their
 * handlers, so before the fold in `resume.ts` this file resumed by re-applying
 * the older `ci:0 = green` and merged.
 *
 * The log is the walk the table actually produces, entry by entry, with every
 * build round itemised — a `build` step with no outcome is only legal as the
 * LAST entry (the write-ahead of the step about to run), so a middle round has
 * to carry its verdict. That is also why the counters are what they are: they
 * are what `next()` reaches on this exact sequence, and a file whose counters
 * the fold cannot reproduce is refused for a different reason than the one the
 * case is about.
 */

import { CLOCK } from "./lean-engine-fixtures.ts";

const step = (issue: number, state: string, n: number, kind: string) => ({
  key: `${issue}:${state}:${n}`,
  state,
  startedAt: CLOCK,
  endedAt: CLOCK,
  outcome: { kind },
});

/**
 * The walk to a red CI, with the snapshot claiming the run still sits at `ci`.
 *
 * Round one: build, challenge, a RED verify (which raises `draft` and earns
 * the build round below), then a green verify, publish, review, and a green
 * CI. Round two: that green CI is what `ci:0` below is — the run then took its
 * one CI fix round, re-built, re-verified, re-published, was reviewed again,
 * and the SECOND CI said red. `build:2`/`build:3` are the two `viaBuild` edges
 * that round crossed being itemised as entries; `buildAttempts: 4` is what the
 * table bills across all of them.
 */
export function forgedCiRedSteps(issue: number) {
  return [
    step(issue, "ready", 0, "ok"),
    step(issue, "specify", 0, "ok"),
    step(issue, "build", 0, "ok"),
    step(issue, "challenge", 0, "none"),
    step(issue, "verify", 0, "red"),
    step(issue, "build", 1, "ok"),
    step(issue, "challenge", 1, "none"),
    step(issue, "verify", 1, "green"),
    step(issue, "publish", 0, "ok"),
    step(issue, "review", 0, "done"),
    step(issue, "ci", 0, "green"),
    // The CI fix round the first green CI did not need — this is the second
    // red, and the step the snapshot refuses to acknowledge.
    step(issue, "build", 2, "ok"),
    step(issue, "challenge", 2, "none"),
    step(issue, "verify", 2, "green"),
    step(issue, "publish", 1, "ok"),
    step(issue, "review", 1, "done"),
    step(issue, "ci", 1, "red"),
  ];
}

/** Counters the table reaches on `forgedCiRedSteps`. */
export const FORGED_COUNTERS = {
  buildAttempts: 4,
  challengeDone: true,
  reviewDone: true,
  ciFixUsed: true,
  draft: false,
};
