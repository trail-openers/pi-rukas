/**
 * /work workflow state — adversarial-loop event fragment.
 *
 * The four adversarial members of the `WorkEvent` union (`adversarial-
 * approved`, `adversarial-rejected`, `adversarial-round`, `adversarial-
 * workstream-outcome`), split out of `workflow-state-events.ts`
 * (AGENTS.md §12 file-size limit — the #728 `consolidation-incomplete` cap
 * pushed the composed union past the 500-line gate). Same seam pattern as
 * workflow-state-events-memory.ts / -provision.ts: the fragment is composed
 * into the closed union by name, so `nextStep()` and the schema validator
 * see exactly the same shape.
 */

export type AdversarialEventFragment =
  | {
      kind: "adversarial-approved";
      at: number;
      jobId: string;
      rounds: number;
      /** Non-blocking findings carried by the gate (see adversarial-findings.ts). */
      findings?: string;
    }
  | {
      kind: "adversarial-rejected";
      at: number;
      jobId: string;
      rounds: number;
      findings: string;
    }
  | {
      /**
       * #485 — one round of the adversarial loop, recorded verbatim from the
       * loop's own round table (NOT recovered from reply prose). The gate's
       * per-round decisions were previously recoverable only from the
       * transcript (issue #478), and the one aggregate `rounds` field was
       * guessed by `parseAdversarialRounds` — an infra failure in round 1
       * reported as "3 rounds, all rejected".
       *
       * `verdictParsed: false` is a real state: the reviewer ran but wrote
       * no readable VERDICT marker, and the status is the parser's safe
       * default, not the reviewer's. The driver records it exactly so
       * "this workstream was rejected" and "this workstream never produced
       * a verdict" stay distinct from the state file.
       */
      kind: "adversarial-round";
      at: number;
      /** #486 — which workstream's loop ran this round. */
      workstreamId?: string;
      round: number;
      status: "CRITICAL_ISSUES_FOUND" | "ISSUES_FOUND" | "MINOR_OBSERVATIONS" | "APPROVED";
      verdictParsed: boolean;
    }
  | {
      /**
       * #485/#486 — the per-workstream terminal outcome of the adversarial
       * loop, distinct from the aggregate verdict events:
       *
       *  - "approved" / "rejected" — a review completed and decided.
       *  - "infra-failure" — a round's dispatch died; NO verdict exists.
       *    Must never render as "all rejected" (issue #478).
       *  - "dispatch-failed" — the loop itself threw before any review ran.
       *  - "skipped-empty-diff" — #286 short-circuit; counts as a pass.
       *
       * Emitted per workstream on N>1 fan-outs so a partial failure
       * (issue #486: one workstream's loop dies, siblings approved) records
       * every sibling's outcome individually instead of discarding the
       * approved ones under one aggregate rejection.
       */
      kind: "adversarial-workstream-outcome";
      at: number;
      workstreamId: string;
      outcome: "approved" | "rejected" | "infra-failure" | "dispatch-failed" | "skipped-empty-diff";
      /** Reviews executed for this workstream (0 when none ran). */
      roundsExecuted: number;
      /** Present for infra-failure / dispatch-failed — what the failure was. */
      errorTail?: string;
    };
