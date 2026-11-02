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
 * baseline. "REAL" is only worth what its read is worth: the product is loaded
 * with a cache-busting query on every call (`loadAccountedFiles`), so the
 * baseline cannot be served from a module instance another test in the same
 * process loaded before this branch's edits. It re-reads the source every time,
 * and `runShipped`/`measuredTable` are async for that reason.
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

import { readFileSync } from "node:fs";
import type { CoverageEvidence, FileAccountability } from "../../src/lens-review-coverage.ts";
import { mutantsFor, type ClassMutant } from "./lens-class-mutants.ts";
import { CORPUS, type Fixture } from "./lens-mutant-corpus.ts";

// Re-exported so the coverage suites and `test-lens-class-mutants.ts` keep a
// single import site (`./lens-mutant-harness.ts`) for the corpus the mutants run
// over; the corpus DATA itself lives in `lens-mutant-corpus.ts` along the AGENTS
// §12 size seam.
export { CORPUS, type Fixture } from "./lens-mutant-corpus.ts";

/**
 * The FOUR classes `mentionsPath` interpolates, at their shipped values — read
 * them from the source rather than trusting this list:
 * `grep -n '^const \(NOT_PATH\|NOT_LINE_BREAK\|TERMINATOR\|PATH_CHAR\)' src/lens-review-coverage.ts`.
 *
 * `NOT_LINE_BREAK` is here for the reason the branch exists: the earlier
 * version of this file carried THREE, hard-coded the `[^\r\n]` position in the
 * template instead, and printed a per-member table that had never mutated a
 * class the matcher actually reads. A class nobody deletes is a class whose
 * mutations are invisible, and the corpus proved blind to it (see
 * `test-lens-class-mutants.ts`). It is not in `PathCharClass` in the source —
 * that union types only the two mirror constants — so it is NOT a member of
 * `Flank`: `mutantsFor` refuses a negated class as an `assertStillAClass`
 * admits-everything case, so there is no generated `NOT_LINE_BREAK` table yet.
 * Its fidelity is instead gated two ways: `assertHarnessFidelity` refuses to
 * run the corpus until the four values, the escape regex, and the template
 * literal all match the source verbatim, and the corpus carries the `\r`
 * boundary fixtures that redden when `[^\r\n]` loses its `\r` member.
 */
export const SHIPPED = {
  PATH_CHAR: "[A-Za-z0-9_./+-]",
  NOT_PATH: "[^A-Za-z0-9_./+-]",
  TERMINATOR: "[!?,.;:\\-]",
  NOT_LINE_BREAK: "[^\\r\\n]",
} as const;

/** Which of the constants a per-member table row mutated. Deliberately EXCLUDES
 * `NOT_LINE_BREAK`: its class is negated, so `mutantsFor` would refuse every
 * mutant of it as an admits-everything case, and printing a row for it would be
 * a `0` that was never measured. It is still a member of `SHIPPED`, and
 * `assertHarnessFidelity` judges all four. */
export type Flank = Exclude<keyof typeof SHIPPED, "NOT_LINE_BREAK">;

/** The escape regex `mentionsPath` uses for the interpolated path. Spelled from
 * char codes so this file has no regex-literal to drift: the fidelity assertion
 * compares its SOURCE TEXT against the source's own `/…/g`, and a literal whose
 * escapes were re-flowed by a formatter would compare unequal to itself. */
const HARNESS_ESCAPE =
  "/[" +
  String.fromCharCode(46, 42, 43, 63, 94, 36, 123, 125, 40, 41, 124, 91, 92, 93, 92, 92) +
  "]/g";

/**
 * The `mentionsPath` template with its four classes as `${placeholder}` markers,
 * assembled by READING the product's own `mentionsPath` line and swapping its four
 * interpolations for markers. It is not hand-typed, so it cannot drift from the
 * source it mirrors; `assertHarnessFidelity` still compares it byte-for-byte, so a
 * product edit to the template (adding a flank, changing the lookahead, dropping an
 * arm) makes the swap produce something other than the four-marker form and reddens
 * the run instead of letting `runMutant` measure a stale template while `runShipped`
 * still read green against the real `accountedFiles`.
 */
function buildHarnessTemplate(src: string): string | null {
  const raw = src.match(/`\(\?:\^\|\$\{NOT_PATH\}\)[\s\S]*?\$\{TERMINATOR\}[\s\S]*?`/);
  if (!raw) return null;
  return raw[0]
    .slice(1, -1)
    .replace("${NOT_PATH}", "§NOT_PATH§")
    .replace("${escaped}", "§escaped§")
    .replace("${PATH_CHAR}", "§PATH_CHAR§")
    .replace("${NOT_LINE_BREAK}", "§NOT_LINE_BREAK§")
    .replace("${TERMINATOR}", "§TERMINATOR§");
}

/** Where the product source lives, resolved from this file so the fidelity gate
 * cannot be pointed at a stale copy by the caller's cwd. */
const PRODUCT_SOURCE = new URL("../../src/lens-review-coverage.ts", import.meta.url);

/** The product's `accountedFiles`, read from the source AS IT IS ON DISK at the
 * moment of the call — never from a module instance the loader cached earlier.
 *
 * WHY THIS IS NOT `import { accountedFiles } from "../../src/…"`. A top-level
 * import is resolved once when this module is first evaluated, and every later
 * `import("…")` of the SAME specifier hands back that same instance: Bun caches
 * ES modules by resolved URL, query included. The consequence was measured, on a
 * complete repo-root scratch copy of `393bc99a`, by rewriting the call site at
 * `src/lens-review-coverage.ts:164` from
 * `if (mentionsPath(summary, file)) claim(file, "summary");` to
 * `if (true) claim(file, "summary");`:
 *
 *   static top-level import  -> `runShipped()` reported 0 reds (product broken)
 *   cache-busting query      -> `runShipped()` reported 28 reds
 *
 * A baseline that reports 0 while the matcher claims every file is not a clean
 * baseline, it is the corpus being read by a module the edit never reached — and
 * `assertHarnessFidelity` cannot catch it, because it matches the four class
 * literals, the escape regex and the template line, and the call site is none of
 * those. The same shape this file's sibling already uses for the liveness mutant
 * (`assertLivenessMutantReds` in `lens-coverage-liveness-probe.ts` does
 * `await import(mutantFile)` for exactly this reason), with a unique query
 * because here the specifier is the shipped path rather than a distinct file.
 *
 * The read is `import.meta.url`-relative, so a caller's cwd cannot point it at
 * another copy. The fidelity gate runs before this is called, so a source the
 * harness no longer mirrors throws rather than getting measured. */
type AccountedFiles = (
  lensResults: readonly CoverageEvidence[],
  expected: ReadonlySet<string>,
) => Map<string, FileAccountability> | undefined;

async function loadAccountedFiles(): Promise<AccountedFiles> {
  const bust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mod = (await import(`../../src/lens-review-coverage.ts?harness=${bust}`)) as {
    accountedFiles: AccountedFiles;
  };
  // Loud, not silent: a product that removed the export would otherwise leave
  // every row measuring `undefined` and reporting 0 reds, the same wrong-green
  // this function exists to refuse.
  if (typeof mod.accountedFiles !== "function")
    throw new Error(
      "harness fidelity: lens-review-coverage.ts no longer exports a callable `accountedFiles`, so runShipped has nothing to measure",
    );
  return mod.accountedFiles;
}

/**
 * The gate that makes this harness's fidelity a RUN rather than a header
 * sentence. It refuses, by throwing, whenever the mirror this file builds from
 * has drifted from the source it claims to mirror. Four things are compared
 * against the real `lens-review-coverage.ts`:
 *
 *   1. each of the four class literals (`const NAME = …`), so a member added,
 *      removed, or re-spelled in the product reddens the run rather than
 *      leaving `SHIPPED` measuring a class the matcher no longer uses;
 *   2. the path-escape regex `/…/g`, so the harness cannot escape a metacharacter
 *      path differently from the product it measures;
 *   3. the whole `mentionsPath` template line, with the `\${…}` placeholders
 *      restored, so the harness's template is the source's template verbatim.
 *
 * It runs at the top of `runShipped` and `runMutant`, the two entry points that
 * consume the mirror. That placement is the point: `runShipped` drives the REAL
 * `accountedFiles`, so if the mirror drifted it is `runMutant` that would be
 * measuring a stale template — and this is what stops the pair from disagreeing
 * silently, which is the exact failure class the earlier THREE-class version
 * shipped with.
 */
export function assertHarnessFidelity(): void {
  const src = readFileSync(PRODUCT_SOURCE, "utf8");
  for (const name of ["PATH_CHAR", "NOT_PATH", "TERMINATOR", "NOT_LINE_BREAK"] as const) {
    // The product spells two of the four as `String.raw\`…\`` and two as plain
    // `"…"` string literals, so a value with `\r`/`\-` inside reads as two
    // DIFFERENT byte sequences depending on which. The `SHIPPED` value is the
    // JS-runtime class the matcher interpolates, so each spelling is decoded
    // the way the compiler does before comparing — otherwise the harness would
    // measure `[^\r\n]` (a caret + r + n, not a carriage return) and the
    // baseline would silently agree with the wrong string.
    const m = src.match(
      new RegExp("const " + name + "(?::[^=\\n]+)? = (?:String\\.raw)?(?:`([^`]*)`|\"((?:[^\\\\\"]|\\\\.)*)\")"),
    );
    if (!m)
      throw new Error(
        `harness fidelity: no \`const ${name} = …\` found in lens-review-coverage.ts — the product removed or renamed the class this harness mirrors`,
      );
    const raw = m[1] ?? m[2] ?? "";
    const productValue = m[1] !== undefined ? raw : raw.replace(/\\(.)/g, "$1");
    if (productValue !== SHIPPED[name])
      throw new Error(
        `harness fidelity: SHIPPED.${name} = ${JSON.stringify(SHIPPED[name])} but the product reads ${JSON.stringify(productValue)} (raw ${JSON.stringify(raw)}) — the table measures a class the matcher no longer interpolates`,
      );
  }
  const esc = src.match(/file\.replace\((\/[^\n]*?\/g), "\\\\\$&"\)/);
  if (!esc)
    throw new Error(
      "harness fidelity: could not find the product's `file.replace(/…/g, …)` escape call in lens-review-coverage.ts",
    );
  if (esc[1] !== HARNESS_ESCAPE)
    throw new Error(
      `harness fidelity: the harness escapes with ${JSON.stringify(HARNESS_ESCAPE)} but the product uses ${JSON.stringify(esc[1])}`,
    );
  const tmpl = src.match(/`\(\?:\^\|\$\{NOT_PATH\}\)[\s\S]*?\$\{TERMINATOR\}[\s\S]*?\)`/);
  if (!tmpl)
    throw new Error(
      "harness fidelity: could not find the product's `mentionsPath` template line in lens-review-coverage.ts",
    );
  // The independent expectations the product's template line must satisfy, in
  // the source's own `\\`-spelling. These are hand-written constants, not derived
  // from `tmpl`, so this is a real gate: if a product edit rewrites the template
  // (reorders the arms, drops `\\r?`, changes the lookahead) the matched line no
  // longer equals the expected line and the run reddens instead of `runMutant`
  // silently measuring a stale template against a `runShipped` that read green.
  const EXPECTED_LINE =
    "`(?:^|${NOT_PATH})${escaped}(?:(?!${PATH_CHAR})${NOT_LINE_BREAK}|${TERMINATOR}?(?:\\\\r?\\\\n|$))`";
  if (tmpl[0] !== EXPECTED_LINE)
    throw new Error(
      `harness fidelity: the product's mentionsPath template is not the one the harness mirrors —\n  source: ${JSON.stringify(tmpl[0])}\n  want:   ${JSON.stringify(EXPECTED_LINE)}\nUpdate the harness (SHIPPED/escape/template) to match; the table must measure the matcher, not a stale copy of it.`,
    );
  // And the marker-derivation used by runMutant's template must have extracted
  // all five placeholders — a template whose interpolation was renamed would
  // otherwise slip through the byte check above only because it still matched.
  const markers = buildHarnessTemplate(src);
  if (
    !markers ||
    !markers.includes("§NOT_PATH§") ||
    !markers.includes("§escaped§") ||
    !markers.includes("§PATH_CHAR§") ||
    !markers.includes("§NOT_LINE_BREAK§") ||
    !markers.includes("§TERMINATOR§")
  )
    throw new Error(
      "harness fidelity: the product template did not carry all five interpolations the harness substitutes, so runMutant would measure a template with a missing class",
    );
}

/** One fixture: a summary, a denominator file, and the claim the suites expect. */

/** The shipped `mentionsPath` template, with the three classes as arguments.
 * Kept as ONE template literal so it cannot drift from the source it mirrors —
 * the escaping of the interpolated path is the source's own `replace`. */
function mentionsPathWith(
  summary: string,
  file: string,
  classes: { PATH_CHAR: string; NOT_PATH: string; TERMINATOR: string; NOT_LINE_BREAK: string },
): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|${classes.NOT_PATH})${escaped}(?:(?!${classes.PATH_CHAR})${classes.NOT_LINE_BREAK}|${classes.TERMINATOR}?(?:\\r?\\n|$))`,
  );
  return re.test(summary);
}

/** The baseline row: the REAL `accountedFiles`, read fresh from the source at
 * call time (`loadAccountedFiles` — not a cached module instance), shipped
 * classes, no substitution anywhere. A corpus this function rejects is a wrong
 * corpus, not a broken matcher — which is why `measuredTable` refuses to print a
 * table until it is clean.
 *
 * ASYNC because the read is a dynamic import: it cannot be a top-level import
 * without reintroducing the cached-instance defect `loadAccountedFiles` records.
 * `measuredTable` is async for the same reason; the three call sites in
 * `test-lens-class-mutants.ts` await it. */
export async function runShipped(corpus: readonly Fixture[] = CORPUS): Promise<string[]> {
  assertHarnessFidelity();
  const accounted = await loadAccountedFiles();
  const reds: string[] = [];
  for (const fx of corpus) {
    const out = accounted([{ findings: [], summary: fx.summary }], new Set(fx.denominator));
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
  assertHarnessFidelity();
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
export async function measuredTable(flank: Flank): Promise<MutantRow[]> {
  const baseline = await runShipped();
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
    `(?:^|${SHIPPED.NOT_PATH})${escaped}(?:(?!${SHIPPED.PATH_CHAR})${SHIPPED.NOT_LINE_BREAK})`,
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
