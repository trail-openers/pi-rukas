/**
 * work-develop-fence-merge-prose — #1005: the evidence prose the merge-and-retry
 * hands the handoff, split out of `work-develop-fence-merge.ts` (which sits at
 * the AGENTS.md §12 line limit) along the natural seam: this module renders
 * strings for a human to read, and nothing here decides whether a merge happens.
 */

import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";

/** #1005 — the merge evidence string, shared by the re-run's cap hits. */
export function mergeEvidence(
  merges: Array<{ into: string; from: string }>,
  discardedShas: string[],
): string {
  return `the merge was ${merges.map((m) => `${m.into}+${m.from}`).join(", ")}; first attempt discarded: ${discardedShas.join(", ") || "no commit ahead of base"}`;
}

/** #1005 — the violated (sibling-declared) records that name a merged
 * workstream, for the re-run's second-failure evidence. */
export function secondViolationProse(fenceViolations: FenceViolationRecord[]): string {
  return fenceViolations
    .filter(
      (v): v is FenceViolationRecord & { kind: "sibling-declared" } =>
        v.kind === "sibling-declared",
    )
    .map((v) => `workstream ${v.workstreamId} touched ${v.file} (declared by ${v.declaredById})`)
    .join("; ");
}
