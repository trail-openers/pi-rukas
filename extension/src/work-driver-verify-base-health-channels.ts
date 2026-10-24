/**
 * work-driver-verify-base-health-channels — the two channels the background
 * base-health probe has to the develop gate, in one leaf.
 *
 * The branch step registers the probe and returns; the probe writes no state (a
 * concurrent state write would race the develop step), so the gate's two reads
 * travel out as callbacks. They are grouped because they are one decision made in
 * one place — `aggregateVerifyOutcome` consults the registry once and reports both
 * halves of what it saw — and a caller that collected a verdict without reporting
 * the consultation would log a colour nobody recorded.
 */
import type { BaseHealthConsulted } from "./work-driver-verify-aggregate.ts";
import type { BaseHealthVerdict } from "./workflow-state-schema-base-health.ts";

export interface VerifyCommandGateBaseHealth {
  /**
   * The verdict this gate collected from the BACKGROUND base probe (see
   * `aggregateVerifyOutcome`): `undefined` when nothing was running for this
   * cycle's key. The develop gate is the only writer of
   * `pipelineState.baseHealthProbe`, and only when it needed the verdict.
   */
  onBaseHealthCollected?: (verdict: BaseHealthVerdict | undefined) => void;
  /**
   * Reports the consultation itself — colour and the probe's measured ms — which
   * is the operator-visible record of a probe that used to be a branch-step event.
   */
  onBaseHealthConsulted?: (report: BaseHealthConsulted) => void;
}
