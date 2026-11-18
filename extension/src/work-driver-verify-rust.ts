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
function libtestWindowVerdict(window: string): boolean | undefined {
  let seen = false;
  for (const raw of window.split("\n")) {
    const line = raw.trim();
    if (!LIBTEST_VERDICT_RE.test(line)) continue;
    seen = true;
    if (LIBTEST_FAILING_VERDICT_RE.test(line)) return true;
  }
  return seen ? false : undefined;
}

/** libtest's per-test verdict line, with the test name captured. */
const LIBTEST_PER_TEST_VERDICT_RE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED)\b/;

/**
 * The verdict LINE the stream prints for test `name` — the last one, since
 * libtest prints one per test it ran — or `undefined` when it prints none.
 *
 * NAME-CORRELATED ONLY, and that is the whole point (#2341 fix wave 5): this
 * never considers the target-level `test result: …` tally, which reports on a
 * whole TARGET. A `.pi/verify-cmd` chain whose earlier `cargo test` stage was
 * GREEN (`test result: ok. 3 passed; 0 failed`) and whose LATER stage's binary
 * died (`thread 'main' panicked at src/main.rs:12:5:`) has no verdict for
 * `main` at all, and an unobserved verdict is not a verdict AGAINST it — the
 * aggregate answer "this target passed" used to be read as that, which
 * restored #1762's unactionable generic handoff for the chain shape this
 * module's own header describes.
 */
export function perTestVerdictLine(text: string, name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  let line: string | undefined;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    const m = LIBTEST_PER_TEST_VERDICT_RE.exec(t);
    if (m !== null && m[1] === name) line = t;
  }
  return line;
}

/**
 * The name-correlated tri-state over `text`: `true` FAILED, `false` ok,
 * `undefined` when the text holds no per-test line for `name` — never the
 * aggregate ({@link perTestVerdictLine} for why that distinction is the rule).
 */
export function perTestVerdictOnly(text: string, name: string | undefined): boolean | undefined {
  const line = perTestVerdictLine(text, name);
  return line === undefined ? undefined : LIBTEST_PER_TEST_VERDICT_RE.exec(line)?.[2] === "FAILED";
}

/** A target summary that closed its run GREEN (`test result: ok. …`). */
const PASSING_TARGET_SUMMARY_RE = /^test\s+result:\s*ok\b/;

/**
 * The text that may speak about the panic print `header`: `text` with every
 * COMPLETED GREEN TARGET dropped from its head. libtest closes a whole target
 * with `test result: ok. N passed; 0 failed`; every verdict line above that
 * line — including a name-correlated `test X ... ok` — is the verdict of the
 * binary that finished BEFORE this header, and libtest test names are
 * per-binary module paths, so a sibling crate of one `cargo test --workspace`
 * prints a byte-identical name for a DIFFERENT test. Asking the whole stream
 * imported that foreign verdict and refused a later target's real panic whose
 * own verdict never reached the stream (the binary aborted after the panic
 * print) — #2341 fix wave 6. A run that never printed its summary (it died)
 * drops nothing; an unobserved verdict still vetoes nothing.
 *
 * `header` absent from `text` (a hand-built tail, a caller quoting a line the
 * stream does not hold) asks the whole text — the pre-region behaviour, which
 * is the only honest reading when no position is known.
 */
export function panicEvidenceRegion(text: string, header: string | undefined): string {
  if (header === undefined) return text;
  const at = text.lastIndexOf(header);
  if (at === -1) return text;
  let end = 0;
  let offset = 0;
  for (const line of text.slice(0, at).split("\n")) {
    const t = line.trim();
    if (PASSING_TARGET_SUMMARY_RE.test(t) && !LIBTEST_FAILING_VERDICT_RE.test(t)) {
      end = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  return text.slice(end);
}

/**
 * The answer to "does the text `window` report test `<name>` as FAILED?" for
 * the WINDOW the extractor is about to be handed (#2341 fix wave H1) — the
 * predicate its `should_panic` veto asks, and the one the evidence-anchor walk
 * asks on the same bytes it publishes (`work-driver-exec-error.ts`), so the
 * veto and the anchor cannot disagree about which panic names a failing test.
 * A per-test verdict line for THIS name is decisive (libtest prints one per
 * test it ran, so a passing `#[should_panic]` test's captured print sits
 * beside its own `... ok`, whatever other test the window shows failing).
 * With no per-test line for the name the answer is the window's tri-state
 * ({@link libtestWindowVerdict}): a clipped window must not veto a header the
 * run really did fail on, and an unobserved verdict vetoes nothing.
 *
 * The aggregate fallback is WINDOW-scoped by contract, and that is what the
 * tail publisher is load-bearing for (#2341 fix wave 5, H1/H2): the window
 * `extractAttributedTail` publishes carries, for every panic header it shows,
 * the stream's own per-test verdict line for that header's name (see
 * `carryVerdicts` in `work-driver-exec-error.ts`), so the per-test arm below
 * answers whenever the stream holds a verdict at all. The fallback is then
 * what it should be — the verdict of the target the window shows — and the
 * whole-stream question is asked separately, name-correlated, by
 * {@link perTestVerdictOnly}. Asking the whole stream THROUGH this predicate
 * was the wave-4 defect: it let an earlier, greener stage's tally answer a
 * later stage's question.
 */
export function libtestVerdictForTest(
  window: string,
  name: string | undefined,
): boolean | undefined {
  return perTestVerdictOnly(window, name) ?? libtestWindowVerdict(window);
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
