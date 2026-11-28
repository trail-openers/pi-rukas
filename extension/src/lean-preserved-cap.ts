/**
 * lean-preserved-cap — the row-level half of the preservation declaration, kept outside the lean tree.
 *
 * The cap validator already owns which rows survive the size and path rules; this file owns only what the
 * declaration adds: that a kept criterion carries its declaration, and that a criterion which earned a real
 * red test is an ordinary red criterion whatever it declared (the rule is documented once in
 * `specify-preserves.ts`). Pure, so the validator keeps its own drop accounting untouched.
 */

/** One kept row as the caller rebuilds it: the criterion, its files, and the declaration if it earned one. */
export interface CapRow {
  criterionId: string;
  testFiles: string[];
  preserves?: boolean;
}

/**
 * The rows the step captures: files in submission order, each with `preserves` only where a kept row
 * declared it. An empty file list is not a row — "no tests" is a verdict the child did not give.
 */
export function keptCapRows(
  entries: readonly (readonly [string, readonly [string[], boolean]])[],
): CapRow[] {
  return entries
    .filter(([, held]) => held[0].length > 0)
    .map(([criterionId, [files, preserves]]) => ({
      criterionId,
      testFiles: files,
      ...(preserves ? { preserves: true } : {}),
    }));
}

/** Does one kept row declare its criterion as one that must keep holding? */
export function rowDeclaredPreserves(row: { preserves?: boolean }): boolean {
  return row.preserves === true;
}

/** The `isPreserved` probe the step asks per criterion, built once from the kept rows. */
export function declaredPreserved(
  rows: readonly { criterionId: string; preserves?: boolean }[],
): (criterionId: string) => boolean {
  const declared = new Map(rows.map((row) => [row.criterionId, rowDeclaredPreserves(row)]));
  return (criterionId: string): boolean => declared.get(criterionId) === true;
}
