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

import type { DispatchResult } from "../types.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** The shape every site's `*InfraError` constructor has. */
type InfraErrorCtor = new (
  message: string,
  dispatches?: DispatchUsageRow[],
) => Error & { dispatches?: DispatchUsageRow[] };

/**
 * The tail: throws when the child did not come back clean, nothing when it did.
 *
 * `rows` is handed to the error so a child that died still has its cost on the
 * record — the outcome never lands on a throw. The cause is read as kill cause,
 * then provider error, then exit code, in that order: the most specific reason a
 * child can give wins over the least.
 */
function throwIfDispatchFailed(
  result: DispatchResult,
  ErrorClass: InfraErrorCtor,
  prefix: string,
  rows: DispatchUsageRow[],
): void {
  if (result.ok && result.killCause === undefined && result.errorStop === undefined) return;
  const why =
    result.killCause ??
    result.errorStop?.message ??
    result.errorStop?.reason ??
    `exit ${String(result.exitCode)}`;
  throw new ErrorClass(`${prefix}${why}`, rows);
}

export { throwIfDispatchFailed };
