/**
 * work-driver-merged-tldr — #1006: prepend a TL;DR section to the issue
 * bodies of every active issue when a /work cycle completes (merged step).
 *
 * The edit reads the CURRENT issue body from the forge (not a cached
 * snapshot) and prepends the TL;DR section, so concurrent user edits are
 * preserved. A body that already carries a `## TL;DR` heading is NOT
 * edited again (idempotency: re-running the cycle does not double-prepend).
 *
 * A failed issueEdit (auth expired, network blip, body over limit) does
 * NOT block the merged step: the failure is recorded as a plumb-report
 * event and the cycle continues to `merged` regardless.
 *
 * The forge seam (`forge.issueView` + `forge.issueEdit`) is the single
 * entry point for both GitHub and GitLab; no raw `gh`/`glab` calls.
<<<<<<< HEAD
=======
 *
 * ## Forge timeout
 *
 * The forge instance is constructed by `forgeForCycle` with a 45 s
 * per-call timeout (the same deadline `work-driver-explore.ts` uses for
 * its issue-body fetch), so `forge.issueView` / `forge.issueEdit` cannot
 * hang the merged step past that bound.
>>>>>>> dc9af52 (fix(work): address lens review MEDIUM findings (dead code, timeout, file size))
 */

import type { Forge } from "./forge.ts";
import { trace } from "./trace.ts";
import { prependTldr, tldrSectionOf } from "./work-driver-pr-body-definition.ts";
import { activeIssuesOf } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * #1006 — prepend the TL;DR section to each active issue's body.
 *
 * For each active issue:
 *   1. Read the CURRENT body via `forge.issueView(n).body` (live read,
 *      not the cached explore-time artifact — a user may have edited the
 *      body since the cycle started).
 *   2. If the body already carries a TL;DR heading → skip (idempotent).
 *   3. Otherwise, call `forge.issueEdit(n, newBody)` with the prepended
 *      body.
 *
 * Returns a list of human-readable notes (empty when everything succeeded
 * or was a no-op). The caller (runMerged) appends each note as a
 * plumb-report event.
 *
 * A failure on ANY issue does NOT stop the loop — the remaining issues
 * are still attempted, and the failure is recorded in the notes.
 */
export async function editIssueTldrs(forge: Forge, state: WorkState): Promise<string[]> {
  const spec = state.pipelineState.normalisedSpec;
  const tldr = tldrSectionOf(spec);
  if (tldr === "") return []; // no source → no edit (empty-string contract)

  const issues = activeIssuesOf(state);
  const notes: string[] = [];

  for (const n of issues) {
    try {
      const current = await forge.issueView(n);
      const currentBody = current.body ?? "";
      const newBody = prependTldr(currentBody, tldr);
      if (newBody === currentBody) {
        // Idempotent: the body already has a TL;DR — nothing to write.
        trace(`work-driver: issue #${n} already has a TL;DR — skipping issueEdit`);
        continue;
      }
<<<<<<< HEAD
=======
      // Note: a truncated forge read would produce a truncated write; a real
      // guard would need a second read or conditional-update API (not
      // implemented).
>>>>>>> dc9af52 (fix(work): address lens review MEDIUM findings (dead code, timeout, file size))
      await forge.issueEdit(n, newBody);
      trace(`work-driver: prepended TL;DR to issue #${n} (body length: ${currentBody.length})`);
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 200) ?? "unknown error";
      trace(`work-driver: TL;DR edit for issue #${n} failed: ${msg}`);
      notes.push(`issueEdit for issue #${n} failed: ${msg}`);
    }
  }

  return notes;
}
