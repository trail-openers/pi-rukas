/**
 * lean/verify-baseline-veto — the whole-line veto and the one normalisation every arm reads through.
 *
 * Two things live here because they cannot be separated: the answer to "does this line's own text say
 * something went wrong?", and the scrubbing that answer is asked OF. A veto that read raw text would be
 * the one arm still seeing `fa‌iled` as ordinary words while everything else saw `failed`, so the
 * predicate and its normalisation travel together and no caller supplies its own text.
 *
 * {@link declaresFailure} is the ONLY failure vocabulary the baseline excuse has, and the single
 * answer to the question. Two rules turn on it and must never disagree: `isKnownCleanLine` in
 * `verify-baseline-allow-list.ts` refuses a head-only line whose text carries one of these words, and
 * `foldsAsCounter` in `verify-baseline-counters.ts` refuses to fold a digit on such a line. A split
 * between the two would be a line the allow-list called a failure and the fold read as a tally.
 *
 * This is the LEAF of the excuse seam: it imports nothing from the modules that read it, which is what
 * keeps the direction the counters module documents acyclic — the fold consults its own importer's
 * veto would be a cycle, so the veto sits below both of its readers.
 */

import { scrubInvisible } from "./verify-baseline-scrub.ts";

/**
 * The vocabulary, as one pattern.
 *
 * The words are a fixed set, matched case-insensitively and WORD-BOUNDED (`fail\w*` reaches `failed`,
 * `failing`, `failures`; it does not reach `focus` or `definitely`), plus the five failure glyph
 * runners actually print (`✗ ✘ × ✕ ✖`), which have no letters to bound, plus the verdict SPELLINGS a
 * runner prints for a failed check — TAP's `not ok` and go's `--- FAIL:` / jest's `=== FAIL:` — plus
 * the HARNESS's own `Exit code:` stamp. Those last group is here because the exemption invariant asks
 * this predicate of EVERY line, and a verdict must count as declaring failure wherever that question
 * is asked, whoever wrote it.
 *
 * The `not ok` / `= FAIL` / `- FAIL` arms sit OUTSIDE the `\b(?:…)\b` word group: a word boundary
 * before a branch opening with a punctuation class (`=` or `-`) matches nothing at all, since neither
 * side of that position is a word character. Each therefore carries its own right-hand `\b` and no
 * left-hand one — its run of `=`/`-` is what makes it a verdict rather than prose.
 *
 * The `exit code: N` arm is ANCHORED at the head of the line, not a word in the group: the harness's
 * kill stamp names no word that group holds, so without this arm a head-only `Exit code: 1` declares
 * nothing and is excused by the harness door instead of judged. Anchoring plus a non-zero count keeps
 * it a stamp and not a vocabulary — `Exit code: 1 - brand new check` is a gate line that merely OPENS
 * that way, and an unanchored word would veto any line that mentioned a code.
 *
 * The set is wide on purpose — it reaches further than the classifier's anchored shapes — and it is
 * asked only of the lines this seam is asked about, never of a stream: being wide costs a hand-back for
 * a passing test whose name happens to read like a failure (`ok 7 - login timeout retried` printed
 * head-only) and for a summary whose run total merely sits beside a `Failures:` count, while being
 * narrow would cost a green on a line that said it broke. The direction is what makes an enumeration
 * safe here where it is not safe for counters: this predicate can only ever REFUSE a permission, never
 * grant one, so a failure word the list lacks costs a hand-back and no more.
 */
const FAILURE_VETO =
  /\b(?:fail\w*|error\w*|crash\w*|abort\w*|panic\w*|timed?\s*out|timeout|segfault|broken|exception\w*|fatal|critical|killed|leak\w*)\b|^\s*exit\s+code:\s*[1-9]|\bnot\s+ok\b|={3,}\s*FAIL\b|-{3,}\s*FAIL\b|[✗✘×✕✖]/i;

/**
 * Does this line's own text declare a failure, anywhere in it?
 *
 * Asked of the scrubbed text — see the module header for why the scrubbing is part of this module
 * rather than a courtesy of the caller.
 */
export function declaresFailure(line: string): boolean {
  return FAILURE_VETO.test(scrubInvisible(line));
}
