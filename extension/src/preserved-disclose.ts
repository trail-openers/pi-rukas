/**
 * preserved-disclose — the clause that names the criteria a run PRESERVED, in the two places an
 * operator reads a run's contract: the handback comment and the PR body.
 *
 * It is deliberately a clause of its own, never folded into the `dropped` clause or into the tree-provision
 * caveat: a dropped file is a file the step refused, and a preserved file is one it froze on purpose. A
 * reader who cannot tell the two apart cannot tell a run that skipped a check from one that froze one.
 */
import { leanSpecifyPreservesEnabled } from "./lean-specify-preserves-switch.ts";
import { oneLine } from "./lean/text-fence.ts";

/** How many ids one clause names before it says `(+N more)`. */
const PRESERVED_CAP = 8;
/** How long one id may run before the clause clips it. */
const PRESERVED_ID_MAX = 40;

/** The ids worth printing, or `[]` when there is nothing to disclose (off, or none declared). */
export function preservedIds(preserved: readonly string[] | undefined): string[] {
  if (!leanSpecifyPreservesEnabled()) return [];
  return (preserved ?? []).filter((id) => typeof id === "string" && id.trim() !== "");
}

/** The frozen files of those criteria, when the caller has the criterion -> files map at hand. */
export function preservedFiles(
  preserved: readonly string[],
  tests: Record<string, string[]> | undefined,
): string[] {
  const out: string[] = [];
  for (const id of preserved) for (const f of tests?.[id] ?? []) if (!out.includes(f)) out.push(f);
  return out;
}

/**
 * One sentence naming the preserved criteria and their files: `preserved 2: AC4 tests/AC4-guard.test.sh
 * (must pass at head)`. Empty for nothing to disclose, so a call site can splice it unconditionally.
 */
export function preservedClause(
  preserved: readonly string[] | undefined,
  tests?: Record<string, string[]>,
): string {
  const ids = preservedIds(preserved);
  if (ids.length === 0) return "";
  const shown = ids.slice(0, PRESERVED_CAP).map((id) => oneLine(id, PRESERVED_ID_MAX));
  const more = ids.length - shown.length;
  const files = preservedFiles(ids, tests).map((f) => oneLine(f, 120));
  return `preserved ${String(ids.length)}: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}${files.length === 0 ? "" : ` (${files.join(", ")})`}; each is frozen and must pass at head`;
}
