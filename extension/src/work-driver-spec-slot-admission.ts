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
 *   - a slot with nothing literal to anchor it (a bare `*`, `**`, or a `*` in
 *     every segment): a bare wildcard is not an authorisation to change
 *     anything anywhere, so it admits NOTHING. Requiring a fully-literal
 *     segment is what keeps a root-level `*` from matching every root file and
 *     an all-wildcard path from matching the tree.
 *
 * Only PATTERN alternatives admit. A deliverable's concrete slot is already
 * what a plan declares and what the fences already compare; widening the
 * concrete half from the spec would let a deliverable authorise files no
 * workstream was scoped to.
 *
 * The matcher is the ONE the converge gate uses (`globMatchesSegments`, via
 * `toAlternative` / `splitDeliverablePaths` / `measurableAlternative` from
 * work-driver-deliverable-paths.ts): segment-anchored, so `*` consumes exactly
 * one path segment and `extension/src/review-ledger-*.ts` never reaches into a
 * subdirectory. A second wildcard grammar here would mean "the fence admits it"
 * and "converge counts it delivered" could disagree — the drift
 * work-driver-deliverable-paths.ts exists to prevent.
 */

import {
  globMatchesSegments,
  measurableAlternative,
  splitDeclaredSlots,
  splitDeliverablePaths,
  toAlternative,
} from "./work-driver-deliverable-paths.ts";

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

/**
 * Does this glob name anything at all? A pattern needs at least one segment
 * that is not a wildcard and carries a character — the anchor that makes it a
 * claim about a place in the tree rather than about the tree. A bare `*`, a
 * bare `**`, and a path whose every segment is a wildcard have none, so they
 * admit nothing; `extension/src/review-ledger-*.ts` anchors on `extension`
 * (and `src`).
 */
function hasLiteralAnchor(glob: string): boolean {
  return glob.split("/").some((seg) => !seg.includes("*") && /[A-Za-z0-9]/.test(seg));
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
  for (const d of spec?.deliverables ?? []) {
    const deliverableId = d.id ?? "?";
    for (const slot of splitDeclaredSlots(d.paths ?? [])) {
      // `measurableAlternative` is the converge gate's own judgeability answer
      // (shape gate + the filler-word list), so a slot of `n/a` or `tbd` never
      // becomes an authorisation, and plan time and develop time agree.
      for (const alt of splitDeliverablePaths(slot).map(toAlternative)) {
        if (!alt.isGlob) continue;
        if (!measurableAlternative(alt)) continue;
        if (!hasLiteralAnchor(alt.glob)) continue;
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
 */
export function specSlotAdmitting(
  slots: readonly SpecPatternSlot[],
  file: string,
): SpecPatternSlot | undefined {
  return slots.find((s) => globMatchesSegments(s.glob, file));
}
