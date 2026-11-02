/**
 * lens-mutant-corpus — the fixture corpus the mutation harness measures.
 *
 * Split out of `lens-mutant-harness.ts` along the natural seam the AGENTS §12
 * size cap forces: the corpus is DATA (what each fixture claims), the harness is
 * the machinery (the fidelity gate, the mutant runner). Nothing here imports the
 * harness, so the two files cannot form a cycle. `Fixture`/`CORPUS` are
 * re-exported by the harness so callers keep one import site.
 *
 * The CR (`\r`) fixtures at the foot of CORPUS are the ONLY witnesses for the
 * NOT_LINE_BREAK class the harness interpolates: with a mutant of the right-flank
 * classes, a path followed by a bare CR flips verdict depending on whether
 * `[^\r\n]` still admits CR — so a no-op class substitution reddens exactly this
 * pair, which is why `test-lens-class-mutants.ts`'s control-1 filters for `lone CR`
 * rather than demanding zero reds.
 */

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
  // — the FOURTH interpolated class, `NOT_LINE_BREAK`, which the three-class
  //    harness never mutated and its corpus never exercised: substituting the
  //    shipped `[^\r\n]` with `[` + caret + `\n] + ]` (the `\r` member gone —
  //    spelled from char codes so no line of this file re-flowes an escape into
  //    a real CR) moved 0 fixtures. These three pairs are the witnesses:
  //    each summary accounts for its file through a lone `\r` boundary, so the
  //    moment `[^\r\n]` admits `\r` the citation goes away and the assertion
  //    reddens. Each has a sibling — a `\r`-terminated path followed by more
  //    text — that stays `undefined` for every spelling, so the pair is the
  //    boundary and not a tautology. `\r\n` pairs are NOT here: the terminator
  //    arm's own `\r?` absorbs the `\r`, so those are the anchor's, not this
  //    class's.
  f(
    "canary: a sentence-closed path followed by a lone CR still accounts (NOT_LINE_BREAK witnesses \\r)",
    "Reviewed src/a.ts." + String.fromCharCode(13),
    "src/a.ts",
    "summary",
    true,
  ),
  f(
    "canary: a bullet-closed path followed by a lone CR still accounts (NOT_LINE_BREAK witnesses \\r)",
    "Reviewed src/a.ts-" + String.fromCharCode(13),
    "src/a.ts",
    "summary",
    true,
  ),
  f(
    "canary: a path followed by a lone CR then text is NOT a citation (NOT_LINE_BREAK must admit \\r)",
    "Reviewed src/a.ts" + String.fromCharCode(13) + "next",
    "src/a.ts",
    undefined,
    true,
  ),
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

