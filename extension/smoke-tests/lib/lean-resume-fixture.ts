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

import { foldLog } from "../../src/lean/resume.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  type Step,
} from "../../src/lean/state.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";

const step = (issue: number, state: LeanState, n: number, kind: string): Step => ({
  key: `${issue}:${state}:${n}`,
  state,
  startedAt: CLOCK,
  endedAt: CLOCK,
  outcome: { kind },
});

/**
 * The walk to a red CI, with the snapshot claiming the run still sits at `ci`.
 *
 * Round one: build, challenge, a RED verify (which raises `draft` and earns the
 * build round below), then a green verify, publish, review, and a green CI.
 * Round two: that green CI is what `ci:0` below is — the run then took its one
 * CI fix round, re-built, re-verified, re-published, was reviewed again, and the
 * SECOND CI said red. Under dispatch-billing the run dispatched three builds
 * across that walk: the first, the red's fix, and the CI fix round.
 *
 * Every build is followed by its own `challenge` entry, because that is where
 * `build + ok` routes a run whose challenge round is not yet done. Which state an
 * entry belongs to is the table's answer, not the typist's: the fold refuses a
 * `build` entry standing where the walk stood in `challenge`, and this file would
 * then be refused for a shape-forgery while the case is about the snapshot
 * forgery described above.
 */
export function forgedCiRedSteps(issue: number): Step[] {
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

/**
 * The counters the table reaches on `forgedCiRedSteps`.
 *
 * DERIVED, never typed: this is `foldLog` over the very log above, so a case that
 * refuses this file for its FORGERY (the snapshot claiming `ci` while the newest
 * `ci` row is red) is refused for that and nothing else. A hand-carried literal is
 * a second source of truth for the table's counter arithmetic, and the first thing
 * it does when the billing rule moves is refuse an honest file for the wrong
 * reason.
 *
 * `issue` is a parameter because the fold reads it: entry keys are
 * `<issue>:<state>:<n>`, so folding a log under a different issue number makes the
 * fold report a mislabelled entry for a log that is in fact the walk — again the
 * wrong reason to refuse this file.
 */
export function forgedCiRedCounters(issue: number): LeanRun["counters"] {
  return foldLog({
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "",
    branch: "",
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps: forgedCiRedSteps(issue),
  }).pos.counters;
}
