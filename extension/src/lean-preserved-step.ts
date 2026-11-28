import { leanSpecifyPreservesEnabled } from "./lean-specify-preserves-switch.ts";
/**
 * lean-preserved-step — the preservation half of the `specify` step, kept outside the lean directory.
 *
 * `src/lean/` is held under a hard non-increase line cap, so a behaviour that needs logic of its own lives
 * here and the engine keeps only the call sites. The RULE and why each arm is sound are documented once, in
 * `lean/specify-preserves.ts`; nothing here reads git or the tree — it reads the rows the child submitted
 * and what the step's own red proof already said about each file.
 */

/** One submitted row, as far as this module cares: the criterion and its declaration. */
export interface PreservesRowInput {
  criterionId: string;
  preserves?: boolean;
}

/** One captured file, with the verdict the step's own proof reached for it. */
export interface ProvedFile {
  path: string;
  criterionId: string;
  /** The proof's classification; only `"red"` counts as a red. */
  kind: string;
  /** Did the row that declared this path declare it preserved, and earn the exemption? */
  preserves: boolean;
}

/** The criterion ids that declared `preserves: true`, switch-gated and deduplicated. */
export function preservedCriteria(rows: readonly PreservesRowInput[]): string[] {
  if (!leanSpecifyPreservesEnabled()) return [];
  const out: string[] = [];
  for (const row of rows) {
    if (row.preserves !== true) continue;
    if (!out.includes(row.criterionId)) out.push(row.criterionId);
  }
  return out;
}

/**
 * The paths a run with these proofs must freeze BEYOND its red files.
 *
 * A declared file whose proof came back not-red is the declaration's own claim — a criterion that states
 * behaviour which already holds has no red test to write — so it joins the contract as a must-pass file.
 * A declared criterion whose proof came back RED is an ordinary red test and the declaration changes nothing
 * about it, so a criterion with one red file contributes only that file.
 */
export function preservedFiles(files: readonly ProvedFile[]): string[] {
  const redIds = new Set(files.filter((f) => f.kind === "red").map((f) => f.criterionId));
  const out: string[] = [];
  for (const f of files) {
    if (f.kind === "red" || redIds.has(f.criterionId) || !f.preserves) continue;
    if (!out.includes(f.path)) out.push(f.path);
  }
  return out;
}
