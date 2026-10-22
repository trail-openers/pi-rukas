/**
 * workflow-state-schema-base-health — #1765: the state record of the branch
 * step's pre-develop base probe, and of the repo-level cache it feeds.
 *
 * Its own module for the same reason the other schema slices are:
 * `workflow-state-schema.ts` sits at the 500-line cap AGENTS.md §12 enforces,
 * and a probe record is not a PipelineState concern anyone else has to hold in
 * their head while reading it. The rule the record serves — green cached
 * across cycles, red never — lives in `work-driver-verify-base-health.ts`.
 */

/** The suite tier's bound in ms, as the probe key records it. */
export type TierBoundMs = number;

/**
 * The probe's verdict, as it lands on `pipelineState.baseHealthProbe` and, when
 * it is green, in the repo-level cache file. Optional on both: absent means
 * this cycle never probed, which the gate treats as "no opinion", never as
 * "the base is fine".
 */
export interface BaseHealthVerdict {
  status: "green" | "red" | "unknown";
  baseSha: string;
  command: string;
  tierBoundMs: TierBoundMs;
  at: number;
  /** Why a probe established nothing (worktree add failed, missing deps). */
  reason?: string;
}
