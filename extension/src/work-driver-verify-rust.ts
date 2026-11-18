/**
 * work-driver-verify-rust — the Rust/cargo READER dialect of the failure-line
 * vocabulary: what a cargo/libtest line says about which TEST failed, and
 * which lines are too generic to name one.
 *
 * Split out of `work-driver-verify-shapes.ts` along the natural seam
 * (AGENTS.md §12 file-size cap): that module's own header reserves it for the
 * TABLE DATA — the shape entries, their priority order, the pre-veto exemption
 * pair. The #2341 fix wave added the predicates that have to SCAN a whole
 * stream and decide, per test name, whether the run reported it as PASSING
 * ({@link panicIsCapturedPrint}) or reported it AT ALL
 * ({@link panicCanExcuseChange}) — stream-scanning LOGIC, which does not
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
 * The Rust panic header's opening token run, spelled ONCE (#2341 fix wave H2).
 * Every reader that recognises a panic header composes its regex from THIS
 * source: the table's line-anchored shape, the name reader, and the
 * anywhere-in-text recognizer both gates ask. Four literals spelling the same
 * token run is four answers to "is this a panic header", and the drift between
 * them is how a `warning:`-prefixed or record-lifted header ended up neither
 * vetoed as a quote nor gated as an excuse — the same header token run, read two
 * ways. The sameness key's `RUST_PANIC_HEADER_FORM` composes from here too (it
 * additionally demands the identity's trailing colon); {@link PANIC_HEADER_LOOK_RE}
 * stays its own looser literal on purpose — it asks "does this merely OPEN like a
 * header", which is the fail-closed question, not the parse.
 */
const RUST_PANIC_OPEN_SRC = String.raw`thread\s+'([^']+)'\s+panicked\s+at\s`;

/** The header's location token — the separator-free run after `panicked at `. */
const RUST_PANIC_LOC_SRC = String.raw`\S+`;

/**
 * The header anchored at line start — what the failure table's `rust-panic`
 * shape entry asks, and what reads the test name out of a header the caller
 * already holds. A gate's own prefix (`warning:`, a timestamp, `[INFO]`, an
 * ANSI colour, the harness's record sentence) is NOT a panic header in this
 * position; {@link rustPanicHeaderIn} is the arm that sees through one.
 */
export const RUST_PANIC_RE = new RegExp(String.raw`^${RUST_PANIC_OPEN_SRC}${RUST_PANIC_LOC_SRC}`);

/**
 * The same header, searched for anywhere in a text. `g` so ONE spelling serves
 * both "the first header in this text" ({@link rustPanicHeaderIn}) and "every
 * header this record carries" ({@link changePanicsAreBaseFailures}); both go
 * through `matchAll`, which works on a CLONE of this regex, so the shared
 * instance's `lastIndex` is never advanced by a reader.
 */
const RUST_PANIC_GLOBAL_RE = new RegExp(
  String.raw`${RUST_PANIC_OPEN_SRC}${RUST_PANIC_LOC_SRC}`,
  "g",
);

/** The test name a panic header carries, or `undefined` if it does not parse. */
export function rustPanicTestName(header: string): string | undefined {
  return RUST_PANIC_RE.exec(header)?.[1];
}

/**
 * The panic header carried ANYWHERE in `text`, prefix and all, or `undefined`.
 * Returns the matched header token run — the text from `thread` through the
 * `file:line:col` — so a caller can hand the answer straight back to
 * {@link rustPanicTestName} and every other line-anchored header reader.
 *
 * THE ONE RECOGNIZER (#2341). The quote veto used to ask the table's shape key
 * and the excuse gate its own line-anchored look; a header the gate printed with
 * a prefix satisfied neither, so it could be quoted as captured output AND grant
 * an excuse. Every panic decision asks THIS instead, through the one global
 * spelling above, so they cannot drift apart again:
 * `extractSpecificAssertion` (the quote), {@link panicCanExcuseChange} (the
 * excuse) and {@link changePanicsAreBaseFailures} (the excuse, per failing test
 * of the change's record). A text this answers `undefined` for is not a panic to
 * any of them.
 */
export function rustPanicHeaderIn(text: string): string | undefined {
  return text.matchAll(RUST_PANIC_GLOBAL_RE).next().value?.[0];
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
const RUST_PANIC_HEADER_FORM = new RegExp(
  String.raw`^(${RUST_PANIC_OPEN_SRC}${RUST_PANIC_LOC_SRC}:)(?:\s|$)`,
);
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
 * `a::t::nested`, and a doctest's SPACED verdict path
 * (`test src/lib.rs - name (line 3) ... ok`) is read rather than silently
 * unmatched — a `\S+` group there would make that whole class undecidable, and
 * `test-verify-rust-veto-sweep.ts` carries one capture case with such a path so
 * the re-spell goes red. This line is the ONLY evidence
 * {@link panicIsCapturedPrint} and {@link panicCanExcuseChange} consult, and
 * each line speaks for exactly one test.
 */
const LIBTEST_PER_TEST_VERDICT_RE = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED)\b/;

/**
 * The verdict libtest's per-test lines report for the EXACT `name` — `"ok"`
 * MONOTONICALLY (any `ok` wins, so a later `FAILED` for the same name cannot
 * unshield an earlier passing capture), `"FAILED"` when the name was seen
 * failing and never ok, `undefined` when NO per-test line names it. One scan
 * and one rule for both predicates below: they may never disagree about what
 * the stream said about a name.
 */
function perTestVerdictFor(stream: string, name: string): "ok" | "FAILED" | undefined {
  let verdict: "ok" | "FAILED" | undefined;
  for (const raw of stream.split("\n")) {
    const m = LIBTEST_PER_TEST_VERDICT_RE.exec(raw.trim());
    if (m === null || m[1] !== name) continue;
    if (m[2] === "ok") return "ok";
    verdict ??= "FAILED";
  }
  return verdict;
}

/**
 * The ONE question the `#[should_panic]` QUOTE gate asks (#2341): does the
 * stream report this `thread '<name>' panicked at …` print's OWN test as
 * passing? Its ONLY admissible evidence is one per-test verdict line for the
 * header's exact name, and it is the quote's only gate — the excuse has its own
 * rule ({@link panicCanExcuseChange}).
 * `true` means quoting it would be the #746/#798 class — a confident wrong
 * answer where honest absence was the truth. The directions are NOT
 * symmetric: `(no specific assertion could be extracted)` is loud, visible, and
 * costs one round, while a wrong quote spends the cycle's one corrective round
 * on a test that passes (silent, unrecoverable) — so every ambiguity resolves
 * toward NOT quoting. The two gates stay independent: even a print this gate
 * did not refuse cannot excuse anything, because {@link panicCanExcuseChange}
 * asks its own question of the same lines.
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
 * no test the run reported, so this predicate does not veto them and their
 * captured prints are QUOTED. `main` recognises no Rust panic line at all, so
 * those streams reported honest absence there — the cargo/libtest dialect, and
 * the quoting with it, is this module's — and what the shipped code does about
 * them instead of guessing is {@link panicCanExcuseChange}: they stay quotable
 * to the operator and never excuse a failure the change added. Refusing the
 * QUOTE too needs cargo's per-target banner identity (`     Running unittests
 * src/main.rs (…)`, `   Doc-tests pkg`) — the one thing that separates an
 * enclosing run's aggregate verdict, or a sibling crate's verdict, from this
 * header's own test. The same absence is what makes a workspace in which two
 * crates use the same test name DELIBERATELY OVER-REFUSE the second crate's
 * real panic (see OBSERVED PASSING: any ok for the name wins).
 *
 * The #1762 counterweight follows from the same rule: an early green STAGE
 * followed by a later binary dying as `main` has no `test main ... ok` line,
 * so that panic anchors and quotes.
 */
export function panicIsCapturedPrint(stream: string, name: string | undefined): boolean {
  if (name === undefined) return false;
  return perTestVerdictFor(stream, name) === "ok";
}

/**
 * The excuse gate for a Rust-legible base assertion, and the only one: a panic
 * header excuses a change-added failure ONLY when the base run's OWN per-test
 * verdict line reports its exact test name as `FAILED`. Nothing else is
 * admissible — not an `ok`, not an unobserved name, not the target-level
 * `test result:` tally, not a `---- <name> stdout ----` block label. Text that
 * is not a panic header is not this rule's to refuse, so it answers `true` and
 * the classic containment rule decides. {@link panicIsCapturedPrint} is the
 * quote's only gate: the two ask different questions of the same lines, and they
 * fail in opposite directions — this one refuses to excuse, that one never
 * refuses to quote.
 */
export function panicCanExcuseChange(stream: string, assertion: string): boolean {
  const header = rustPanicHeaderIn(assertion);
  if (header === undefined) return true;
  const name = rustPanicTestName(header);
  return name !== undefined && perTestVerdictFor(stream, name) === "FAILED";
}

/**
 * #2341 fix wave (HIGH 3, and the SECURITY MEDIUM beside it) — the change side of
 * the excuse, asked PER FAILING TEST.
 *
 * The defect. The develop gate hands `baselineExplainsChange` ONE entry whose text
 * is the whole consolidated failure output, and `sharesAssertion` is substring
 * containment over it: the base's single assertion matching anywhere in that blob
 * excused EVERY failure inside it, including a different Rust panic the change
 * introduced below it. The base side pays a real question
 * ({@link panicCanExcuseChange} demands the base run's own per-test `FAILED` line)
 * while the change side paid nothing but containment over its own UNTRUSTED text.
 * So this asks the SAME predicate of BOTH runs, for EVERY header the enumerated
 * text carries and not merely the first — that text may be one flattened line:
 *
 *   - the BASE run must have reported that test as `FAILED`, or the panic is
 *     evidence about a failure only the change has;
 *   - the CHANGE's own run must report that test as `FAILED` too, or nothing in
 *     it says the panic is a failure of this run rather than text the record
 *     quoted;
 *   - a header whose own test the CHANGE run reports `ok` is that test's
 *     `#[should_panic]` captured print and is SKIPPED, never asked: the base
 *     prints no verdict line for a test that passes there, so an asked capture
 *     answers "not a base failure" and refuses an excuse the flaky test earned.
 *     The skip is what makes the enumeration over the whole run safe.
 *
 * `record` is the published text being excused and `changeStream` the run's OWN
 * output, which is the only text that can answer the second question: a
 * per-worktree record is a clipped, formatted tail whose elision sits above the
 * name's verdict line, and asking a clipped record to speak for its own stream
 * judges bytes the clipping edited — the defect the record publishers already
 * thread the raw run against. The headers are therefore enumerated over BOTH: the
 * record's, because a header it QUOTES that the run never printed is the
 * untrusted-text case this predicate exists for, and the run's, because the
 * identical clipping that hides the verdict line also hides a second panic's
 * HEADER — a header the clip dropped was never asked, so the change-added
 * regression read as no failure at all and the known flaky's excuse covered it.
 * Enumerating the whole run is what makes a passing test's captured print have to
 * be skipped below rather than left to the clip to hide.
 *
 * The direction is the loud one, and it is the accepted cost: a change run that
 * prints a panic header for a name it reports no verdict for loses the excuse and
 * the cycle parks as an ordinary `verify-failed:develop`, which is one round.
 */
export function changePanicsAreBaseFailures(
  record: string,
  changeStream: string,
  baseStream: string,
): boolean {
  const seen = new Set<string>();
  // EVERY header either text raises: the record's, because a header it QUOTES that
  // the run never printed is the untrusted-text case this predicate exists for,
  // and the run's, because the record's clip drops headers entirely.
  for (const text of [record, changeStream]) {
    for (const match of text.matchAll(RUST_PANIC_GLOBAL_RE)) {
      const header = match[0];
      if (seen.has(header)) continue;
      seen.add(header);
      // The rule above: this run reports the header's own test `ok`, so the header
      // is that test's `#[should_panic]` captured print and asks no question.
      const name = rustPanicTestName(header);
      if (name !== undefined && perTestVerdictFor(changeStream, name) === "ok") continue;
      if (!panicCanExcuseChange(baseStream, header)) return false;
      if (!panicCanExcuseChange(changeStream, header)) return false;
    }
  }
  return true;
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
