/**
 * work-driver-verify-rust — the Rust/cargo READER dialect of the failure-line
 * vocabulary: what a cargo/libtest line says about which TEST failed, and
 * which lines are too generic to name one.
 *
 * Split out of `work-driver-verify-shapes.ts` along the natural seam
 * (AGENTS.md §12 file-size cap): that module's own header reserves it for the
 * TABLE DATA — the shape entries, their priority order, the pre-veto exemption
 * pair. The #2341 fix wave added the one predicate that has to SCAN a whole
 * window and decide, per test name, whether the run reported it as failing
 * ({@link libtestVerdictForTest}) — window-scanning LOGIC, which does not
 * belong in the data module and which pushed it past the cap. The direction
 * stays one-way (shapes → here for the dialect regexes; failures → here for
 * the predicates; nothing here imports either), which is what keeps the module
 * graph a DAG.
 *
 * The rules this seam owns, each of which was a real defect (#2341):
 *
 *   - a panic header names its OWN test, and a `#[should_panic]` print from a
 *     passing test is the identical shape — the veto is name-correlated;
 *   - cargo's target-level `error:` summaries and the location-less rustc
 *     `error[E…]` lines are byte-identical across different failures, so they
 *     name no check and buy no "SAME assertion" claim;
 *   - a panic header clipped past its identity compares as NOTHING (`null`),
 *     never by falling back to substring containment.
 */

/**
 * The Rust panic header, anchored at line start so the word `panicked` inside
 * prose or a test's own output cannot classify. libtest prints the failing
 * verdict as TWO lines: this header (test name, file, line) with the message
 * on the NEXT line; the pairing is a stream concern and lives in
 * `extractSpecificAssertion`, not here.
 */
export const RUST_PANIC_RE = /^thread\s+'[^']+'\s+panicked\s+at\s+\S/;

/** The test name a panic header carries, or `undefined` if it does not parse. */
const RUST_PANIC_NAME_RE = /^thread\s+'([^']+)'\s+panicked\s+at\s/;
export function rustPanicTestName(header: string): string | undefined {
  return RUST_PANIC_NAME_RE.exec(header)?.[1];
}

/**
 * #2341 — the SAMENESS key of a Rust panic assertion. The extractor joins
 * the header and its message for the operator-facing value; two runs of the
 * SAME failing test print that pair byte-identically, and two DIFFERENT
 * failing tests in one target differ exactly in the header (test name,
 * file, line, column). So the header alone — the `thread '<name>' panicked
 * at <loc>:` token run up to its trailing colon, followed by whitespace or
 * end of string — is the identity the sameness comparison anchors on.
 *
 * What the key guarantees, stated exactly: a clip that falls in the MESSAGE
 * cannot fold two failures, because the message is what the key discards. A
 * clip that falls INSIDE the header fails CLOSED (#2341 fix wave M1): a string
 * that starts like a panic header (`^thread '`) but whose identity (test name
 * / file:line:col) cannot be extracted answers `null`, and `null` is the
 * answer no sameness reader may turn into a "SAME assertion" claim — the
 * pre-fix fallback to the whole clipped string was the substring-containment
 * rule this ticket exists to remove, reachable again through the one dialect
 * that anchors sameness on a header. Any other assertion (every other shape,
 * and the pre-1.73 inline form whose token run does not end at a colon) is its
 * own key — exact containment is unchanged for it.
 */
const RUST_PANIC_HEADER_FORM = /^(thread\s+'[^']+'\s+panicked\s+at\s+\S+:)(?:\s|$)/;
const PANIC_HEADER_LOOK_RE = /^thread\s+'/;

/**
 * The identity a Rust panic assertion compares on; other assertions are
 * theirs. `null` when the string starts like a panic header but its identity
 * could not be extracted — a caller must treat `null` as "compares as
 * nothing", never as a key to match on.
 */
export function rustPanicSamenessKey(assertion: string): string | null {
  const header = RUST_PANIC_HEADER_FORM.exec(assertion)?.[1];
  if (header !== undefined) return header;
  return PANIC_HEADER_LOOK_RE.test(assertion) ? null : assertion;
}

/**
 * #2341 round 1 — libtest's own per-test verdict lines, the two forms it
 * prints: `test <name> ... ok` / `... FAILED` and the per-target tally
 * `test result: ok. N passed; M failed` / `test result: FAILED. …`. Asked
 * ONLY to decide whether a `thread '…' panicked at …` line in a window
 * reports the run's failing verdict or the CAPTURED STDOUT of a passing
 * `#[should_panic]` test, which prints the identical shape on a GREEN run.
 */
const LIBTEST_VERDICT_RE = /^test\s+(?:\S+\s+\.\.\.\s+|result:\s*)(?:ok|FAILED)\b/;
const LIBTEST_FAILING_VERDICT_RE =
  /^test\s+(?:\S+\s+\.\.\.\s+|result:\s*)FAILED\b|\b[1-9]\d*\s+(?:failed|failures?)\b/;

/**
 * True when `line` is one of libtest's own verdict lines. Asked by the
 * extractor so a verdict line is never JOINED into an assertion the way a
 * panic MESSAGE is: a verdict the success veto has just cleared is invisible
 * to `classifyFailureLine`, so the join guard cannot rely on the table alone.
 */
export function isLibtestVerdictLine(line: string): boolean {
  return LIBTEST_VERDICT_RE.test(line);
}

/**
 * The tri-state answer to "does this window show libtest FAILING a test?"
 * (the #746/#798 doctrine: an absent observation is never a verdict). The
 * fallback of {@link libtestVerdictForTest} when the window holds no per-test
 * line for the header's name; internal to this module because every reader
 * asks the name-correlated question, which is the one that cannot be fooled
 * by a passing `#[should_panic]` print beside an unrelated failing verdict.
 *
 *   - `true`  — the window carries a failing libtest verdict.
 *   - `false` — the window carries libtest verdicts and NONE of them failed.
 *   - `undefined` — the window carries no libtest verdict at all (a truncated
 *     1500-char tail, a hand-built single-line fixture). Nothing was observed,
 *     so nothing is vetoed.
 */
function libtestWindowVerdict(lines: readonly string[]): boolean | undefined {
  let seen = false;
  for (const line of lines) {
    if (!LIBTEST_VERDICT_RE.test(line)) continue;
    seen = true;
    if (LIBTEST_FAILING_VERDICT_RE.test(line)) return true;
  }
  return seen ? false : undefined;
}

/** libtest's per-test verdict line, with the test name captured. */
const LIBTEST_PER_TEST_VERDICT_RE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED)\b/;

/**
 * The NAME-correlated answer to "does this window report test `<name>` as
 * FAILED?" (#2341 fix wave H1) — the ONE predicate the extractor's
 * `should_panic` veto and the evidence-anchor walk (`work-driver-exec-error.ts`)
 * both ask, so the veto and the anchor cannot disagree about which panic
 * names a failing test. A per-test verdict line for THIS name is decisive
 * (libtest prints one per test it ran, so a passing `#[should_panic]` test's
 * captured print sits beside its own `... ok`, whatever other test the window
 * shows failing). With no per-test line for the name the answer is the
 * window's tri-state ({@link libtestWindowVerdict}): a clipped window must
 * not veto a header the run really did fail on, and an unobserved verdict
 * vetoes nothing.
 */
export function libtestVerdictForTest(
  lines: readonly string[],
  name: string | undefined,
): boolean | undefined {
  let verdict: boolean | undefined;
  if (name !== undefined) {
    for (const line of lines) {
      const m = LIBTEST_PER_TEST_VERDICT_RE.exec(line);
      if (m !== null && m[1] === name) verdict = m[2] === "FAILED";
    }
  }
  return verdict ?? libtestWindowVerdict(lines);
}

/**
 * #2341 — cargo's TRAILING TARGET-LEVEL summaries: the lines cargo prints about
 * a whole target or a whole test process, every one of them byte-identical
 * across the different tests that failed inside it (`error: test failed, to
 * rerun pass \`--bin nessie\``, `error: process didn't exit successfully:
 * …(signal: 6, SIGABRT)`, `error: 1 target failed:`, `error: could not
 * compile \`nessie\``). They name a TARGET or a PROCESS, never a check, so the
 * rule is dialect-shaped rather than sentence-shaped: any line in cargo's
 * `error:` dialect that carries NO file:line location is target-level. That is
 * what the table's own `diagnostic` arm cannot decide on its own — that arm is
 * one regex over four unrelated compiler dialects and treats every `error:`
 * line as naming a check, which is how a target-level line below the last
 * panic both stole the evidence anchor and became "the assertion at base", and
 * how two different Rust tests once compared as the SAME assertion.
 *
 * The location test is what keeps this from eating real evidence: a compiler
 * diagnostic carries its file (`src/a.rs:91:5`, `--> src/a.rs:9:5`,
 * `src/a.ts(9,5)`), a target summary carries only the target name. A line with
 * a location therefore stays a `diagnostic` and keeps `namesTest: true`.
 *
 * #2341 fix wave (H2) — the location alternatives are ONE string source, asked
 * by this lookahead AND by the rustc-code test below: two regex literals
 * spelling "has a file location" differently is how the two readers drift
 * apart about which lines name a check.
 */
const FILE_LOCATION_SRC = String.raw`\S+\.[A-Za-z]{1,6}:\d+|-->\s*\S+|\S+\([\d,]+\)`;
const HAS_FILE_LOCATION_RE = new RegExp(FILE_LOCATION_SRC);
export const CARGO_TARGET_SUMMARY_RE = new RegExp(
  String.raw`^error:?\s+(?![^\r\n]*(?:${FILE_LOCATION_SRC}))(?:test failed\b|process didn't exit successfully\b|\d+\s+targets?\s+failed\b|could not compile\b|could not find\b|no such subcommand\b|aborting due to\b)`,
);

/**
 * The ONE predicate for cargo's target-level summaries (#2341) — asked by the
 * table's shape entry AND by every sameness reader, so the two cannot disagree
 * about which lines are too generic to buy a "SAME assertion" claim. Exported
 * through `work-driver-verify-failures.ts` with the rest of the failure-line
 * vocabulary.
 */
export function isCargoTargetSummaryLine(line: string): boolean {
  return CARGO_TARGET_SUMMARY_RE.test(line);
}

/**
 * #2341 fix wave (H2) — rustc's error-code dialect WITHOUT a location. cargo
 * prints `error[E0308]: …` and the `--> file:line:col` on SEPARATE lines, so
 * the `error[…]` line alone is byte-identical across compile failures in
 * different files: quoted as "the assertion" it folds them together, and
 * `baselineExplainsChange` excuses the regression the fold hides. Asked by the
 * `diagnostic` table entries (a location-less line keeps the shape but not the
 * naming right) and by every sameness reader, so the two cannot disagree.
 */
const RUSTC_ERROR_CODE_RE = /error\[E\d+\]/;
export function isLocationlessRustcDiagnostic(line: string): boolean {
  return RUSTC_ERROR_CODE_RE.test(line) && !HAS_FILE_LOCATION_RE.test(line);
}
