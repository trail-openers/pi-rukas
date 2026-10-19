/**
 * work-driver-plan-fence — #1676: the deferred protected paths become a fence.
 *
 * The plan-to-spec gate (#1642) deliberately does not require a deliverable
 * whose path is protected and ungranted (`protectedDeferralsOf`). The plan can
 * therefore leave `.pi/verify-cmd` out of every workstream, and the developer
 * still edits it, because nothing told the developer the path is off-limits;
 * the protected-path halt then parks the cycle after the whole develop spend.
 *
 * So each deferred path is appended to EVERY workstream's `outOfScope`, as the
 * bare normalised path: the scope gate then matches it exactly, and the develop
 * prompt names it. The "protected, no --allow-protected grant" annotation is
 * NOT part of the entry; the prompts render it from the deferral list next to
 * the fence (`protectedFenceNote`). A workstream that declares the path in its
 * own `paths` still gets the fence; the protected-path halt is the backstop.
 *
 * Idempotent: an entry already present (after `normaliseDeclaredPath`) is not
 * appended again, so a re-run of the plan tail adds nothing.
 */

import { neutraliseFenceEntry } from "./plan-workstream-schema.ts";
import { splitDeliverablePaths } from "./work-driver-deliverable-paths.ts";
import { type SpecCoverageSpec, protectedDeferralsOf } from "./work-driver-plan-spec-coverage.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/**
 * The bare normalised paths the plan deferred: every protected, ungranted
 * alternative of every deferred slot, deduplicated, in first-seen order. An
 * either/or slot whose alternatives are all deferred contributes each one.
 */
export function deferredProtectedPaths(
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const d of protectedDeferralsOf(spec, grant)) {
    for (const slot of d.paths) {
      for (const alt of splitDeliverablePaths(slot)) {
        const p = normaliseDeclaredPath(alt);
        if (p.length > 0) out.add(p);
      }
    }
  }
  return [...out];
}

/**
 * The workstreams map with each deferred path appended to every workstream's
 * `outOfScope` that does not already carry it. Returns the input object itself
 * when nothing is appended, so a caller can tell the no-op apart.
 */
export function withDeferredProtectedFence<
  W extends { outOfScope: string[] } = { outOfScope: string[] },
>(
  workstreams: Record<string, W>,
  spec: SpecCoverageSpec | undefined,
  grant: readonly string[],
): Record<string, W> {
  const deferred = deferredProtectedPaths(spec, grant);
  if (deferred.length === 0) return workstreams;
  let changed = false;
  const out: Record<string, W> = {};
  for (const [id, ws] of Object.entries(workstreams)) {
    const present = new Set(ws.outOfScope.map((e) => normaliseDeclaredPath(e)));
    const missing = deferred.filter((p) => !present.has(p));
    if (missing.length === 0) {
      out[id] = ws;
      continue;
    }
    changed = true;
    out[id] = { ...ws, outOfScope: [...ws.outOfScope, ...missing] };
  }
  return changed ? out : workstreams;
}

/**
 * The fence entries that are deferred protected paths, so a prompt can annotate
 * exactly those. Matched on the normalised form, as the fence was written.
 */
export function protectedFenceEntries(
  outOfScope: readonly string[],
  deferred: readonly string[],
): string[] {
  if (deferred.length === 0) return [];
  const set = new Set(deferred);
  return outOfScope.filter((e) => set.has(normaliseDeclaredPath(e)));
}

/**
 * The one line a develop prompt renders beside the fence: which fenced entries
 * are protected with no grant. Empty when none of the fence is deferred.
 */
export function protectedFenceNote(
  outOfScope: readonly string[],
  deferred: readonly string[],
): string {
  const entries = protectedFenceEntries(outOfScope, deferred);
  if (entries.length === 0) return "";
  return `**Protected, no --allow-protected grant** — ${entries
    .map((e) => JSON.stringify(neutraliseFenceEntry(e)))
    .join(
      "; ",
    )} ${entries.length === 1 ? "is a protected path" : "are protected paths"} this cycle may not change; an edit to ${entries.length === 1 ? "it" : "one of them"} parks the cycle.`;
}
