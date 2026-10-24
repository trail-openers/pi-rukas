/**
 * work-driver-verify-tally — #1762: the CONSOLIDATED-only harvest of a script's
 * own tally block, where the names live one per line *beneath* the count.
 *
 * The defect. A project gate that reports
 *
 *     test.sh: failed checks (2), not run (0)
 *         lint
 *         test/b_test.sh
 *
 * puts the names on their own lines under the count, not inside it. The per-file
 * `FAILED:` marker carries the assertion; this block carries only the count and
 * two bare words. `assertionLines` had nothing to offer for it, so a consolidated
 * failure of that shape earned no corrective round and the developer was dispatched
 * with the tally alone.
 *
 * Why this is CONSOLIDATED-ONLY, and stays that way. On the per-worktree route the
 * harness's `formatExecError` wrapper flattens its window to a SINGLE line
 * (`… failed in <cwd>: <tail>`), so the indentation this harvest reads — the one
 * property that distinguishes a tally's name lines from the rest of a stream —
 * cannot survive into a per-worktree record's text. And the names are never
 * emitted alone: the joined line is `<tally>: <name>, <name>`, so it can only ever
 * replace a tally line that already classifies. Per-worktree therefore never
 * produces a joined tally line, and the harness cut in
 * `work-driver-verify-inner-line.ts` (`harnessInnerLine`, `harnessVerifyStream`,
 * `stripHarnessResidue`) is deliberately UNCHANGED — it is the reader that decides
 * what a human is SHOWN, and the harvest is a reader of the gate's raw text.
 *
 * Two rules the harvest obeys, both from #1762's misquote of a passing stage:
 *
 *   - **Indentation is measured BEFORE trimming.** "Deeper than the tally" is a
 *     fact about the raw line; a reader that trims first cannot see it and would
 *     harvest the whole stream.
 *   - **The harvest stops at the first failure.** A name line that classifies as a
 *     failure, or reports success, is not a name — so a stream that continues into
 *     its timing block (`  pack_release_test.sh   21.4s`) or into an `ok` line
 *     contributes nothing beyond the point where it stopped being a list.
 */

import {
  classifyFailureLine,
  isSuccessLine,
  scriptTallyCount,
} from "./work-driver-verify-failures.ts";
import { splitLines } from "./work-driver-verify-support.ts";

/** A name line's own shape: a bare token, nothing a runner prints a status with. */
const NAME_LINE_RE = /^[A-Za-z0-9_./-]+$/;

/** Leading-whitespace width of a raw line (the indentation, measured untrimmed). */
function indentOf(raw: string): number {
  let n = 0;
  while (n < raw.length && (raw[n] === " " || raw[n] === "\t")) n++;
  return n;
}

/**
 * Harvest every script-tally block in the consolidated stream into ONE evidence
 * line each: `<tally>: name, name`.
 *
 * @param raw the consolidated run's raw failure stream, read line by line with the
 *   indentation intact
 * @returns one joined line per tally that harvested at least one name, in stream
 *   order — `[]` when the stream holds no tally with names beneath it
 */
export function harvestConsolidatedTallies(raw: string): string[] {
  const out: string[] = [];
  const lines = splitLines(raw);
  for (let i = 0; i < lines.length; i++) {
    const rawTally = lines[i] ?? "";
    const tally = rawTally.trim();
    if (tally.length === 0) continue;
    const count = scriptTallyCount(tally);
    if (count === undefined || count <= 0) continue;
    const names: string[] = [];
    for (let k = i + 1; k < lines.length && names.length < count; k++) {
      const candidate = lines[k] ?? "";
      if (indentOf(candidate) <= indentOf(rawTally)) break;
      const name = candidate.trim();
      if (!NAME_LINE_RE.test(name)) break;
      if (classifyFailureLine(name) !== undefined) break;
      if (isSuccessLine(name)) break;
      names.push(name);
    }
    if (names.length > 0) out.push(`${tally}: ${names.join(", ")}`);
  }
  return out;
}
