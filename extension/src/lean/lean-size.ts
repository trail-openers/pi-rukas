/**
 * lean/lean-size — the counter and the ceiling behind `test-lean-size-cap.ts`.
 *
 * The counter lives in the tree it measures so the fixture cases can prove the
 * `wc -l` recursion, the symlink refusal and the fail-closed throws against the
 * code that runs in CI, rather than against a copy of it in the test file.
 */

import { type Dirent, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** The operator's ceiling for the whole directory, held as a literal the gate reads. */
export const HARD_CAP = 28_000;
/** The directory under the cap: every `.ts` file at any depth. */
export const LEAN_DIR = path.join("src", "lean");

/** A counting failure: the tree could not be measured, so no verdict is honest. */
export class LeanCountError extends Error {}

/** Newline count — `wc -l` semantics for a terminated file of N lines. */
function lineCount(file: string): number {
  return (readFileSync(file, "utf8").match(/\n/g) ?? []).length;
}

/**
 * Total lines across every `.ts` file under `root`/src/lean, at any depth. A
 * symlinked directory is never followed: a link out of the tree pulls in files
 * that are not lean, or loops. An unreadable directory or file throws — counting
 * what was never measured as 0 is how a size gate starts reporting confidently.
 */
export function leanTotal(root: string): { total: number; files: number } {
  let total = 0;
  let files = 0;
  const fail = (target: string, err: unknown) =>
    new LeanCountError(`${target} is not readable: ${(err as { code?: string }).code ?? err}`);
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw fail(dir, err);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        try {
          total += lineCount(full);
        } catch (err) {
          throw fail(full, err);
        }
        files++;
      }
    }
  };
  walk(path.join(root, LEAN_DIR));
  return { total, files };
}

/** The cap violation, or null when the tree fits. */
export function checkLeanLines(total: number, cap = HARD_CAP): string | null {
  if (total <= cap) return null;
  return `extension/src/lean is ${total} lines, over the ${cap}-line hard cap by ${total - cap} — the cap is the operator's ceiling and no gate file lifts it: delete code instead`;
}
