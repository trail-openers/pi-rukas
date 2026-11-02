/**
 * The measurement harness behind the per-member tables in
 * `lens-flank-escape-probe.ts`, and the only thing that makes those tables'
 * `reds` column mean anything: a row is a run, not a transcription.
 *
 * WHAT IT DOES NOT DO. It does not run a test file, and it does not edit
 * `lens-review-coverage.ts` — the worktree must stay unmutated. `mentionsPath`
 * takes all three of its classes from module constants and interpolates them
 * into exactly one template, so this harness builds that one template from
 * three arguments and runs the shipped fixture corpus through it. `runShipped`
 * is the same corpus driven through the REAL `accountedFiles`, which is how the
 * table's baseline row is printed by shipped code rather than asserted by this
 * file — and why a harness that got the template wrong could not report a clean
 * baseline.
 *
 * WHY THE TABLES SPLIT BY FLANK. `mentionsPath` interpolates BOTH `PATH_CHAR`
 * (the right-flank lookahead) and `NOT_PATH` (the left flank), and both are
 * `PathCharClass`-annotated mirrors of the same set. A table that mutates only
 * `PATH_CHAR` measures half the matcher and reports the other half as "0 reds",
 * which is what the earlier table did: `NOT_PATH` minus `+` is worth five reds
 * and the old table printed nothing for it because it never mutated that side.
 * `Flank` is a required parameter of every entry point so a caller cannot
 * silently pick one side and call the result "the class".
 *
 * The mutants come from `mutantsFor`, so each row is a parsed-token deletion
 * that has already passed the generator's preconditions — never a hand-typed
 * string, which is the defect class this branch exists to close.
 */

import { accountedFiles } from "../../src/lens-review-coverage.ts";
import { mutantsFor, type ClassMutant } from "./lens-class-mutants.ts";

/** The three classes `mentionsPath` interpolates, at their shipped values.
 * Read them from the source rather than trusting this list:
 * `grep -n '^const \(NOT_PATH\|TERMINATOR\|PATH_CHAR\)' src/lens-review-coverage.ts`. */
export const SHIPPED = {
  PATH_CHAR: "[A-Za-z0-9_./+-]",
  NOT_PATH: "[^A-Za-z0-9_./+-]",
  TERMINATOR: "[!?,.;:\\-]",
} as const;

/** Which of the constants a table row mutated. */
export type Flank = keyof typeof SHIPPED;

/** One fixture: a summary, a denominator file, and the claim the suites expect. */
export interface Fixture {
  readonly name: string;
  readonly summary: string;
  readonly file: string;
  readonly expected: "summary" | undefined;
  /** The denominator this fixture asserts against. One file for the flank cases,
   * the three-file set for the accounting cases — kept per-fixture so a red names
   * one flank, exactly as the suites do. */
  readonly denominator: readonly string[];
}

const THREE = ["src/a.ts", "src/b.ts", "src/c.ts"] as const;

const f = (
  name: string,
  summary: string,
  file: string,
  expected: "summary" | undefined,
  singleFile = false,
): Fixture => ({
  name,
  summary,
  file,
  expected,
  denominator: singleFile ? [file] : THREE,
});

/**
 * The corpus: every `summary`-claim assertion the two coverage suites make about
 * `mentionsPath`, plus the fixtures each flank member needs and the earlier
 * table did not have. Each entry maps 1:1 to an `assert` in a suite (or, for the
 * rows this branch adds, to an assertion this branch adds).
 *
 * A terminal-character fixture is always paired with a sibling in which the same
 * character is followed by a space. Without the sibling, `undefined` is the
 * answer for every mutation of the class — an assertion that cannot go the other
 * way witnesses nothing.
 */
export const CORPUS: readonly Fixture[] = [
  // — the shared `"src/b.ts is fine as written."` block —
  f("a closing summary naming the file accounts for it", "src/b.ts is fine as written.", "src/b.ts", "summary"),
  f(
    "canary: the file NO evidence mentions is the unaccounted one — before this gate it was invisible",
    "src/b.ts is fine as written.",
    "src/c.ts",
    undefined,
  ),
  // — natural citations —
  f("a summary that NAMES a file as a path token (src/a.ts)", "Looked at src/a.ts and it is fine.", "src/a.ts", "summary"),
  f("a summary that NAMES a file as a path token (src/c.ts)", "Notes:\n- src/c.ts", "src/c.ts", "summary"),
  f(
    "canary: a summary that NAMES both files as path tokens still accounts for both (src/a.ts)",
    "Read src/a.ts and src/b.ts line by line; no issues from this lens.",
    "src/a.ts",
    "summary",
  ),
  f(
    "canary: a summary that NAMES both files as path tokens still accounts for both (src/b.ts)",
    "Read src/a.ts and src/b.ts line by line; no issues from this lens.",
    "src/b.ts",
    "summary",
  ),
  // — sentence closings, one row per TERMINATOR member a fixture exercises —
  f("canary: a path that ends a SENTENCE still accounts — src/a.ts", "Reviewed src/a.ts.", "src/a.ts", "summary"),
  f("canary: a path that ends a SENTENCE still accounts — src/b.ts", "No issues in src/b.ts.", "src/b.ts", "summary"),
  f("canary: a path that ends a SENTENCE still accounts — src/c.ts (;)", "Notes: src/c.ts; fine.", "src/c.ts", "summary"),
  f(
    "canary: a path that ends a line with the markdown bullet still accounts — src/a.ts",
    "Reviewed src/a.ts-",
    "src/a.ts",
    "summary",
  ),
  // — recitals: the path occurs, and only inside quoted diff text —
  f("canary: a path that occurs ONLY inside a recited code-block diff accounts for nothing", recitalDiff(), "src/a.ts", undefined),
  f("canary: a path that occurs ONLY inside a recited code-block diff accounts for nothing (src/b.ts)", recitalDiff(), "src/b.ts", undefined),
  // — git's own header spellings, kept as negatives —
  f("canary: git's own headers — +++ b/src/a.ts and +++ \"b/src/b.ts\" — account for nothing (a)", gitHeaders(), "src/a.ts", undefined),
  f("canary: git's own headers — +++ b/src/a.ts and +++ \"b/src/b.ts\" — account for nothing (b)", gitHeaders(), "src/b.ts", undefined),
  f("canary: a path inside git's own header spelling is not a citation (\"+src/a.ts\")", "the diff shows:\n+src/a.ts", "src/a.ts", undefined, true),
  f("canary: a path inside git's own header spelling is not a citation (\"+++src/a.ts\")", "the diff shows:\n+++src/a.ts", "src/a.ts", undefined, true),
  f("canary: a path inside git's own header spelling is not a citation (\"@@ … @@\\n+src/a.ts\")", "@@ -1,2 +1,3 @@\n+src/a.ts", "src/a.ts", undefined, true),
  f("canary: a path inside git's own header spelling is not a citation (\"--- a/src/a.ts\")", "--- a/src/a.ts", "src/a.ts", undefined, true),
  f("canary: a path inside git's own header spelling is not a citation (\"+++ b/src/a.ts\")", "+++ b/src/a.ts", "src/a.ts", undefined, true),
  f("canary: a path inside git's own header spelling is not a citation ('+++ \"b/src/a.ts\"')", '+++ "b/src/a.ts"', "src/a.ts", undefined, true),
  // — the right flank refusing a LONGER path —
  f(
    "canary: the terminator arm does not turn a LONGER path into a citation of a shorter one",
    "See src/b.ts.spec",
    "src/b.ts",
    undefined,
  ),
  // — the flank-escape probe's own cases —
  f("canary: a path at the start of a line opens a citation (NL_OPEN)", "Reviewed the delta.\nsrc/c.ts is fine", "src/c.ts", "summary", true),
  f("canary: a path that starts the summary itself is a citation (CARET_OPEN)", "src/c.ts is fine", "src/c.ts", "summary", true),
  f(
    "canary: a denominator path containing regex metacharacters is matched LITERALLY",
    "Reviewed src/(legacy).ts and fixed it",
    "src/(legacy).ts",
    "summary",
    true,
  ),
  f(
    "canary: a metacharacter path is not matched by text that merely fits its UNESCAPED pattern",
    "see src/legacy.ts now",
    "src/(legacy).ts",
    undefined,
    true,
  ),
  f("canary: a path followed by a hyphenated suffix is not a citation (PATH_CHAR_HYPHEN)", "See src/b.ts-spec", "src/b.ts", undefined, true),
  f("canary: a path followed by a terminal `+` is not a citation (PATH_CHAR_PLUS)", "See src/b.ts+", "src/b.ts", undefined, true),
  f("canary: a path followed by a terminal slash is not a citation (PATH_CHAR_SLASH)", "See src/b.ts/", "src/b.ts", undefined, true),
  // — THE LEFT-FLANK AND TERMINAL-MEMBER FIXTURES the old table never had.
  //    Each terminal row is paired with a sibling that must still account, so
  //    the pair says "this character is a path character" and not "this text
  //    never matches". —
  f("canary: a path terminated by a DIGIT is not a citation of the shorter file", "See src/b.ts0", "src/b.ts", undefined, true),
  f("canary: a path followed by a space and a digit still accounts", "See src/b.ts 0 days later", "src/b.ts", "summary", true),
  f("canary: a path terminated by an UNDERSCORE is not a citation of the shorter file", "See src/b.ts_", "src/b.ts", undefined, true),
  f("canary: a path followed by a space and an underscore still accounts", "See src/b.ts _reviewed_", "src/b.ts", "summary", true),
  f("canary: a path terminated by an UPPERCASE letter is not a citation of the shorter file", "See src/b.tsT", "src/b.ts", undefined, true),
  f("canary: a path followed by a space and an uppercase letter still accounts", "See src/b.ts TODO later", "src/b.ts", "summary", true),
  // — the LEFT flank's own boundary: a neighbour that is a path character must
  //    refuse, and the same neighbour after a space must not — which is the pair
  //    that makes a NOT_PATH member row a witness rather than a tautology. —
  f("canary: a digit glued to the left of a path refuses the citation", "x0src/b.ts is fine", "src/b.ts", undefined, true),
  f("canary: a digit after a space opens the citation", "x0 src/b.ts is fine", "src/b.ts", "summary", true),
  f("canary: an underscore glued to the left of a path refuses the citation", "x_src/b.ts is fine", "src/b.ts", undefined, true),
  f("canary: an underscore after a space opens the citation", "x_ src/b.ts is fine", "src/b.ts", "summary", true),
  f("canary: a `/` glued to the left of a path refuses the citation", "x/src/b.ts is fine", "src/b.ts", undefined, true),
  f("canary: a `/` after a space opens the citation", "x/ src/b.ts is fine", "src/b.ts", "summary", true),
  f("canary: a `+` glued to the left of a path refuses the citation", "x+src/b.ts is fine", "src/b.ts", undefined, true),
  f("canary: a `+` after a space opens the citation", "x+ src/b.ts is fine", "src/b.ts", "summary", true),
  f("canary: a `-` glued to the left of a path refuses the citation", "x-src/b.ts is fine", "src/b.ts", undefined, true),
  f("canary: a `-` after a space opens the citation", "x- src/b.ts is fine", "src/b.ts", "summary", true),
  // The `.` member of NOT_PATH needs its own pair: with `.` in the class a path
  // glued after a full stop is not a citation, and with `.` dropped from the
  // class it becomes one. Found by a sweep over left/right neighbour spellings
  // (a 35-character neighbour alphabet under six lead-ins), which is also the
  // evidence that no OTHER spelling moves for this mutant. The sweep script lived
  // only in an uncommitted scratch dir and its printed count did not reproduce, so
  // no figure is quoted here: the claim this fixture carries is the one a reader
  // can check in two calls — `mutantsFor(SHIPPED.NOT_PATH)` gives the `.` mutant
  // and `runMutant("NOT_PATH", "[^A-Za-z0-9_/+-]")` names the fixtures it reddens,
  // this pair among them. A number whose script was never committed is a claim, not
  // a witness; the run is.
  f("canary: a full stop glued to the left of a path refuses the citation", ".src/b.ts is fine", "src/b.ts", undefined, true),
  f("canary: a path after a full stop and a space still accounts", ". src/b.ts is fine", "src/b.ts", "summary", true),
  // — the `+`/`+++` re-emission cases, spelled on their own so a NOT_PATH `+`
  //    deletion has single-file-denominator reds and not only the multi-file
  //    header ones —
  f("canary: a re-emitted `+` header with no space is not a citation", "notes\n+src/a.ts", "src/a.ts", undefined, true),
  f("canary: a re-emitted `+++` header with no space is not a citation", "notes\n+++src/a.ts", "src/a.ts", undefined, true),
];

function recitalDiff(): string {
  const FENCE = String.fromCharCode(96, 96, 96);
  return [
    "Here is the diff I read, verbatim:",
    FENCE + "diff",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    '+const spec = require("src/b.ts.spec");',
    FENCE,
    "All good.",
  ].join("\n");
}

function gitHeaders(): string {
  const Q = String.fromCharCode(34);
  return ["Reviewed the change; the diff shows:", "+++ b/src/a.ts", `+++ ${Q}b/src/b.ts${Q}`, "All good."].join(
    "\n",
  );
}

/** The shipped `mentionsPath` template, with the three classes as arguments.
 * Kept as ONE template literal so it cannot drift from the source it mirrors —
 * the escaping of the interpolated path is the source's own `replace`. */
function mentionsPathWith(
  summary: string,
  file: string,
  classes: { PATH_CHAR: string; NOT_PATH: string; TERMINATOR: string },
): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|${classes.NOT_PATH})${escaped}(?:(?!${classes.PATH_CHAR})[^\\r\\n]|${classes.TERMINATOR}?(?:\\r?\\n|$))`,
  );
  return re.test(summary);
}

/** The baseline row: the REAL `accountedFiles`, shipped classes, no substitution
 * anywhere. A corpus this function rejects is a wrong corpus, not a broken
 * matcher — which is why `runTable` refuses to print a table until it is clean. */
export function runShipped(corpus: readonly Fixture[] = CORPUS): string[] {
  const reds: string[] = [];
  for (const fx of corpus) {
    const out = accountedFiles([{ findings: [], summary: fx.summary }], new Set(fx.denominator));
    if (out?.get(fx.file) !== fx.expected) reds.push(fx.name);
  }
  return reds;
}

/** The same corpus with ONE class substituted. `flank` is required precisely so a
 * caller cannot report "the class" while having mutated one side of a two-sided
 * matcher. */
export function runMutant(
  flank: Flank,
  mutated: string,
  corpus: readonly Fixture[] = CORPUS,
): string[] {
  const classes = { ...SHIPPED, [flank]: mutated };
  const reds: string[] = [];
  for (const fx of corpus) {
    const got = mentionsPathWith(fx.summary, fx.file, classes) ? "summary" : undefined;
    if (got !== fx.expected) reds.push(fx.name);
  }
  return reds;
}

/** One table row: a generated mutant, and the reds a run printed for it. */
export interface MutantRow {
  readonly flank: Flank;
  readonly mutant: ClassMutant;
  readonly reds: string[];
}

/** Every generated mutant for one flank, each with its measured reds. The rows
 * are the generator's output; the reds are a run's. Nothing here is transcribed,
 * and the baseline is checked first: a corpus that fails under the shipped
 * classes yields no table, because every "0 reds" in it would be meaningless. */
export function measuredTable(flank: Flank): MutantRow[] {
  const baseline = runShipped();
  if (baseline.length > 0)
    throw new Error(
      `refusing to measure ${flank}: the shipped classes already fail ${baseline.length} fixture(s): ${baseline.join(" | ")}`,
    );
  return mutantsFor(SHIPPED[flank]).map((mutant) => ({
    flank,
    mutant,
    reds: runMutant(flank, mutant.mutated),
  }));
}

/** The template with the anchored-terminator ARM deleted — the `|TERMINATOR?`
 * alternative and everything after it gone, leaving the lookahead arm alone. This
 * is the whole-class control for `TERMINATOR` and the only well-formed one:
 * substituting `""` into the class position leaves `|(?:\r?\n|$)`, which compiles
 * and quietly changes what the ARM means instead of removing it. Kept apart from
 * `mentionsPathWith` so `measuredTable` cannot reach it by defaulting a class.
 */
function mentionsPathWithoutTerminatorArm(summary: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|${SHIPPED.NOT_PATH})${escaped}(?:(?!${SHIPPED.PATH_CHAR})[^\\r\\n])`,
  );
  return re.test(summary);
}

/**
 * The whole-class control the tables report alongside the per-member rows, and the
 * figure `test-lens-class-mutants.ts` asserts so the header's control claim is a
 * run rather than a sentence about a run. `TERMINATOR` is where the earlier table
 * printed a whole-class figure under a per-member label, so this is a separate call
 * and never a substitute for a member row.
 *
 * For `TERMINATOR` the control deletes the ARM rather than emptying the class:
 * interpolating `""` there yields `…|?(?:\r?\n|$)`, and `?` with nothing to repeat
 * is a compile error (`Invalid regular expression: nothing to repeat`, verified by
 * building that exact pattern), so emptying it is not an experiment the harness can
 * run at all.
 *
 * For the two lookahead classes there is NO whole-class control, and saying so is
 * the point — the previous version of this function reported one, by interpolating
 * `""`. An empty `PATH_CHAR` makes the lookahead `(?!|…)`, always true, so every
 * path is refused and 17 of 48 fixtures redden for a reason that has nothing to do
 * with the class's membership; an empty `NOT_PATH` is `(?:^|)`, red for the same
 * wrong reason. Printing 17 as "whole-class removal" is a whole-class figure
 * wearing a label it did not earn. Deleting a whole flank is a different mutant
 * with its own red count, and this harness does not measure it, so `null` means
 * "no such control exists" and the caller must not print a number for it.
 */
export function wholeClassRemoval(flank: Flank): string[] | null {
  if (flank !== "TERMINATOR") return null;
  const reds: string[] = [];
  for (const fx of CORPUS) {
    const got = mentionsPathWithoutTerminatorArm(fx.summary, fx.file) ? "summary" : undefined;
    if (got !== fx.expected) reds.push(fx.name);
  }
  return reds;
}
