/**
 * lean/dispatch-verdict — the one tail every lean dispatch child runs before it
 * decides whether the child failed.
 *
 * The four dispatch sites (`build-dispatch`, `challenge-dispatch`,
 * `specify-attempt`, `review-fix-child`) each read the same fields in the same
 * order and each throw their OWN `*InfraError` carrying their own rows, so the
 * error class and the message prefix are arguments and nothing else varies. The
 * class is passed in rather than imported here: these error types live with the
 * modules that own them, and a central module importing all four would be a cycle
 * waiting to happen.
 */

import { redactClip } from "../decision-log.ts";
import { PROVIDER_MAX } from "../provider-text-budget.ts";
import type { DispatchResult } from "../types.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** The shape every site's `*InfraError` constructor has. */
type InfraErrorCtor = new (
  message: string,
  dispatches?: DispatchUsageRow[],
) => Error & { dispatches?: DispatchUsageRow[] };

/**
 * Why the child came back bad, in the words every throw uses: kill cause, then
 * provider message, then provider reason, then exit code — the most specific
 * reason a child can give wins over the least. Exported because a site that
 * re-dispatches before it throws still has to name the same cause.
 *
 * The text is the child's or the endpoint's, so it is bounded and scrubbed
 * HERE — the one place every site composes it — before it reaches a trace line,
 * an `*InfraError` message or a state record: `redactClip` redacts FIRST and
 * clips second at the shared provider budget, so a cut can never leave a
 * credential fragment, and a short cause (a kill cause, `exit 1`) comes back
 * byte-identical.
 */
function dispatchFailureWhy(result: DispatchResult): string {
  const why =
    result.killCause ??
    result.errorStop?.message ??
    result.errorStop?.reason ??
    `exit ${String(result.exitCode)}`;
  return redactClip(why, PROVIDER_MAX);
}

/**
 * The tail: throws when the child did not come back clean, nothing when it did.
 * `rows` rides on the error so a child that died still has its cost on the record.
 */
function throwIfDispatchFailed(
  result: DispatchResult,
  ErrorClass: InfraErrorCtor,
  prefix: string,
  rows: DispatchUsageRow[],
): void {
  if (result.ok && result.killCause === undefined && result.errorStop === undefined) return;
  throw new ErrorClass(`${prefix}${dispatchFailureWhy(result)}`, rows);
}

export { dispatchFailureWhy, throwIfDispatchFailed };
