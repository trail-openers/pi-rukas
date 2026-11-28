/**
 * The contract text one #2667 panel row hands its review step.
 *
 * A markdown fence inside a template literal is what broke the panel harness's first split, so
 * the fence is assembled from its own single-line constant rather than written inline. The step
 * under test builds its acceptance table from this body, which is why the body carries one
 * `verify: "test"` criterion the walk can also freeze.
 */

const FENCE = "```";

/** The frozen acceptance table the row's contract states, in the spec block's own JSON. */
const SPEC_CRITERIA = [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }];

/** The issue body: a prose line plus the fenced `pi-spec v1` block the step parses. */
export const SPEC_BODY = [
  "## Problem",
  "",
  "the retry helper gives up too early",
  "",
  `${FENCE}pi-spec v1`,
  JSON.stringify({ size: "S", criteria: SPEC_CRITERIA }),
  FENCE,
  "",
].join("\n");
