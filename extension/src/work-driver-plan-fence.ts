/**
 * work-driver-plan-fence — #1676: the deferred protected paths become a fence.
 *
 * The plan-to-spec gate (#1642) deliberately does not require a deliverable
 * whose path is protected and ungranted (`protectedDeferralsOf`). The plan can
 * therefore leave `.pi/verify-cmd` out of every workstream, and the developer
 * still edits it, because nothing told the developer the path is off-limits;
 * the protected-path halt then parks the cycle after the whole develop spend.
 *
 * So each deferred path is appended to the `outOfScope` of every workstream as
 * the bare normalised path: the scope gate then matches it exactly, and the
 * develop prompt names it. Fence wins over the plan's own listing: a deferred
 * path a workstream still lists in `paths` is removed from there, so the
 * developer is never told both to edit and not to touch the same file. The
 * "protected, no --allow-protected grant" annotation is NOT part of the entry;
 * the prompts render it from the deferral list next to the fence (`fenceLines`).
 * The protected-path gate is the backstop for an edit made anyway: it halts the
 * cycle with the `--allow-protected` command, as it does for any protected path.
 *
 * The deferred list is persisted on pipelineState (`deferredProtected`) by the
 * plan tail; develop and the corrective round read it from there. The develop
 * step reads it through `deferredForCycle`, the one place that knows the escape
 * hatch (`PI_ENSEMBLE_PROTECTED_PATHS=0`) disables the whole mechanism, so the
 * fence and the scope gate's fanout bound cannot disagree about whether it is on.
 *
 * Idempotent: an entry already present (after `normaliseDeclaredPath`) is not
 * appended again, so a re-run of the plan tail adds nothing. The append is
 * BOUNDED through the same cap as the other two fence writers (#1744): this is
 * the third writer of `outOfScope`, and an unbounded one could push a plan past
 * `WORKSTREAM_LIST_MAX` with no record of what it dropped.
 */

import {
  capFenceList,
  fenceBoundNotice,
  fenceWasBounded,
  quotedOutOfScope,
} from "./plan-fence-bound.ts";
import { clippedField } from "./plan-fence-record.ts";
import { neutraliseFenceEntry } from "./plan-fence-render.ts";
import { boundPaths } from "./plan-paths-bound.ts";
import { traceWarn } from "./trace.ts";
import { splitDeliverablePaths } from "./work-driver-deliverable-paths.ts";
import { protectedPathsEnabled } from "./work-driver-doctrine.ts";
import { type SpecCoverageSpec, protectedDeferralsOf } from "./work-driver-plan-spec-coverage.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { OutOfScopeClip } from "./workflow-state-schema-workstreams.ts";
import type { Workstream } from "./workflow-state-schema.ts";

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
 * The workstreams map with each deferred path removed from every workstream's
 * `paths` and appended to its `outOfScope` (unless already fenced there).
 * `deferred` is the list the plan tail computed once (`deferredProtectedPaths`)
 * and persists. Returns the input object itself when nothing changes, so a
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
    const paths = ws.paths.filter((e) => !deferred.includes(normaliseDeclaredPath(e)));
    const fenced = new Set(ws.outOfScope.map((e) => normaliseDeclaredPath(e)));
    const missing = deferred.filter((p) => !fenced.has(p));
    if (paths.length === ws.paths.length && missing.length === 0) {
      out[id] = ws;
      continue;
    }
    changed = true;
    // #1744 — the third writer of a fence list goes through the same bound as
    // the other two. The deferred paths are PREPENDED, for two reasons: the cap
    // is exactly where the two kinds of entry compete and a protected path the
    // developer was never told about is the worse loss; and it makes this call
    // IDEMPOTENT under a plan-tail re-run. Appending would let a deferred path
    // that missed the cut stay `missing`, so every re-run would re-add it, drop
    // it again, and add a fresh `cap` record for the same loss. Prepended, a
    // deferred path always lands, the next run finds nothing missing, and the
    // early `continue` above hands the caller the same object back — no second
    // record, no second warning. They go through the same CLIP as every other
    // entry, so no unbounded length reaches the state file, and what genuinely
    // did not fit is RECORDED and said out loud, never silently lost.
    const fence = capFenceList([...missing, ...ws.outOfScope], ws.outOfScopeClipped ?? []);
    // `capFenceList` reports the count; the CALLER owns the record (the doctrine
    // every fence writer follows). Here it can only be the workstream's OWN
    // tail that fell off — a deferred path is never the loser, because it is
    // prepended.
    if (fence.thisPass.cap > 0) {
      fence.clipped.push({ kind: "dropped", reason: "cap", count: fence.thisPass.cap });
    }
    if (fenceWasBounded(fence)) {
      traceWarn(fenceBoundNotice(`plan workstream '${id}' deferred protected fence`, fence));
    }
    const keptPaths = boundPaths(paths);
    out[id] = {
      ...ws,
      paths: keptPaths.paths,
      outOfScope: fence.entries,
      ...clippedField(fence.clipped),
    };
  }
  return changed ? out : workstreams;
}

/**
 * The deferred set a develop cycle acts on: the plan tail's persisted list, or
 * nothing when the protected-path escape hatch is off. It lives here rather than
 * at the call site because both readers of the deferred list — the fence note and
 * the scope gate's emptied-workstream bound (`work-driver-scope-fanout.ts`) — must
 * see one value. Reading the hatch in one of them only left the other halting a
 * cycle the first had been told to ignore.
 */
export function deferredForCycle(
  deferredProtected: readonly string[] | undefined,
): readonly string[] {
  return protectedPathsEnabled() ? (deferredProtected ?? []) : [];
}

/**
 * The one line a prompt renders beside the fence: which fenced entries are
 * protected with no grant. Empty when none of the fence is deferred. Entries
 * are matched on the normalised form, as the fence was written.
 */
export function protectedFenceNote(
  outOfScope: readonly string[],
  deferred: readonly string[],
): string {
  if (deferred.length === 0) return "";
  const set = new Set(deferred);
  const entries = outOfScope.filter((e) => set.has(normaliseDeclaredPath(e)));
  if (entries.length === 0) return "";
  const shown = entries.map((e) => JSON.stringify(neutraliseFenceEntry(e))).join("; ");
  const one = entries.length === 1;
  return `**Protected, no --allow-protected grant** — ${shown} ${one ? "is a protected path" : "are protected paths"} this cycle may not change; an edit to ${one ? "it" : "one of them"} parks the cycle.`;
}

/**
 * The OUT OF SCOPE block a develop prompt (first or corrective) renders: the
 * fence line, then the protected note beside it when a fenced entry is deferred.
 * Empty when the workstream has no fence.
 *
 * `clipped` is the workstream's #1744 record and is REQUIRED (`[]` when the
 * caller holds none): it is what makes a cut entry say so and what names the
 * entries the entry-count cap swallowed, in the same place the fence is read.
 */
export function fenceLines(
  outOfScope: readonly string[],
  deferred: readonly string[],
  clipped: readonly OutOfScopeClip[],
): string[] {
  if (outOfScope.length === 0) return [];
  const note = protectedFenceNote(outOfScope, deferred);
  return [
    `**OUT OF SCOPE — do NOT touch**: ${quotedOutOfScope(outOfScope, clipped)}`,
    ...(note.length > 0 ? [note] : []),
  ];
}
