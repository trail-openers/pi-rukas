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
export type InfraErrorCtor = new (
  message: string,
  dispatches?: DispatchUsageRow[],
) => Error & { dispatches?: DispatchUsageRow[] };

/** Why the child ended, in the order the operator reads it. */
export function dispatchFailureCause(result: DispatchResult): string {
  return (
    result.killCause ??
    result.errorStop?.message ??
    result.errorStop?.reason ??
    `exit ${String(result.exitCode)}`
  );
}

/**
 * The tail: throws when the child did not come back clean, nothing when it did.
 *
 * `rows` is handed to the error so a child that died still has its cost on the
 * record — the outcome never lands on a throw.
 */
export function throwIfDispatchFailed(
  result: DispatchResult,
  ErrorClass: InfraErrorCtor,
  prefix: string,
  rows: DispatchUsageRow[],
): void {
  if (result.ok && result.killCause === undefined && result.errorStop === undefined) return;
  throw new ErrorClass(`${prefix}${dispatchFailureCause(result)}`, rows);
}
