/**
 * work-driver-verify-rust — the Rust/cargo READER dialect of the failure-line
 * vocabulary: what a cargo/libtest line says about which TEST failed, and
 * which lines are too generic to name one.
 *
 * Split out of `work-driver-verify-shapes.ts` along the natural seam
 * (AGENTS.md §12 file-size cap): that module's own header reserves it for the
 * TABLE DATA — the shape entries, their priority order, the pre-veto exemption
 * pair. The #2341 fix wave added the one predicate that has to SCAN a whole
 * stream and decide, per test name, whether the run reported it as PASSING
 * ({@link panicIsCapturedPrint}) — stream-scanning LOGIC, which does not
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
 * that anchors sameness on a header. The fail-closed half is asked of
 * anything that merely LOOKS like a header (`^thread '`), which includes the
 * pre-1.73 inline form (`thread 'main' panicked at '…', src/main.rs:5:5`):
 * its token run does not end at a colon, its identity is not what the key
 * extracts, and a quote that only resembles a parseable header compares as
 * nothing rather than reopening the containment rule. Any other assertion —
 * every shape that does not open with the panic look — is its own key; exact
 * containment is unchanged for it.
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
 * #2341 round 1 — libtest's own verdict lines, the two forms it prints: the
 * per-test `test <name> ... ok` / `... FAILED` and the per-target tally
 * `test result: ok. N passed; M failed` / `test result: FAILED. …`. Asked by
 * {@link isLibtestVerdictLine} as the join guard. The per-target tally is not
 * asked by {@link panicIsCapturedPrint} at all: it reports on a whole TARGET
 * and has no authority over one header's test, so the veto's only evidence is
 * the per-test line for the header's exact name.
 */
const LIBTEST_VERDICT_RE = /^test\s+(?:\S+\s+\.\.\.\s+|result:\s*)(?:ok|FAILED)\b/;

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
 * libtest's per-test verdict line, with the test NAME and its verdict both
 * captured. The name group is the WHOLE span between `test ` and ` ... `,
 * compared with `===`, so `a::t` is answered for by neither `a::t2` nor
 * `a::t::nested`, and a verdict path that carries spaces is read rather than
 * silently unmatched. This line is the ONLY evidence
 * {@link panicIsCapturedPrint} consults, and each line speaks for exactly one
 * test.
 */
const LIBTEST_PER_TEST_VERDICT_RE = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED)\b/;

/**
 * The ONE question the `#[should_panic]` veto asks (#2341): does the stream
 * report this `thread '<name>' panicked at …` print's OWN test as passing?
 * `true` means quoting it would be the #746/#798 class — a confident wrong
 * answer where honest absence was the truth. The directions are NOT
 * symmetric: quoting a passing capture makes
 * `baselineExplainsChange` excuse a failure the change added and spend the
 * cycle's one corrective round on a test that passes (silent, unrecoverable),
 * while `(no specific assertion could be extracted)` is loud, visible, and
 * costs one round — so every ambiguity resolves toward NOT quoting.
 *
 * The predicate IS the observed-passing question, asked over the WHOLE stream,
 * never a window (a window's elision is what made the verdict invisible; that
 * was fix wave 4's defect). Two observations, one answer:
 *
 *   - OBSERVED PASSING — MONOTONE. ANY per-test verdict line whose name
 *     equals `name` byte-for-byte and reads `ok` vetoes. Not the last word
 *     for the name: a stream holding `test x ... ok` and a later
 *     `test x ... FAILED` printed the same-named test TWICE (two crates of
 *     one workspace run the same name), and under last-word semantics the
 *     later FAILED unshielded the FIRST test's passing capture — the exact
 *     #746 fold. Any-ok only ever ADDS refusals (the loud direction).
 *   - OBSERVED FAILING OR NOT REPORTED. With no `ok` line for the exact name —
 *     a `FAILED` line and no `ok`, or no verdict line at all — the answer is
 *     `false`, whatever surrounds the header. A `FAILED` verdict attributes a
 *     real failure to this name, so the print quotes; with NO verdict for the
 *     name there is simply no evidence that the print belongs to a passing
 *     test, and the predicate does not infer one from the surroundings. The
 *     target-level tally describes the TARGET and the `---- <name> stdout ----`
 *     label names the block's own test — neither says which test printed this
 *     header, so neither may attribute it away. Guessing from either was the
 *     unsound step, and the loud-safe direction is the one already taken
 *     everywhere else in this predicate.
 *
 * KNOWN LIMITATION, stated plainly: a panic on a NON-TEST thread inside an
 * otherwise green target (`worker-N`, `tokio-runtime-worker`, `<unnamed>`) and
 * a `#[should_panic]` DOCTEST (header `thread 'main' panicked at
 * src/lib.rs:5:5:`, verdict line `test src/lib.rs - name (line 3) ... ok`) name
 * no test the run reported, so their captured prints are still quotable and
 * `baselineExplainsChange` can then excuse a failure the change added. This is
 * the behaviour `main` has, not one this module added. Closing it needs
 * cargo's per-target banner identity (`     Running unittests src/main.rs (…)`,
 * `   Doc-tests pkg`) — the one thing that separates an enclosing run's
 * aggregate verdict, or a sibling crate's verdict, from this header's own test;
 * until a banner-based region exists, those two classes are quoted rather than
 * guessed away. The same absence is what makes a workspace in which two crates
 * use the same test name DELIBERATELY OVER-REFUSE the second crate's real
 * panic (see OBSERVED PASSING: any ok for the name wins).
 *
 * The #1762 counterweight follows from the same rule: an early green STAGE
 * followed by a later binary dying as `main` has no `test main ... ok` line,
 * so that panic anchors and quotes.
 */
export function panicIsCapturedPrint(stream: string, name: string | undefined): boolean {
  if (name === undefined) return false;
  let okSeen = false;
  for (const raw of stream.split("\n")) {
    const m = LIBTEST_PER_TEST_VERDICT_RE.exec(raw.trim());
    if (m !== null && m[1] === name && m[2] === "ok") okSeen = true;
  }
  return okSeen;
}

/**
 * #2341 — cargo's TARGET-LEVEL `error:` lines: the lines cargo prints about a
 * whole target or a whole test process, byte-identical across the different
 * tests that failed inside it (`error: test failed, to rerun pass \`--bin
 * nessie\``, `error: process didn't exit successfully: …(signal: 6, SIGABRT)`,
 * `error: 1 target failed:`, `error: build failed`, `error: failed to run
 * custom build command for \`nessie v0.1.0\``). They name a TARGET or a
 * PROCESS, never a check, so the rule IS the dialect the sentence list only
 * imitated: any line opening in cargo's `error:` dialect that carries NEITHER
 * a file location NOR an identity code is target-level. That is what the
 * table's own `diagnostic` arm cannot decide on its own — that arm is one
 * regex over four unrelated compiler dialects and treats every `error:` line
 * as naming a check, which is how a generic line below the last panic both
 * stole the evidence anchor and became "the assertion at base", and how two
 * different Rust tests once compared as the SAME assertion.
 *
 * The two lookaheads are what keeps this from eating real evidence, and they
 * are NOT symmetric — the asymmetry is the rule: a file LOCATION is searched
 * for anywhere on the line (`src/a.rs:91:5`, `--> src/a.rs:9:5`,
 * `src/a.ts(9,5)`), because a diagnostic prints its location wherever the
 * gate laid it out; an identity CODE is checked only at the position right
 * after the opening `error:` token (`error[E0308]`, `error TS2345`), because
 * that position is where the COMPILER dialects print their own verdict, while
 * a code quoted later sits in cargo's target-level prose — which stays
 * target-level. A line whose identity code leads therefore stays a
 * `diagnostic` (or, location-less, `diagnostic-unlocated` — see the table);
 * a location-less, code-leading-free prose line names no check and does not
 * earn the quote — the handoff reports honest absence instead.
 *
 * #2341 fix wave (H2) and F1 / fix wave 4 (H4) — both alternatives are ONE
 * string source each: `FILE_LOCATION_SRC` is asked by this lookahead AND by
 * the location-less code-diagnostic test below, `DIAGNOSTIC_IDENTITY_SRC` by
 * this lookahead, that same test, AND by the table's `DIAGNOSTIC_RE`.
 * Two regex literals spelling "has a file location" or
 * "carries an identity code" differently is how the readers drift apart about
 * which lines name a check — H4 was exactly that drift, a private
 * `/error\[E\d+\]/` copy that let the tsc dialect through the rule built to
 * refuse it.
 */
const FILE_LOCATION_SRC = String.raw`\S+\.[A-Za-z]{1,6}:\d+|-->\s*\S+|\S+\([\d,]+\)`;
const HAS_FILE_LOCATION_RE = new RegExp(FILE_LOCATION_SRC);

/**
 * The identity arms of the driver's `diagnostic` dialect — rustc's error code
 * and tsc's — as the ONE source asked by the table's `DIAGNOSTIC_RE`
 * (`work-driver-verify-shapes.ts`) and by the target-summary lookahead above
 * (#2341 F1): whether a line carries a code that identifies the failed check
 * has exactly one answer across the table.
 */
export const DIAGNOSTIC_IDENTITY_SRC = String.raw`error\[E\d+\]|\bTS\d{4,}\b`;

export const CARGO_TARGET_SUMMARY_RE = new RegExp(
  String.raw`^error:?\s+(?![^\r\n]*(?:${FILE_LOCATION_SRC}))(?!(?:${DIAGNOSTIC_IDENTITY_SRC}))`,
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
 * #2341 fix wave (H2) / fix wave 4 (H4) — an identity-code diagnostic line
 * (`error[E0308]: …`, `error TS2345: …`) WITHOUT a location. cargo prints the
 * `--> file:line:col` on a SEPARATE following line, and a flattening gate can
 * amputate tsc's prefix, so the bare line is byte-identical across failures
 * in different files: quoted as "the assertion" it folds them together, and
 * `baselineExplainsChange` excuses the regression the fold hides. The identity
 * test is the SHARED `DIAGNOSTIC_IDENTITY_SRC` — the one source the table's
 * `DIAGNOSTIC_RE` and the target-summary lookahead also ask — so every
 * identity dialect (rustc bracket AND tsc `TS\d{4,}`) meets the same rule;
 * the fix wave's defect was a private `/error\[E\d+\]/` that let the tsc
 * dialect slip through the rule built to refuse exactly it. Asked by the
 * table's location-split entries and by every sameness reader, so the two
 * cannot disagree.
 */
const DIAGNOSTIC_IDENTITY_RE = new RegExp(DIAGNOSTIC_IDENTITY_SRC);
export function isLocationlessCodeDiagnostic(line: string): boolean {
  return DIAGNOSTIC_IDENTITY_RE.test(line) && !HAS_FILE_LOCATION_RE.test(line);
}
