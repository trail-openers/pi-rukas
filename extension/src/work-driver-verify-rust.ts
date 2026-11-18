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
 * {@link isLibtestVerdictLine} as the join guard, and by
 * {@link panicIsCapturedPrint} ONLY to bracket a run region for the
 * unobserved-name class — it NEVER answers the per-name question, because
 * the tally reports on a whole TARGET and has no authority over one
 * header's test.
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
 * `a::t::nested` — and a doctest's spaced path (`src/lib.rs - name (line 3)`),
 * which a `\S+` token could never equal, is capturable and comparable at all
 * (#2341: that matcher made the doctest class structurally unrefusable).
 */
const LIBTEST_PER_TEST_VERDICT_RE = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED)\b/;

/** libtest's per-target run opener, `running N test(s)`. */
const LIBTEST_RUN_BANNER_RE = /^running \d+ tests?\b/;

/** Any per-target tally line; brackets a run region alongside the opener. */
const LIBTEST_TARGET_RESULT_RE = /^test result:\s*(?:ok|FAILED)\b/;

/** A tally reporting the target closed with NOTHING failing. */
const LIBTEST_GREEN_CLOSE_RE = /^test result:\s*ok\.\s*\d+ passed;\s*0 failed\b/;

/**
 * cargo's captured-output block label, `---- <name> stdout ----`. Its presence
 * above a panic header is what separates a doctest print or a captured thread
 * dump (the block's own test's output) from a bare binary panic — and it needs
 * no cargo banner parsing, which stays a separate issue.
 */
const LIBTEST_BLOCK_HEADER_RE = /^----\s+(.+?)\s+stdout\s+----$/;

/**
 * The last per-test verdict libtest printed for the EXACT name, `undefined`
 * when the stream holds no verdict line for it at all. Used for the block
 * label's own name — a doctest block whose exact name the run reported `ok`
 * is a passing test's captured print.
 */
function perTestVerdictFor(lines: string[], name: string): "ok" | "FAILED" | undefined {
  let verdict: "ok" | "FAILED" | undefined;
  for (const line of lines) {
    const m = LIBTEST_PER_TEST_VERDICT_RE.exec(line);
    if (m !== null && m[1] === name) verdict = m[2] === "ok" ? "ok" : "FAILED";
  }
  return verdict;
}

/**
 * Is the header at line `i` sitting inside a `---- <block> stdout ----` capture
 * block whose own test the run reported `ok`? Walking up stops at a completed
 * tally or a fresh run opener: a block label from an earlier region does not
 * speak for this header — that is where #1762's chain shape prints, and it
 * must keep anchoring.
 */
function panicPrintUnderGreenBlock(lines: string[], i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const block = LIBTEST_BLOCK_HEADER_RE.exec(lines[k]);
    if (block !== null) return perTestVerdictFor(lines, block[1]) === "ok";
    if (LIBTEST_TARGET_RESULT_RE.test(lines[k]) || LIBTEST_RUN_BANNER_RE.test(lines[k])) {
      return false;
    }
  }
  return false;
}

/**
 * Is the header at line `i` printed INSIDE a libtest run that closed with
 * ZERO failures — a `running N tests` opener above it (with no completed
 * tally between), and a `test result: ok. N passed; 0 failed` tally below?
 * Such a run reported every test it ran and named none failing, so a panic
 * whose thread never appeared in any per-test verdict is the run's own
 * captured output (a worker-thread panic, a doctest print), not a verdict.
 * A run that never closed (aborted), or closed FAILED, attributes nothing
 * away from the print: it stays quotable.
 */
function panicPrintInsideGreenRun(lines: string[], i: number): boolean {
  let prevResult = -1;
  for (let k = i - 1; k >= 0; k--) {
    if (LIBTEST_TARGET_RESULT_RE.test(lines[k])) {
      prevResult = k;
      break;
    }
  }
  let runStart = -1;
  for (let k = i - 1; k > prevResult; k--) {
    if (LIBTEST_RUN_BANNER_RE.test(lines[k])) {
      runStart = k;
      break;
    }
  }
  if (runStart === -1) return false;
  for (let k = i + 1; k < lines.length; k++) {
    if (LIBTEST_TARGET_RESULT_RE.test(lines[k])) return LIBTEST_GREEN_CLOSE_RE.test(lines[k]);
  }
  return false;
}

/**
 * The ONE question the `#[should_panic]` veto asks (#2341): is this stream's
 * `thread '<name>' panicked at …` print the CAPTURED OUTPUT of something the
 * run did not report as failing? `true` means quoting it would be the
 * #746/#798 class — a confident wrong answer where honest absence was the
 * truth. The directions are NOT symmetric: quoting a passing capture makes
 * `baselineExplainsChange` excuse a failure the change added and spend the
 * cycle's one corrective round on a test that passes (silent, unrecoverable),
 * while `(no specific assertion could be extracted)` is loud, visible, and
 * costs one round — so every ambiguity resolves toward NOT quoting.
 *
 * Three tiers, in order:
 *
 *   - OBSERVED PASSING — MONOTONE. ANY per-test verdict line whose name
 *     equals `name` byte-for-byte and reads `ok` vetoes. Not the last word
 *     for the name: a stream holding `test x ... ok` and a later
 *     `test x ... FAILED` printed the same-named test TWICE (two crates of
 *     one workspace run the same name), and under last-word semantics the
 *     later FAILED unshielded the FIRST test's passing capture — the exact
 *     #746 fold. Any-ok only ever ADDS refusals (the loud direction).
 *   - OBSERVED FAILING. With a `FAILED` line and no `ok` line for the exact
 *     name, the run attributed a failure to this name — it is the real
 *     thing, and the print quotes.
 *   - UNOBSERVED NAME (no verdict line for it anywhere — a worker-thread
 *     panic, a doctest, a dying binary). Refused ONLY in the two shapes
 *     whose surrounding structure says the print is captured output: under a
 *     `---- <block> stdout ----` label whose exact name the run reported ok
 *     ({@link panicPrintUnderGreenBlock}), or inside a run whose tally
 *     closed with zero failures ({@link panicPrintInsideGreenRun}).
 *     Everything else — above all #1762's chain shape, an early green
 *     STAGE followed by a later binary dying as `main` with no capture
 *     label and no tally below — stays quotable: a bare binary panic named
 *     `main` has no verdict line and no enclosing green run, so it anchors.
 *
 * The name question is asked over the WHOLE stream, never a window (a
 * window's elision is what made the verdict invisible; that was fix wave 4's
 * defect). The target-level tally NEVER answers the name question — it only
 * brackets a region for the unobserved class. What could separate a sibling
 * crate's verdict from the header's own is cargo's per-target banner
 * (`     Running unittests src/main.rs (…)`, `   Doc-tests pkg`), which this
 * module deliberately does not parse: until a banner-based region exists (a
 * separate issue), a workspace in which two crates use the same test name
 * DELIBERATELY OVER-REFUSES the second crate's real panic.
 */
export function panicIsCapturedPrint(stream: string, name: string | undefined): boolean {
  if (name === undefined) return false;
  const lines = stream.split("\n").map((raw) => raw.trim());
  let okSeen = false;
  let failedSeen = false;
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = LIBTEST_PER_TEST_VERDICT_RE.exec(lines[i]);
    if (m !== null && m[1] === name) {
      if (m[2] === "ok") okSeen = true;
      else failedSeen = true;
    }
    if (RUST_PANIC_NAME_RE.exec(lines[i])?.[1] === name) headers.push(i);
  }
  if (okSeen) return true;
  if (failedSeen) return false;
  return (
    headers.length > 0 &&
    headers.every((i) => panicPrintUnderGreenBlock(lines, i) || panicPrintInsideGreenRun(lines, i))
  );
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
