/**
 * workflow-state-events-explore — the three explore-step events that describe
 * HOW the cycle got a routable spec, split out of the `WorkEvent` union for
 * module-size hygiene (AGENTS.md §12), following the pattern of the other
 * `workflow-state-events-*.ts` leaves.
 *
 * They are one leaf because they answer one question in sequence: what the first
 * reply lacked (`explore-retried`), whether that same session was asked to finish
 * its own reply (`explore-reasked`), and which of the paths finally produced the
 * spec the cycle routes on (`explore-spec-source`). A reader of a state file
 * should be able to reconstruct the explore step without reading transcripts.
 */

/** #1094 — explore re-dispatched once after a completed reply had no `## Spec`. */
export interface ExploreRetriedEvent {
  kind: "explore-retried";
  step: "explore";
  at: number;
  /** Whether the unreadable reply still carried an `INTENT-VERDICT:` token. */
  verdictParsed: boolean;
  /**
   * #1548 — what the first reply lacked, in the cap-evidence wording. A
   * verdict without its `## Spec` is not an accepted verdict; this says so
   * on the event. Absent on events written before #1548.
   */
  missing?: string;
  /** The job id the unreadable attempt's dispatch-completed was recorded under. */
  firstJobId: string;
}

/**
 * #2611 — the ONE same-session follow-up an explore reply gets when it ended
 * on a status line. Recorded BEFORE the re-dispatch decision, so a reader can
 * see the ask ran and whether it answered, and cannot mistake the ask for the
 * fresh dispatch that follows it when it did not.
 */
export interface ExploreReaskedEvent {
  kind: "explore-reasked";
  step: "explore";
  at: number;
  /** Whether the reply the ask followed carried an `INTENT-VERDICT:` token. */
  verdictParsed: boolean;
  /** Whether the ask's own reply carried a spec the driver could read. */
  answered: boolean;
  /** Why the ask produced nothing, when it did not answer. */
  reason?: string;
  /** The job id the reply the ask followed was recorded under. */
  firstJobId: string;
}

/**
 * #2611 — which path produced the spec this cycle routes on, so "the driver
 * got a spec" is answerable without reading transcripts: the first reply, the
 * same-session re-ask, the fresh re-dispatch, or the persisted artifact.
 * Additive: a state file without it simply does not say, as before.
 */
export interface ExploreSpecSourceEvent {
  kind: "explore-spec-source";
  step: "explore";
  at: number;
  source: "first-reply" | "reask" | "redispatch" | "artifact";
  /** The channel the spec itself arrived on, as `resolveExploreSpec` read it. */
  channel: "prose" | "artifact";
}
