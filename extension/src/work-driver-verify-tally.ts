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
 * Why this is CONSOLIDATED-ONLY, and stays that way. The single reason is the
 * CALLER: {@link harvestConsolidatedTallies} has exactly one production reader,
 * `consolidatedAssertionLines` in `work-driver-verify-record.ts` — the route that
 * holds the consolidated run's RAW gate stream. The per-worktree route goes
 * through `assertionLines`, and `formatExecError` does NOT guarantee a one-line
 * record: when the tail fits its window the wrapper KEEPS the tail's newlines and
 * indentation (pinned by the tally-last case of the shape suite), so the
 * indentation this harvest reads can and does survive into a per-worktree record.
 * Harvesting there read a tally block out of harness prose and emitted a SECOND
 * evidence line opening with the harness's own sentence, costing a
 * `CORRECTIVE_MAX_LINES` slot for text the gate never printed. So the route is
 * decided by the reader that knows which route it is on, not by a property of the
 * wrapper, and the harness cut in `work-driver-verify-inner-line.ts`
 * (`harnessInnerLine`, `harnessVerifyStream`, `stripHarnessResidue`) is deliberately
 * UNCHANGED — it is the reader that decides what a human is SHOWN, and the harvest
 * is a reader of the gate's raw text.
 *
 * Cost, and the two bounds that hold it. A tally's `N` is text from the gate, so
 * the harvest may not cost what it reports: a `failed checks (999999)` line with
 * a million indented tokens used to walk all of them and build a million-name
 * join. So (a) a candidate name line longer than {@link TALLY_NAME_LINE_MAX}
 * stops the harvest — no runner prints a test name as a document, and the line
 * the classifier is asked on is bounded before it is asked; and (b) at most
 * {@link TALLY_NAMES_MAX} names are kept per tally, independent of the printed
 * count, with the cut reported as ` (+K more)`.
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
 *   - **The joined names never exceed {@link TALLY_JOIN_MAX},** which is half the
 *     record's {@link ASSERTION_LINE_MAX} so the tally prefix and the disclosure fit
 *     inside it whatever the gate printed as the count.
 */

import { looksLikeCredential } from "./work-driver-verify-assertion.ts";
import {
  classifyFailureLine,
  isSuccessLine,
  scriptTallyCount,
} from "./work-driver-verify-failures.ts";
import { splitLines } from "./work-driver-verify-support.ts";

/** A name line's own shape: a bare token, nothing a runner prints a status with. */
const NAME_LINE_RE = /^[A-Za-z0-9_./-]+$/;

/**
 * The longest candidate line the harvest will even LOOK at. `NAME_LINE_RE` is
 * linear, but the classifier asks several patterns with `[^\r\n]*`-style
 * branches, and a name line is text from the gate: a 100 KB token must stop the
 * walk, not be classified. A real test name is a path or an identifier — nothing
 * a runner prints is anywhere near this long.
 */
const TALLY_NAME_LINE_MAX = 128;

/**
 * The most names one tally contributes, whatever its printed count says. The
 * joined line is evidence in a corrective-round prompt, not a report; past this
 * the extra names add cost and no diagnosis. The remainder is reported as
 * ` (+K more)` so the evidence does not silently understate the tally.
 */
const TALLY_NAMES_MAX = 20;

/**
 * The most one joined tally line may carry — the NAMES half of it. The record's
 * own evidence bound is {@link ASSERTION_LINE_MAX}; the tally prefix and the
 * ` (+K more)` disclosure also live on that line, and both are sized by the
 * tally's PRINTED count, which is text from the gate — a `failed checks
 * (1000000)` line makes the suffix 9 characters longer and an 8 KiB prefix
 * possible. So the join is capped at HALF the evidence bound: that leaves 250
 * characters for prefix and suffix (a count is never realistically printed with
 * more than ~240 digits), and the record's `push` redacts and clips the whole
 * line to {@link ASSERTION_LINE_MAX} whatever the gate printed around it.
 */
const TALLY_JOIN_MAX = 250;

/** The bound the record applies to every stored verify line, mirrored here. */
const ASSERTION_LINE_MAX = 500;

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
 * THE CONTRACT OF THE WALK, stated once: a candidate stops the harvest, and the
 * tally keeps whatever it gathered up to that point. A candidate is refused when
 * it is no deeper than the tally, when its trimmed form is not a bare token, when
 * it is longer than {@link TALLY_NAME_LINE_MAX}, when it is credential-shaped, or
 * when the classifier recognises it as a failure or a passing line. There is no
 * second "is this still a tally line" test after that walk: the walk stopping is
 * the whole answer, and the joined line is emitted iff at least one name survived
 * it — so no further count or emptiness check is kept here.
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
    if (count === undefined) continue;
    const names: string[] = [];
    // The join is built as we go so the bound is checked against the text that
    // would actually be emitted, not against a count.
    let joined = "";
    for (let k = i + 1; k < lines.length && names.length < count; k++) {
      const candidate = lines[k] ?? "";
      if (indentOf(candidate) <= indentOf(rawTally)) break;
      const name = candidate.trim();
      if (name.length === 0 || name.length > TALLY_NAME_LINE_MAX) break;
      if (!NAME_LINE_RE.test(name)) break;
      if (looksLikeCredential(name)) break;
      if (classifyFailureLine(name) !== undefined) break;
      if (isSuccessLine(name)) break;
      const next = names.length === 0 ? name : `${joined}, ${name}`;
      if (next.length > TALLY_JOIN_MAX) break;
      joined = next;
      names.push(name);
      if (names.length >= TALLY_NAMES_MAX) break;
    }
    if (names.length === 0) continue;
    const omitted = count - names.length;
    out.push(`${tally}: ${joined}${omitted > 0 ? ` (+${omitted} more)` : ""}`);
  }
  return out;
}
