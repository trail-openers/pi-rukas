/**
 * work-driver-commit-helpers — the small shared helpers of the commit-pr
 * step (the structured fallback cause + the conflict-artifact seam).
 *
 * Split from work-driver-commit.ts for the AGENTS.md §12 500-line cap.
 * These helpers are shared between the mechanized path (work-driver-commit.ts)
 * and the ops-fallback dispatch (work-driver-commit-fallback.ts); a direct
 * import from either module into the other would create a circular import
 * (both import the other for the dispatch/audit seams), so the shared
 * helpers live here.
 */
import type { IntegrateResult } from "./work-driver-integrate.ts";
import type { CommitPrFallbackCause } from "./workflow-state-events.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/** #539 — the structured cause, or `undefined` when integrate() did not
 * fail. Reads `res.failure` (the discriminator), never re-parses `reason`. */
export function causeFromIntegrateFailure(res: IntegrateResult): CommitPrFallbackCause | undefined {
  if (res.ok) return undefined;
  return res.failure === "dirty-repoRoot" ? "dirty-repoRoot" : "other";
}

/**
 * #861 — the fallback's structural conflict-artifact source. The plumb
 * report the driver appends on a non-terminal mechanized failure carries
 * "(patch preferred at <path>)" in its body (mechanizedCommitPr's reason
 * does) — the ops prompt gets the path from this event, never re-parsed
 * out of a free-text reason at the prompt seam.
 *
 * #861 round 2 — the caller threads `res.conflictPatch` (the structured
 * field on the mechanized failure) into `dispatchCommitPrFallback` and
 * passes it to this helper; the helper now PREFERS the structural value
 * and only falls back to parsing the plumb's body when the caller had no
 * structured value (the "no-diff workstream" reason, which carries no
 * patch). One event indirection, gone.
 */
export function conflictArtifactFromPlumb(
  event: WorkEvent | undefined,
  structural: string | undefined,
): string | undefined {
  if (structural) return structural;
  if (event?.kind !== "plumb-report") return undefined;
  const m = event.body.match(/\(patch preserved at (\S+)\)/);
  return m?.[1];
}
