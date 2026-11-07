/**
 * lean/verify-baseline-scrub — the one normalisation every arm of the baseline excuse reads through.
 *
 * A line as EVERY arm must read it: invisible characters out, ANSI sequences out, line separators
 * flattened. Applied where the excuse reads lines — `streamLines` in `verify-baseline-allow-list.ts`,
 * the head of `failureLineFold` in `verify-baseline-counters.ts`, and the veto beside it — so no arm
 * can judge a text another arm did not. It runs BEFORE classification and before any veto, which is the
 * only ordering that makes the promise true: a failure word split by an invisible character IS that
 * word, and an arm that normalised after its own match would be vouching for text the next arm never
 * saw. Printable content is untouched, so nothing a runner actually printed is erased.
 *
 * The leaf of the excuse seam: it imports nothing, so neither of the two modules that read it can pull
 * the other in through it.
 */

/**
 * The invisible characters a runner's output can carry inside a WORD.
 *
 * grave, a byte-order mark. None of them renders, all of them break a word in two: a word with a
 * zero-width space inside it is not that word to a `\b`-bounded vocabulary, to the classifier's
 * anchored shapes, or to a strict line comparison, and a human reading the log sees the word.
 * `\u00ad` (soft hyphen), `\u200b-\u200d` (zero-width space, joiner, non-joiner), `\u2060` (word
 * joiner), `\u034f` (combining grave) and `\ufeff` (BOM) — written as escapes, which is the only way
 * to name them without putting the characters themselves in the source. The class is a fixed set of
 * format characters, not a general Unicode sweep: it is NOT `\p{Cf}` and not a control-character class,
 * because a line's printable content is evidence and is left exactly as printed. Each range is written
 * on its own rather than merged into one class, so a reader — and Biome's misleading-character-class
 * rule — can see each character this arm removes.
 */
const INVISIBLE_CHARS = new RegExp(
  `[${["\\u00ad", "\\u200b-\\u200d", "\\u2060", "\\u034f", "\\ufeff"].join("")}]`,
  "g",
);

/**
 * An ANSI CSI sequence: an escape, a parameter string, and a final byte.
 *
 * A colour or cursor sequence sits inside a line the same way an invisible character does — a colour
 * code between the halves of a verdict prints as that verdict — and is stripped by {@link
 * scrubInvisible} for the same reason.
 *
 * Built from `String.fromCharCode(27)` rather than a `\u001b` escape in the literal: Biome's
 * `noControlCharactersInRegex` is right that a control character written into a pattern is easy to
 * misread, and here it is genuinely easy to misread — the ESC byte is the whole meaning of the arm and
 * nothing around it shows it. `fromCharCode` is the house form for this byte (`merge-lex-views.ts`,
 * `write-fence-bash-words.ts` both name ESC the same way). The parameter bytes are `[\d;?]*`, which
 * never include the final byte, and the final byte is one character: no quantifier may stretch across
 * a line, so no input makes this backtrack.
 */
const ANSI_CSI = new RegExp(`${String.fromCharCode(27)}\\[[\d;?]*[A-Za-z@]`, "g");

/**
 * The Unicode line separators, mapped to a space rather than removed.
 *
 * U+2028, U+2029 and C1 U+0085 are line boundaries to some tools and ordinary characters to others,
 * so one stream can carry two lines that this gate reads as one. Replacing them with a space keeps the
 * words either side of them separate — removing them would glue a crash count to the tally beside it —
 * and leaves the line as ONE line for every arm. Written with `\p{Cc}` plus the two Unicode separators
 * rather than literal control characters: the set is "every character some renderer breaks a line on",
 * which is the property the arm needs, and a control character has no place in a source pattern.
 */
const LINE_SEPARATORS = /[\p{Cc}\u2028\u2029]/gu;

/**
 * A line as EVERY arm of the baseline excuse must read it: invisible characters out, ANSI sequences out, line separators flattened.
 *
 * THE one normalisation of the whole comparison, applied where the excuse reads lines — {@link
 * streamLines} in `verify-baseline-allow-list.ts`, and the head of {@link failureLineFold} here — so no
 * arm can judge a text another arm did not. It runs BEFORE classification and before any veto, which
 * is the only ordering that makes the promise true: a failure word split by an invisible character IS
 * that word, and an arm that normalised after its own match would be vouching for text the next arm
 * never saw. Printable content is untouched, so nothing a runner actually printed is erased.
 *
 * Control characters go to a space, not nothing: a C1 in the middle of a stream is a boundary a reader
 * would honour, and deleting it would splice two fields into one word.
 *
 * Shared because both sides of the excuse seam need it: a normalisation kept on one side of a seam is
 * a rule the other side never applied.
 */
export function scrubInvisible(line: string): string {
  return line.replace(ANSI_CSI, "").replace(INVISIBLE_CHARS, "").replace(LINE_SEPARATORS, " ");
}
