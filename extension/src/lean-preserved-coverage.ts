/**
 * lean-preserved-coverage — what the `specify` step must freeze once a run declared criteria preserved.
 *
 * The sibling `lean-preserved-step.ts` reads the submitted rows; this file reads the step's own proof
 * verdicts and answers the questions the engine would otherwise compute inline, under the lean line cap:
 * which files the proof pass deletes rather than refuses, which files join the contract beyond the red
 * ones, which ids the run may name, and which ids it still owes a red. Nothing here reads git or the
 * tree, and the rule each arm implements is documented once in `specify-preserves.ts`.
 *
 * Every entry is PURE — the engine keeps the loop, the runner call and the deletes, and asks this file
 * only for verdicts, so a caller cannot accidentally skip the side effect a step owes.
 */
import type { DeclaredPath } from "./lean/specify-tree.ts";
import type { ProvedFile } from "./lean-preserved-step.ts";
import { preservedCriteria, preservedFiles } from "./lean-preserved-step.ts";

/** One path's proof verdict, as the caller read it. */
export type ProvedKind = Pick<ProvedFile, "kind">;

/** One submitted row, as far as these verdicts care: the criterion and its declaration. */
export interface CoverageRow {
  criterionId: string;
  preserves?: boolean;
}

export interface PreservedCoverageInput {
  /** Every declared candidate, in the order the child submitted them. */
  candidates: readonly DeclaredPath[];
  /** The proof's verdict per path, from the one proof pass the step already ran. */
  kinds: ReadonlyMap<string, ProvedKind>;
  /** The kept rows' declarations, so `preservedIds` reports only what a child really declared. */
  rows: readonly CoverageRow[];
  /** The ids `all-criteria` coverage asked for. */
  wanted: readonly string[];
}

export interface PreservedCoverage {
  /** Paths to commit BEYOND the red ones: a declared file that is green at the base. */
  mustPass: string[];
  /** Every file the frozen contract holds: red plus must-pass, in candidate order. */
  contract: DeclaredPath[];
  /** The criteria the run preserved, deduplicated, in candidate order. */
  preservedIds: string[];
  /** The ids still owed a red file, once the preserved ones are excused. */
  missing: string[];
}

/**
 * Does a declared file the proof refused still earn its keep? Only when NO file of its criterion proved
 * red: a criterion with a real red is an ordinary red test, so a second, green file under the same
 * declaration is a file the step never froze. Asked after the proof, so a file whose own criterion failed
 * already counts.
 */
export function preservedKeepsFile(
  candidates: readonly DeclaredPath[],
  kinds: ReadonlyMap<string, ProvedKind>,
  cand: DeclaredPath,
): boolean {
  return candidates.some(
    (c) => c.criterionId === cand.criterionId && kinds.get(c.path)?.kind === "red",
  );
}

/**
 * The coverage computation for a run that may have declared preservation. `red` is what the proof pass
 * returned; the must-pass set is decided from ALL verdicts at once, so a green file under a criterion that
 * has a real red is an ordinary refusal and is deleted like any other green.
 */
export function preservedCoverage(input: PreservedCoverageInput): PreservedCoverage {
  const { candidates, kinds, rows, wanted } = input;
  const declared = new Set(rows.filter((r) => r.preserves === true).map((r) => r.criterionId));
  const red = new Set<string>();
  const provedFiles: ProvedFile[] = [];
  for (const c of candidates) {
    const kind = kinds.get(c.path)?.kind;
    if (kind === undefined) continue; // dropped at capture — never proved, never kept
    provedFiles.push({
      path: c.path,
      criterionId: c.criterionId,
      kind,
      preserves: declared.has(c.criterionId),
    });
    if (kind === "red") red.add(c.path);
  }
  const mustPass = new Set(preservedFiles(provedFiles));
  const contract: DeclaredPath[] = [];
  const covered: CoverageRow[] = [];
  for (const c of candidates) {
    if (!red.has(c.path) && !mustPass.has(c.path)) continue;
    contract.push(c);
    covered.push({ criterionId: c.criterionId, preserves: declared.has(c.criterionId) });
  }
  const held = new Set(contract.map((c) => c.criterionId));
  return {
    mustPass: [...mustPass],
    contract,
    preservedIds: preservedCriteria(covered),
    missing: wanted.filter((id) => !held.has(id)),
  };
}

/** Is every criterion the spec asked for one this run preserved? Then there is nothing to build. */
export function allPreserved(wanted: readonly string[], preserved: readonly string[]): boolean {
  return wanted.length > 0 && wanted.every((id) => preserved.includes(id));
}

/** A declaration of the wrong type is a malformed call, counted with the skipped-call accounting. */
export function malformedDeclarations(rows: readonly CoverageRow[]): number {
  return rows.filter((r) => r.preserves !== undefined && typeof r.preserves !== "boolean").length;
}
