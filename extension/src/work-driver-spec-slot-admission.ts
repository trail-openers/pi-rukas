/**
 * work-driver-spec-slot-admission — a spec deliverable's PATTERN slot is an
 * authorisation to CREATE a file that matches it (#1557, epic #1642).
 *
 * The incident this closes (measurement run 6b, cycle 1557 on 2026-10-21):
 * the spec's d1 declared four concrete files plus the slot
 * `extension/src/review-ledger-*.ts` — the split the AGENTS.md §12 500-line
 * ratchet forces, and the shape PR #1707 just exempted from the plan-to-spec
 * gate because `plannedPathProblem` refuses a glob in a `report_workstream`
 * `paths` entry, so no plan may ever name one. The adversarial fix pass then
 * created `extension/src/review-ledger-pass.ts` and parked:
 *
 *   default changed extension/src/review-ledger-pass.ts — outside its declared
 *   paths and the files the findings name … a named file widens only when it is
 *   tracked at base, unprotected, and in the directory of a declared or
 *   already-changed non-root path
 *
 * Three of those four conditions a NEW file cannot satisfy, and none of them
 * can ever consult the spec: the finding-named widening reads
 * `trackedPaths(…, baseSha)`, so a file the pass created is invisible to it,
 * and both fences compare declared paths with exact / directory-prefix string
 * equality — `allows()` and `matchesScopePath()` have no wildcard at all. So
 * the spec authorised the file, the plan was forbidden from declaring it, and
 * the fence refused it: the ratchet that forced the split, the plan schema that
 * refuses the slot, and a fence that reads neither.
 *
 * The rule this module implements, narrow on purpose:
 *
 *   A changed path (new OR tracked) that matches a spec deliverable's PATTERN
 *   slot is in scope, exactly as a declared path is.
 *
 * What stays refused, and stays refused by the CALLERS rather than here, so
 * each fence keeps its own precedence and its own park reason:
 *
 *   - a path inside that workstream's `outOfScope` fence (the fence wins —
 *     the spec never overturns a fence the plan wrote against it);
 *   - a protected path (`.github/`, `.pi/`, `CODEOWNERS`, `agents.json`) — the
 *     protected-path gate still halts the cycle;
 *   - a slot that is a DIRECTORY claim rather than a FILE claim — `dir/*`,
 *     `dir/**`, `dir/*.ts` (PR #1725 round 2): the last segment carries no
 *     literal stem, so the slot authorises everything in a directory, which is
 *     how a slot emptied the fan-out numerator without authorising one named
 *     file. A bare `*`/`**` and an all-wildcard path have the same defect.
 *   - a slot the asking workstream was never scoped to (#1725 round 2): the
 *     caller passes THAT workstream's declared paths, and the slot's literal
 *     directory must contain one of them. Without that, one workstream's
 *     deliverable widens a sibling's fence — the exact shape the per-workstream
 *     fences exist to prevent.
 *
 * Only PATTERN alternatives admit. A deliverable's concrete slot is already
 * what a plan declares and what the fences already compare; widening the
 * concrete half from the spec would let a deliverable authorise files no
 * workstream was scoped to. "Pattern" is asked of the ONE shared predicate
 * (`hasPathspecChar`, the clause `plannedPathProblem` refuses with `* ? !`),
 * never of `toAlternative`'s `isGlob` — which reads only `*` and would hand a
 * `?`/`!` slot to the matcher as if it were concrete.
 *
 * The matcher is the ONE the converge gate uses (`globMatchesSegments`, via
 * `toAlternative` / `splitDeliverablePaths` / `measurableAlternative` from
 * work-driver-deliverable-paths.ts): segment-anchored, so `*` consumes exactly
 * one path segment and `extension/src/review-ledger-*.ts` never reaches into a
 * subdirectory. A second wildcard grammar here would mean "the fence admits it"
 * and "converge counts it delivered" could disagree — the drift
 * work-driver-deliverable-paths.ts exists to prevent.
 */

import { hasPathspecChar } from "./plan-path-shape.ts";
import { trace } from "./trace.ts";
import {
  globMatchesSegments,
  measurableAlternative,
  splitDeclaredSlots,
  splitDeliverablePaths,
  toAlternative,
} from "./work-driver-deliverable-paths.ts";
import { protectedPathsIn } from "./work-driver-doctrine.ts";

/** One pattern alternative of one deliverable's `[paths:]` slot. */
export interface SpecPatternSlot {
  /** The deliverable that declared it — carried so the trace names its source. */
  deliverableId: string;
  /** The slot as the spec declared it (annotation-stripped, wildcard kept). */
  slot: string;
  /** The glob form (`<name>` → `*`) the matcher runs. */
  glob: string;
}

/** A deliverable's `[id, paths]` pair — the structural subset this module reads. */
export interface SpecSlotDeliverable {
  id?: string;
  paths?: readonly string[] | undefined;
}

/** The shape the caller hands in: a spec's deliverables, or none. */
export interface SpecSlotSource {
  deliverables?: readonly SpecSlotDeliverable[] | undefined;
}

/** The directory a slot authorises files IN — its literal directory prefix
 *  (`extension/src` for `extension/src/review-ledger-*.ts`; `""` at the root). */
function slotDirectory(glob: string): string {
  const i = glob.lastIndexOf("/");
  return i < 0 ? "" : glob.slice(0, i);
}

/**
 * Does the slot's LAST segment name a file, or the whole directory?
 *
 * `review-ledger-*.ts` and `work-driver-<name>.ts` claim one family of files;
 * `dir/*`, `dir/**` and `dir/*.ts` claim every file in `dir`, which is a
 * directory authorisation the slot grammar was never meant to grant — and the
 * shape that emptied the fan-out numerator while authorising no named file
 * (PR #1725 round 2). The test is the segment's STEM, extension dropped: a
 * `*` in the stem is fine (`review-ledger-*`), a stem that is nothing but
 * wildcards is not.
 */
function lastSegmentNamesAFile(glob: string): boolean {
  const base = glob.slice(glob.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return /[A-Za-z0-9]/.test(stem.replace(/[*?!]/g, ""));
}

/**
 * Is this glob an authorisation at all? Three things, all fail-closed:
 *
 *   1. it must carry a pathspec character (`* ? !`) — else it is a CONCRETE
 *      path, which the fences already compare and the spec widens nothing by;
 *      `toAlternative` has already rewritten a `<name>` template to `*`, so the
 *      one predicate covers both spellings;
 *   2. its DIRECTORY must be literal — a wildcarded directory (a slot whose
 *      parent segments carry a `*`) matches a file in every directory of the
 *      tree, and no workstream's
 *      declared paths can scope it;
 *   3. its LAST segment must name a file, not a directory (see
 *      {@link lastSegmentNamesAFile}).
 */
function isAdmissibleSlot(glob: string): boolean {
  if (!hasPathspecChar(glob)) return false;
  const dir = slotDirectory(glob);
  if (dir !== "" && hasPathspecChar(dir)) return false;
  return lastSegmentNamesAFile(glob);
}

/**
 * Does this workstream's declared scope reach the slot's directory? A slot
 * authorises files in ONE named directory; a workstream that declared nothing
 * there was never asked to work there, and its sibling's deliverable is not its
 * scope. A root-level slot (directory `""`) is reached by a root-declared path.
 */
function scopeReachesSlotDirectory(declared: readonly string[], glob: string): boolean {
  const dir = slotDirectory(glob);
  if (dir === "") return declared.some((d) => !d.includes("/"));
  return declared.some((d) => d === dir || d.startsWith(`${dir}/`));
}

/**
 * Every pattern slot the spec's deliverables declare, in declaration order,
 * deduped per (deliverable, glob). Concrete alternatives, filler slots (`n/a`)
 * and unanchored wildcards are left out at the source, so a caller that asks
 * "does any slot admit this path?" is asking only about real authorisations.
 *
 * Read the spec from DRIVER STATE (`pipelineState.normalisedSpec`) — never
 * from issue prose at the fence. The prose is untrusted input a workstream
 * authors; the spec the intent resolver validated is the cycle's contract.
 */
export function specPatternSlots(spec: SpecSlotSource | undefined): SpecPatternSlot[] {
  const out: SpecPatternSlot[] = [];
  const seen = new Set<string>();
  // The spec arrives from a persisted state file: a hand-edited or half-written
  // `normalisedSpec` is prose, not a contract. Malformed shape yields NO slots
  // rather than throwing — a fence whose reading crashed used to fall back to
  // "nothing is authorised", which is the fail-closed answer this function can
  // give on its own.
  const deliverables = spec?.deliverables;
  if (!Array.isArray(deliverables)) return out;
  for (const d of deliverables) {
    if (typeof d !== "object" || d === null) continue;
    const deliverableId = typeof d.id === "string" && d.id.length > 0 ? d.id : "?";
    const declared = d.paths;
    const paths: string[] = Array.isArray(declared)
      ? (declared as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    for (const slot of splitDeclaredSlots(paths)) {
      // `measurableAlternative` is the converge gate's own judgeability answer
      // (shape gate + the filler-word list), so a slot of `n/a` or `tbd` never
      // becomes an authorisation, and plan time and develop time agree.
      for (const alt of splitDeliverablePaths(slot).map(toAlternative)) {
        if (!measurableAlternative(alt)) continue;
        if (!isAdmissibleSlot(alt.glob)) continue;
        const key = `${deliverableId}|${alt.glob}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ deliverableId, slot, glob: alt.glob });
      }
    }
  }
  return out;
}

/**
 * Which slot admits `file`? `undefined` when none does, so the caller keeps
 * its own park reason and its own wording. Segment-anchored: a `*` never spans
 * a `/` (the matcher's own guarantee, not a re-implementation).
 *
 * `declared` is the ASKING workstream's declared paths: a slot admits a file
 * only for the workstream whose scope already reaches the slot's directory,
 * so a sibling's deliverable cannot widen this one (#1725 round 2).
 */
export function specSlotAdmitting(
  slots: readonly SpecPatternSlot[],
  file: string,
  declared: readonly string[],
): SpecPatternSlot | undefined {
  return slots.find(
    (s) => globMatchesSegments(s.glob, file) && scopeReachesSlotDirectory(declared, s.glob),
  );
}

/** One gate's admission question, answered once per (workstream, file). */
export interface SpecAdmitter {
  admits(id: string, file: string, declared: readonly string[]): boolean;
}

/**
 * The gate-side half of admission, shared by the develop gate and the fix
 * fence so the two cannot drift: the protected-path refusal (the protected
 * gate owns that halt; admitting here would only rename it), the per-workstream
 * scope check, ONE trace line per admitted pair, and an optional non-blocking
 * audit note for whatever the gate shows the operator.
 */
export function createSpecAdmitter(opts: {
  slots: readonly SpecPatternSlot[];
  /** The trace prefix naming the gate asking (`scope-fence`, `fix pass`). */
  source: string;
  /** Called once per admitted (workstream, file) — the gate's own disclosure. */
  onAdmit?: (id: string, file: string, slot: SpecPatternSlot) => void;
}): SpecAdmitter {
  const seen = new Set<string>();
  return {
    admits(id, file, declared) {
      if (protectedPathsIn([file]).length > 0) return false;
      const slot = specSlotAdmitting(opts.slots, file, declared);
      if (!slot) return false;
      const key = `${id}|${file}`;
      if (!seen.has(key)) {
        seen.add(key);
        trace(
          `${opts.source}: ${id} admitted ${file} — the spec's deliverable ${slot.deliverableId} declares the pattern slot ${slot.slot}`,
        );
        opts.onAdmit?.(id, file, slot);
      }
      return true;
    },
  };
}
