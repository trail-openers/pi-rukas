/**
 * work-driver-plan-fence — #1676: the deferred protected paths become a fence.
 *
 * The plan-to-spec gate (#1642) deliberately does not require a deliverable
 * whose path is protected and ungranted (`protectedDeferralsOf`). The plan can
 * therefore leave `.pi/verify-cmd` out of every workstream, and the developer
 * still edits it, because nothing told the developer the path is off-limits;
 * the protected-path halt then parks the cycle after the whole develop spend.
 *
 * So each deferred path is appended to the `outOfScope` of every workstream
 * that does not declare it in its own `paths`, as the bare normalised path: the
 * scope gate then matches it exactly, and the develop prompt names it. A
 * workstream that declares the path itself is not fenced for it — a self-declared
 * fence is the contradiction the plan-time check rejects — and the protected-path
 * halt is the backstop for that shape. The "protected, no --allow-protected
 * grant" annotation is NOT part of the entry; the prompts render it from the
 * deferral list next to the fence (`fenceLines`).
 *
 * The deferred list is persisted on pipelineState (`deferredProtected`) by the
 * plan tail; develop and the corrective round read it from there.
 *
 * Idempotent: an entry already present (after `normaliseDeclaredPath`) is not
 * appended again, so a re-run of the plan tail adds nothing.
 */

import { neutraliseFenceEntry, quotedOutOfScope } from "./plan-workstream-schema.ts";
import { splitDeliverablePaths } from "./work-driver-deliverable-paths.ts";
import { type SpecCoverageSpec, protectedDeferralsOf } from "./work-driver-plan-spec-coverage.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import type { WorkState } from "./workflow-state.ts";

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
 * The workstreams map with each deferred path appended to the `outOfScope` of
 * every workstream that neither declares it in `paths` nor already fences it.
 * `deferred` is the list the plan tail computed once (`deferredProtectedPaths`)
 * and persists. Returns the input object itself when nothing is appended, so a
 * caller can tell the no-op apart.
 */
export function withDeferredProtectedFence(
  workstreams: Record<string, Workstream>,
  deferred: readonly string[],
): Record<string, Workstream> {
  if (deferred.length === 0) return workstreams;
  let changed = false;
  const out: Record<string, Workstream> = {};
  for (const [id, ws] of Object.entries(workstreams)) {
    const declared = new Set(ws.paths.map((e) => normaliseDeclaredPath(e)));
    const fenced = new Set(ws.outOfScope.map((e) => normaliseDeclaredPath(e)));
    const missing = deferred.filter((p) => !declared.has(p) && !fenced.has(p));
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
 * The one line a prompt renders beside the fence: which fenced entries are
 * protected with no grant. Empty when none of the fence is deferred.
 */
export function protectedFenceNote(
  outOfScope: readonly string[],
  deferred: readonly string[],
): string {
  const entries = protectedFenceEntries(outOfScope, deferred);
  if (entries.length === 0) return "";
  const shown = entries.map((e) => JSON.stringify(neutraliseFenceEntry(e))).join("; ");
  const one = entries.length === 1;
  return `**Protected, no --allow-protected grant** — ${shown} ${one ? "is a protected path" : "are protected paths"} this cycle may not change; an edit to ${one ? "it" : "one of them"} parks the cycle.`;
}

/**
 * The OUT OF SCOPE block a develop prompt (first or corrective) renders: the
 * fence line, then the protected note beside it when a fenced entry is deferred.
 * Empty when the workstream has no fence.
 */
export function fenceLines(outOfScope: readonly string[], deferred: readonly string[]): string[] {
  if (outOfScope.length === 0) return [];
  const note = protectedFenceNote(outOfScope, deferred);
  return [
    `**OUT OF SCOPE — do NOT touch**: ${quotedOutOfScope(outOfScope)}`,
    ...(note.length > 0 ? [note] : []),
  ];
}
