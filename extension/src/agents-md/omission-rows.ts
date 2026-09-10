import type { DetectedFacts } from "./detect.ts";
import type { LedgerRow } from "./ledger.ts";

/**
 * The omission-rows builder: for a given `DetectedFacts`, return the
 * `omit:<id>` ledger rows for the fact ids that have no derivable body
 * (e.g. no commands → `omit:quality-gates`). This is the "stale" provenance
 * that the refresh loop uses to detect a body that was previously omitted
 * but is now derivable (or vice-versa).
 *
 * Kept as a standalone seam so update-agent.ts can inject a custom builder
 * in tests without importing the full renderer.
 */
export type OmissionRowsFn = (facts: DetectedFacts, today: string) => LedgerRow[];
