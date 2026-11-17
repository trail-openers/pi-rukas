/**
 * adversarial-verdict-reask-constants — the re-ask's own vocabulary: the tag,
 * the label, the one prompt, the result clause, and the child's bound.
 *
 * Its own file because BOTH halves of the feature read them and neither may
 * import the other: the loop side (`adversarial-verdict-reask.ts`) writes the
 * trace line, the lifecycle event and the result text with these values, and the
 * child side (`adversarial-verdict-reask-child.ts`) spawns, bounds and labels
 * the child with them. A constant that lived on only one side would make the
 * other import it across the seam — and an import cycle between a child spawner
 * and its caller is exactly the tangle this split exists to avoid.
 *
 * The prompt lives here for the same reason it lives nowhere else: it is the one
 * text a re-ask child is ever given, and it names NO verdict value. A prompt that
 * listed the four values would hand a model asked for one line a menu to recite,
 * and the candidate reader refuses a menu run.
 */

/** The re-ask child's own wall-clock bound. A verdict line is one line: five
 * minutes is generous for a model that has its whole review in context already,
 * and short enough that a wedged provider call cannot hold the round open. */
export const VERDICT_REASK_BOUND_MS = 300_000;

/**
 * The lifecycle / steer tag naming where the verdict came from.
 *
 * A verdict that arrived through a second child is a fact the operator reads,
 * not a detail: without a named source the scrollback line and the trace are
 * indistinguishable from the review's own reply.
 */
export const VERDICT_REASK_SOURCE_TAG = "adversarial-verdict-reask";

/** The label the re-ask's lifecycle line carries. Distinct from the source tag:
 * one names the child, the other names where the verdict came from, and the
 * scrollback line prints both. */
export const VERDICT_REASK_LABEL = "adversarial-verdict-reask-round";

/**
 * The ONE prompt the re-ask child is given.
 *
 * It deliberately names NO verdict value: a prompt that listed the four values
 * would hand a model asked for one line a menu to recite, and the candidate
 * reader refuses a menu run. The ask is the instruction plus the shape, and
 * nothing else.
 */
export const VERDICT_REASK_PROMPT =
  "Your previous reply did not end with a readable verdict line. Reply with exactly one line, at column 0 and not inside a code fence: `VERDICT:` followed by the single verdict you reached. Nothing else.";

/** The clause every result text and ledger row carries when the verdict came
 * from the re-ask, so the operator can tell a recovered round from a clean one. */
export const VERDICT_REASK_NOTE = "verdict obtained on re-ask";
