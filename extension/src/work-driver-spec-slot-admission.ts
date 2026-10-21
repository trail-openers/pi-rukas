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
 *
 * #1725 round 3 adds three things, all aimed at "an authorisation is a budget,
 * not a skeleton key":
 *
 *   - ONE fence predicate: the admitter takes `isFenced` as INPUT and refuses
 *     a fenced file itself, so the fix fence and the develop gate cannot drift
 *     on what "fenced" means (both now delegate to `fenceMatches`);
 *   - a per-slot file cap (`SPEC_SLOT_MAX_FILES`): one slot admits at most
 *     three files per workstream, and the fan-out DENOMINATOR grows by the
 *     number of distinct admitting SLOTS — not by the file count. A workstream
 *     can no longer multiply one authorisation into an unbounded bound; the
 *     fourth file under a slot is refused (`slot-full`) and is undeclared
 *     exactly as before admission existed;
 *   - disclosure with teeth: `admit` returns a discriminated result naming the
 *     refusal kind (`fenced` | `protected` | `no-slot` | `slot-full`), the fix
 *     pass's park reason carries it, and every admitted pair emits one note
 *     built by the SHARED `admissionNote` — a note that widened a fence
 *     invisibly was the review's HIGH finding.
 *
 * DeliverableId and slot text are developer-adjacent prose that reaches a
 * trace line or an operator note; `sanitizeSlotText` strips control characters
 * and caps at 120 chars before interpolation, and only the VALIDATED glob form
 * (`slot.glob`, already through `measurableAlternative` + `isAdmissibleSlot`)
 * is ever interpolated.
 */

import { hasPathspecChar } from "./plan-path-shape.ts";
import { trace } from "./trace.ts";
import { fenceMatches } from "./work-driver-declared-path.ts";
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

/**
 * The per-slot file cap (#1725 round 3): one pattern slot authorises AT MOST
 * this many files for one workstream. The bound the fan-out check exists to
 * enforce must not grow with the number of admitted FILES — a workstream that
 * splits one module into ten files under one slot pattern would otherwise buy
 * ten units of bound while the spec authorised one authorisation. The
 * denominator therefore grows per distinct ADMITTING SLOT, and the fourth file
 * under the same slot is refused and lands undeclared, exactly as before the
 * admission existed. Three is the compromise: a 500-line module split (the
 * ratchet shape that produced the #1557 incident) reaches four sibling files
 * only when the spec named them elsewhere or the plan declared them.
 */
export const SPEC_SLOT_MAX_FILES = 3;

/**
 * Display sanitisation for the two untrusted strings an admission carries:
 * the deliverable id and the slot text, both model-authored spec prose that
 * reaches a trace line or an operator note verbatim. Control characters go
 * (an ESC sequence in a note is terminal injection), and the text caps at 120
 * chars with a visible marker — a slot cannot smuggle a paragraph into the
 * handoff. The interpolated GLOB is validated (`measurableAlternative` +
 * `isAdmissibleSlot` ran on it at slot build), so what the note shows is the
 * matcher's own input.
 */
export function sanitizeSlotText(text: string, max = 120): string {
  // \p{Cc} is the control-character class (C0 + C1) — written as a class
  // rather than literals so the source carries no control characters and
  // biome's noControlCharactersInRegex stays honest.
  const clean = text.replace(/[\p{Cc}]/gu, "");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Why an admission was refused — the fix-pass park reason names this kind. */
export type AdmissionRefusal = "fenced" | "protected" | "no-slot" | "slot-full";

/** The admitter's discriminated answer, so disclosure can name the refusal. */
export type Admission =
  | { admitted: true; slot: SpecPatternSlot }
  | { admitted: false; refused: AdmissionRefusal };

/** One gate's admission question, answered once per (workstream, file). */
export interface SpecAdmitter {
  /** Decide `file` for workstream `id`. Memoised: one decision, one note. */
  admit(id: string, file: string, declared: readonly string[]): Admission;
  /** Distinct slots that admitted ≥1 file for `id` — the fan-out growth. */
  admittedSlotCount(id: string): number;
  /** The files `id` was admitted, in admission order (for park disclosure). */
  admittedFiles(id: string): string[];
}

/**
 * The gate-side half of admission, shared by the develop gate and the fix
 * fence so the two cannot drift on the three things that keep a slot from
 * being a skeleton key, IN THIS ORDER (each refusal kind is observable in the
 * discriminated result, so a park reason can say which one stopped the file):
 *
 *   1. `isFenced` (the caller's fence predicate — both gates now run
 *      `fenceMatches`, the ONE fence predicate, so "fenced" means the same
 *      thing at both); the spec never unfences a path the plan fenced;
 *   2. a protected path (the protected gate owns that halt; admitting here
 *      would only rename it);
 *   3. no slot matches / the workstream's scope does not reach the slot's
 *      directory → `no-slot`; a slot that matched but already admitted
 *      `SPEC_SLOT_MAX_FILES` files for this workstream → `slot-full`.
 *
 * ONE trace line and ONE `onAdmit` call per admitted (workstream, file) — the
 * audit trail an operator reads. A fence that widened invisibly is the failure
 * class #1522 was written about.
 */
export function createSpecAdmitter(opts: {
  slots: readonly SpecPatternSlot[];
  /** The trace prefix naming the gate asking (`scope-fence`, `fix pass`). */
  source: string;
  /** The asking gate's fence, judged FIRST — a fenced file is never admitted. */
  isFenced?: (id: string, file: string) => boolean;
  /** Called once per admitted (workstream, file) — the gate's own disclosure. */
  onAdmit?: (id: string, file: string, slot: SpecPatternSlot) => void;
}): SpecAdmitter {
  const decisions = new Map<string, Admission>();
  // Per workstream: which slots admitted which files. The fan-out denominator
  // counts these SLOTS, never the files (#1725 round 3).
  const byWorkstream = new Map<string, Map<string, Set<string>>>();
  const slotKey = (s: SpecPatternSlot) => `${s.deliverableId}|${s.glob}`;
  const filesFor = (id: string, slot: SpecPatternSlot): Set<string> => {
    let perWs = byWorkstream.get(id);
    if (!perWs) {
      perWs = new Map();
      byWorkstream.set(id, perWs);
    }
    let files = perWs.get(slotKey(slot));
    if (!files) {
      files = new Set();
      perWs.set(slotKey(slot), files);
    }
    return files;
  };
  return {
    admit(id, file, declared) {
      const memoKey = `${id}|${file}`;
      const known = decisions.get(memoKey);
      if (known) return known;
      let decision: Admission;
      if (opts.isFenced?.(id, file)) {
        decision = { admitted: false, refused: "fenced" };
      } else if (protectedPathsIn([file]).length > 0) {
        decision = { admitted: false, refused: "protected" };
      } else {
        const slot = specSlotAdmitting(opts.slots, file, declared);
        if (!slot) {
          decision = { admitted: false, refused: "no-slot" };
        } else {
          const files = filesFor(id, slot);
          if (files.size >= SPEC_SLOT_MAX_FILES) {
            decision = { admitted: false, refused: "slot-full" };
          } else {
            files.add(file);
            decision = { admitted: true, slot };
            trace(
              `${opts.source}: ${id} admitted ${file} — the spec's deliverable ${sanitizeSlotText(slot.deliverableId)} declares the pattern slot ${sanitizeSlotText(slot.glob)}`,
            );
            opts.onAdmit?.(id, file, slot);
          }
        }
      }
      decisions.set(memoKey, decision);
      return decision;
    },
    admittedSlotCount(id) {
      let n = 0;
      for (const files of byWorkstream.get(id)?.values() ?? []) if (files.size > 0) n++;
      return n;
    },
    admittedFiles(id) {
      const out: string[] = [];
      for (const files of byWorkstream.get(id)?.values() ?? []) out.push(...files);
      return out;
    },
  };
}

/** The shared admission note (#1725 round 3): one line per admitted pair,
 *  built once so both gates disclose the SAME text. Untrusted spec prose goes
 *  through `sanitizeSlotText`. */
export function admissionNote(id: string, file: string, slot: SpecPatternSlot): string {
  return `workstream ${id} changed ${file} — admitted by the spec's deliverable ${sanitizeSlotText(slot.deliverableId)} pattern slot ${sanitizeSlotText(slot.glob)} (authorised, counts toward the fan-out bound)`;
}

/**
 * The gate-side wiring both fences used to duplicate (and then drift): slots
 * from the spec, the fence judgement through the ONE fence predicate
 * (`fenceMatches` — the same one the fix fence's `fencedBy` runs, so a raw
 * `outOfScope` entry cannot refuse one gate and pass the other), and the
 * shared note into the gate's own `notes`. Kept here so the develop gate's
 * file budget holds (#1725 round 3: the wiring moved OUT of
 * `work-driver-scope-fanout.ts`, which sits at the size cap) and so a future
 * third gate composes the same four pieces.
 */
export function createGateAdmitter(opts: {
  spec: SpecSlotSource | undefined;
  source: string;
  /** The gate's non-blocking note sink — the PR body's admission trail. */
  notes: string[];
  /** The workstream's RAW `outOfScope` fence entries. */
  outOfScopeOf: (id: string) => readonly string[];
  /** The workstream's own declared paths, bound into `admit`. */
  declaredOf: (id: string) => readonly string[];
}): {
  admit(id: string, file: string): Admission;
  admittedSlotCount(id: string): number;
  admittedFiles(id: string): string[];
} {
  const admit = createSpecAdmitter({
    slots: specPatternSlots(opts.spec),
    source: opts.source,
    isFenced: (id, file) => opts.outOfScopeOf(id).some((entry) => fenceMatches(entry, file)),
    onAdmit: (id, file, slot) => opts.notes.push(admissionNote(id, file, slot)),
  });
  return {
    admit: (id, file) => admit.admit(id, file, opts.declaredOf(id)),
    admittedSlotCount: (id) => admit.admittedSlotCount(id),
    admittedFiles: (id) => admit.admittedFiles(id),
  };
}
