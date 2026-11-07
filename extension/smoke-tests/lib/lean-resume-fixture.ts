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
 * The log is TYPED and its counters are DERIVED, and both choices are load-
 * bearing. The log has to be typed because it is a FORGERY: the rows after the
 * first green `ci` are ones no drive wrote — a drive that earned that green went
 * to `land`, so the verdict a walker would have to feed the table from that
 * position (`land + red`) has no arrow at all, and a `next()`-driven fixture
 * would throw while building the file instead of producing it. The counters
 * beside it are derived because a hand-carried number is a second source of
 * truth for the table's billing: the moment the billing rule moves it refuses
 * an honest file for the wrong reason. `forgedCiRedCounters` folds exactly the
 * prefix a real drive wrote, which is the position `verifiedPosition` has to
 * reach before the forged rows contradict it.
 */

import { foldLog } from "../../src/lean/resume.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState, type Step } from "../../src/lean/state.ts";
import { CLOCK } from "./lean-engine-fixtures.ts";

const step = (issue: number, state: LeanState, n: number, kind: string): Step => ({
  key: `${issue}:${state}:${n}`,
  state,
  startedAt: CLOCK,
  endedAt: CLOCK,
  outcome: { kind },
});

/**
 * The newest row a real drive wrote before the log below was forged, as an
 * entry-key suffix: the first green `ci`. `forgedCiRedCounters` cuts its prefix
 * here, so the two cannot drift apart.
 */
const FORGED_LOG_THROUGH = "ci:0";

/**
 * The walk to a red CI, with the snapshot claiming the run still sits at `ci`.
 *
 * Round one: build, challenge, a RED verify (which raises `draft` and earns
 * the build round below), then a green verify, publish, review, and a green
 * CI — the drive's last real write. Round two is the forgery: the run "took"
 * its one CI fix round, re-built, re-verified, re-published, was reviewed
 * again, and the SECOND CI said red.
 *
 * The two extra `challenge` rows an earlier version of this list carried were
 * the guess this file's header warns about: `challengeDone` is set by the first
 * challenge, so both later builds route to `verify`, and a `challenge` entry for
 * a state the walk never stood in is itself a shape-forgery — the fold then
 * refuses the file for a defect that is not the one under test.
 */
export function forgedCiRedSteps(issue: number) {
  return [
    step(issue, "ready", 0, "ok"),
    step(issue, "specify", 0, "ok"),
    step(issue, "build", 0, "ok"),
    step(issue, "challenge", 0, "none"),
    step(issue, "verify", 0, "red"),
    step(issue, "build", 1, "ok"),
    step(issue, "verify", 1, "green"),
    step(issue, "publish", 0, "ok"),
    step(issue, "review", 0, "done"),
    step(issue, "ci", 0, "green"),
    // From here down: the CI fix round the first green CI did not need, and the
    // second red the snapshot refuses to acknowledge.
    step(issue, "build", 2, "ok"),
    step(issue, "verify", 2, "green"),
    step(issue, "publish", 1, "ok"),
    step(issue, "review", 1, "done"),
    step(issue, "ci", 1, "red"),
  ];
}

/**
 * Counters for the snapshot beside this log: `foldLog`'s own answer for the
 * prefix a drive really wrote — every row through the first green `ci`.
 *
 * Two rounds DISPATCHED. A round is billed on the edge that ENTERS `build` and
 * never on the way out, so `specify:ok` buys the first, the red verify buys the
 * second, and neither `build → challenge` visit costs anything: a build that
 * went to the adversary and came back is the one dispatch it was. That is the
 * arithmetic the dispatch-billing fix restored, and it is why this value is read
 * off the fold instead of typed — under the old rule the same prefix billed
 * three, and a literal here would have quietly pinned the bug.
 *
 * The forged rows after the prefix are deliberately NOT folded: folding them
 * would derive the very position the case exists to show the snapshot does not
 * hold. The prefix is cut by ENTRY KEY rather than by scanning for the last `ci`
 * row, which would land on the forged `ci:1`.
 */
export function forgedCiRedCounters(issue: number): LeanRun["counters"] {
  const steps = forgedCiRedSteps(issue);
  const through = steps.findIndex((s) => s.key === `${issue}:${FORGED_LOG_THROUGH}`);
  const prefix = steps.slice(0, through + 1);
  return foldLog({
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "",
    branch: "",
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps: prefix,
  }).pos.counters;
}
