/**
 * work-driver-intent-finalise — the spec's final verdict at the explore step (#1151).
 *
 * Kept apart from work-driver-intent-criticality.ts: work-driver-intent.ts imports
 * the criticality module, so calling reconcileVerdict from there made a runtime
 * import cycle. This module imports both sides; nothing imports it back.
 *
 * The order is the contract: reconcile the resolver's verdict first, then apply
 * the filed issue's open points. Reconciliation can lift an `underspecified`
 * park, and the open-point gate must still park an authorization point after that.
 */

import { trace } from "./trace.ts";
import {
  applyOpenPointGate,
  capToAssumptions,
  criticalOpenPoints,
} from "./work-driver-intent-criticality.ts";
import { type NormalisedSpec, reconcileVerdict } from "./work-driver-intent.ts";

/**
 * The spec's final verdict at the explore step.
 *
 * `primaryBody` is the primary issue body as read; `undefined` or blank means
 * the gate could not run, which is recorded rather than silently skipped.
 */
export function finaliseSpecVerdict(
  spec: NormalisedSpec,
  primaryBody: string | undefined,
): NormalisedSpec {
  const reconciled = reconcileVerdict(spec);
  if (primaryBody !== undefined && primaryBody.trim() !== "") {
    return applyOpenPointGate(reconciled, criticalOpenPoints(primaryBody));
  }
  trace(
    "open-point-gate-unchecked: the filed issue body was not read; its open points were not checked",
  );
  return capToAssumptions(reconciled, [
    {
      text: "Open-point gate did not run: issue body unreadable",
      basis:
        "open-point-gate-unchecked — the driver could not check the issue for CRITICAL open points",
    },
  ]);
}
