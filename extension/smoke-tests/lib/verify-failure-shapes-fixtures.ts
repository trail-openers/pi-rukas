/**
 * #1762 — the shared fixtures for the failure-shape smoke suite.
 *
 * Split out of `test-verify-failure-shapes-1762.ts` (AGENTS.md §12 file-size
 * limit): the suite is one table of runner dialects and the same synthetic
 * output is asserted from several angles, so both files name the command, the
 * cwd and the project-runner summary block. A fixture duplicated in two files is two
 * fixtures that can quietly disagree, so neither file re-types them.
 *
 * Not a test: no assertions here, so the offline loop never runs it alone.
 */

/** The command the harness builder composes with (same shape as the
 * `test-work-driver-corrective-decide.ts` fixtures). */
export const CMD = "sh check.sh";

/** The worktree path the harness builder composes with. */
export const WT = "/repo/.worktrees/issue-1-a";

/** The project runner's summary block — the failing stage's own tally. */
export const CHECKS_BLOCK = "scripts/test.sh: failed checks (1)";

/** The line that block prints directly beneath its tally. */
export const CHECK_DETAIL = "scripts/test.sh   pack_release_test.sh";

/**
 * #1762 — a `FAILED:` marker that CARRIES the assertion in its detail, which is
 * the shape the blanket `/^FAILED:/` veto used to refuse along with the bare
 * filename. The `:` inside the detail is deliberate: it is what forces the
 * reader to anchor the path/detail split on the FIRST `: ` after the path rather
 * than on any colon.
 */
export const PAYLOAD_MARKER =
  "FAILED: test/a_test.sh: a first run writes the settings: expected '0', got '1'";

/**
 * The two names a script's tally block prints indented beneath its count. A
 * READONLY TUPLE, not `string[]`: the suites index it directly (`TALLY_NAMES[1]`),
 * and on an array type that indexes to `string | undefined` under `noUncheckedIndexedAccess`,
 * so every call site carried a `?? ""` fallback. `!(x ?? "").includes("")` is
 * false whatever `x` is — the anti-harvest assertions were vacuous. A tuple makes
 * the index `string` and the fallback disappears.
 */
export const TALLY_NAMES = ["lint", "test/b_test.sh"] as const;

/** The tally line those names sit under (count 2, matching TALLY_NAMES.length). */
export const TALLY_LINE = "test.sh: failed checks (2), not run (0)";

/**
 * #1841 — a runner's FAIL HEADER: the status token, then a description naming the
 * check, with no file name and no extension, above indented detail lines that say
 * what to change. The shape the failure-line table did not recognise, so a develop
 * round whose only failure signal was this stream named no failing line and parked
 * without its corrective round.
 */
export const FAIL_HEADER = "FAIL  the shell line budget (scripts/budget.max)";

/** The lines the header prints indented beneath it — the actionable part. */
export const FAIL_HEADER_DETAILS = [
  "      check-lines: 24639 lines, over the ceiling of 24576.",
  "      Take out 63 lines.",
] as const;

/** The passing lines the same stream prints after the block. */
export const FAIL_HEADER_PASSING = [
  "ok    shellcheck and the shell tests of the change",
  "skip  the workspace's tests",
] as const;

/** The whole #1841 stream: header, its indented details, then ok/skip lines. */
export const FAIL_HEADER_STREAM = [
  FAIL_HEADER,
  ...FAIL_HEADER_DETAILS,
  ...FAIL_HEADER_PASSING,
].join("\n");

/**
 * The whole example stream: the tally, its two indented names, then the payload
 * marker. Synthetic output of a project gate, not this repo's own loop dialect.
 */
export const EXAMPLE_STREAM = [
  TALLY_LINE,
  `    ${TALLY_NAMES[0]}`,
  `    ${TALLY_NAMES[1]}`,
  PAYLOAD_MARKER,
].join("\n");

/** Passing tallies from the same stream — none may surface as evidence. */
export const PASSING = [
  "pack_release_test.sh: 36 cases, 0 failed",
  "sandbox_test.sh: 36 cases, 0 failed",
  "console_test.sh: 36 cases, 0 failed",
];

/** The timing block such a stream prints after its tallies. */
export const TIMING = [
  "slowest checks:",
  "  pack_release_test.sh   21.4s",
  "  sandbox_test.sh        18.9s",
  "total 1314s",
];

/**
 * #2341 — the Rust/cargo dialect, as the nessie 1415 log printed it. libtest
 * emits the failing verdict as TWO lines: `thread '<test>' panicked at
 * FILE:LINE:` with the message on the NEXT line, and cargo closes every
 * failing target with the byte-identical
 * `error: test failed, to rerun pass \`--bin X\`` summary. The extractor must
 * return the PAIR (it names test, file, line, measured value and bound) and
 * never the summary (it names only the target — every failing test in the
 * target prints it identically, which is how two different failures once
 * compared as the same assertion).
 */
export const NESSIE_TEST =
  "session::fastpath_tests::fast_path_does_not_block_behind_a_session_held_by_a_running_turn";
export const RUST_PANIC_AT = "src/session/fastpath_tests.rs:91:5";
export const RUST_PANIC_MESSAGE = "fast path took 101.409582ms, which is over the 100 ms bound";

/** The panic header libtest prints for one failing test. */
export function rustPanicHeader(test: string, at: string): string {
  return `thread '${test}' panicked at ${at}:`;
}

/** cargo's trailing target-level summary (names the TARGET, never a check). */
export const CARGO_TARGET_SUMMARY = "error: test failed, to rerun pass `--bin nessie`";

/**
 * #2341 round 1 — cargo's WHOLE target-level dialect, not just the one
 * sentence. Every one of these is printed about the TARGET or the test
 * PROCESS and is byte-identical across the different tests that failed inside
 * it, so each must classify `cargo-summary` with `namesTest: false`: it may
 * anchor evidence, it may never be "the assertion", and it may never buy a
 * "SAME assertion" claim. The SIGABRT line is the one a real adversarial round
 * reproduced the fold with, sitting BELOW the last panic and dragging the
 * evidence anchor past the decisive pair.
 */
export const CARGO_SIGABRT_SUMMARY =
  "error: process didn't exit successfully: `/home/ci/target/debug/deps/nessie-1a2b3c` (signal: 6, SIGABRT: process abort signal)";
export const CARGO_TARGET_SUMMARIES: readonly string[] = [
  CARGO_TARGET_SUMMARY,
  CARGO_SIGABRT_SUMMARY,
  "error: 1 target failed:",
  "error: could not compile `nessie` (bin \"nessie\") due to 1 previous error",
  "error: aborting due to 1 previous error",
];

/** The whole cargo/libtest stream for one panicking test, real dialect. */
export function rustCargoStream(opts: {
  test: string;
  at: string;
  message: string;
  /** cargo's trailing line; defaults to the test-failed summary. */
  trailer?: string;
}): string {
  return [
    "running 41 tests",
    `test ${opts.test} ... FAILED`,
    "",
    "failures:",
    "",
    `---- ${opts.test} stdout ----`,
    "",
    rustPanicHeader(opts.test, opts.at),
    opts.message,
    "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace",
    "",
    "failures:",
    `    ${opts.test}`,
    "",
    "test result: FAILED. 40 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s",
    "",
    opts.trailer ?? CARGO_TARGET_SUMMARY,
  ].join("\n");
}

/** The real nessie 1415 stream — the fixture AC1 is written against. */
export const RUST_CARGO_STREAM = rustCargoStream({
  test: NESSIE_TEST,
  at: RUST_PANIC_AT,
  message: RUST_PANIC_MESSAGE,
});

/** The joined pair the extractor must return for that stream. */
export const RUST_PANIC_ASSERTION = `${rustPanicHeader(NESSIE_TEST, RUST_PANIC_AT)} ${RUST_PANIC_MESSAGE}`;

/**
 * #2341 round 1 — the `#[should_panic]` trap. A Rust unit stage that PASSES
 * prints the byte-identical panic header as the CAPTURED STDOUT of a test that
 * passed, and the run still exits non-zero because a LATER stage failed on a
 * dialect the table does not know (`make: *** …`). The stream therefore shows
 * libtest reporting no failing test at all, and the extractor must report
 * ABSENCE — naming `a::t` as the defect would send an operator (and the
 * cycle's one corrective round) after a test that passed.
 */
export const RUST_SHOULD_PANIC_GREEN_STREAM = [
  "running 3 tests",
  "thread 'a::t' panicked at src/a.rs:7:5:",
  "explicit panic",
  "test a::t ... ok",
  "test a::one ... ok",
  "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  "",
  "make: *** [Makefile:12: e2e] Error 1",
].join("\n");

/**
 * #2341 fix wave (H1) — the window-scoped `should_panic` veto defect. One cargo
 * window carries BOTH a genuinely failing test and the CAPTURED panic print of
 * a passing `#[should_panic]` test (`test a::t ... ok`). The window does report
 * a failing libtest verdict — it belongs to a DIFFERENT test — so a veto that
 * asks the WINDOW instead of the header's test name clears the capture, and a
 * test that passed becomes "the assertion" (whose header, as the sameness key,
 * then excuses the change-added failure). The capture-first stream exercises
 * the extractor's first-candidate rule; the capture-last one exercises the
 * anchor walk's last-named rule.
 */
export const RUST_TRAP_AT = "src/b.rs:3:1";
export const RUST_TRAP_MESSAGE = "assertion failed: elapsed < 100ms";
export const RUST_TRAP_PAIR = `${rustPanicHeader("b::slow_path", RUST_TRAP_AT)} ${RUST_TRAP_MESSAGE}`;

function rustShouldPanicTrapStream(captureFirst: boolean): string {
  const capture = [
    "thread 'a::t' panicked at src/a.rs:7:5:",
    "explicit panic",
    "test a::t ... ok",
  ];
  const failing = [
    "test b::slow_path ... FAILED",
    rustPanicHeader("b::slow_path", RUST_TRAP_AT),
    RUST_TRAP_MESSAGE,
  ];
  return [
    "running 3 tests",
    ...(captureFirst ? [...capture, ...failing] : [...failing, ...capture]),
    "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s",
    CARGO_TARGET_SUMMARY,
  ].join("\n");
}

export const RUST_SHOULD_PANIC_TRAP_STREAM = rustShouldPanicTrapStream(true);
export const RUST_SHOULD_PANIC_TRAP_AFTER_STREAM = rustShouldPanicTrapStream(false);

/**
 * #2341 fix wave 4 (H1/H2) — the captured `#[should_panic]` panic whose OWN
 * `test a::t ... ok` verdict line is invisible to the ≤1500-char window the
 * anchor walk is about to produce. Padding on both sides puts the elision cut
 * between the header and its verdict line, so the window built from the
 * capture's own offset holds the header but not the line that proves the test
 * passed: a veto asked only on THAT window answers "no verdict observed" and
 * lets the capture own the anchor and become the assertion — the two readers
 * disagreeing because they ask on two different line sets. The unannotated
 * noise lines are what keeps the stream free of any other anchor candidate,
 * so the capture is the ONLY recognised line and any attribution it earns is
 * the walk volunteering it, not the last-resort slice.
 */
const VERDICT_OUTSIDE_WINDOW_NOISE = Array.from(
  { length: 60 },
  (_, n) => `crate dep_${n} downloaded and compiled`,
).join("\n");
export const RUST_VERDICT_OUTSIDE_WINDOW_STREAM = [
  VERDICT_OUTSIDE_WINDOW_NOISE,
  rustPanicHeader("a::t", "src/a.rs:7:5"),
  "explicit panic",
  "test a::t ... ok",
  VERDICT_OUTSIDE_WINDOW_NOISE,
].join("\n");

/**
 * #2341 fix wave (H2) — two location-less rustc `error[E…]` failures from
 * DIFFERENT files. cargo prints the location on the SEPARATE following
 * `--> file:line:col` line, so the two `error[…]` lines are byte-identical
 * across the two compile failures: quoted as an assertion they fold together
 * on substring containment — the same folding defect as the cargo target
 * summaries, in the rustc-code dialect. A location-less `error[E…]` line
 * therefore names no check.
 */
export const RUSTC_DIAG_NO_LOCATION = "error[E0308]: mismatched types";
export const RUSTC_DIAG_STREAM = [
  RUSTC_DIAG_NO_LOCATION,
  " --> src/alpha.rs:3:1",
  "  expected `u8`, found `i32`",
  RUSTC_DIAG_NO_LOCATION,
  " --> src/beta.rs:9:9",
  "  expected `String`, found `&str`",
].join("\n");

/**
 * #2341 fix wave 4 (H4) — two location-less `error TS2345:` tsc failures from
 * DIFFERENT files. The location rule's identity test was keyed on the rustc
 * bracket form alone (`RUSTC_ERROR_CODE_RE`), so the tsc dialect slipped
 * through the rule that exists to refuse exactly this: the two lines are
 * byte-identical (tsc prints the file on the line above, or the gate flattens
 * it away), quoted as "the assertion" they fold, and `baselineExplainsChange`
 * excuses the regression the fold hides.
 */
export const TSC_DIAG_NO_LOCATION =
  "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
export const TSC_DIAG_STREAM = [
  TSC_DIAG_NO_LOCATION,
  "  --> src/alpha.ts:3:1",
  "  expected `u8`, found `i32`",
  TSC_DIAG_NO_LOCATION,
  "  --> src/beta.ts:9:9",
  "  expected `String`, found `&str`",
].join("\n");

/**
 * #2341 round 2 — the smoke-loop and chain-stage tail shapes the extractor
 * suite asserts case by case, hosted here (AGENTS.md §12 file-size limit)
 * because the same tail is asserted from more than one case: the tsc and the
 * biome chain-stage tails are each quoted twice (the #807 case and its #827
 * re-pin), and a tail duplicated across cases is two tails that can quietly
 * disagree.
 */

/** The chain-stage tsc tail: no FAILED marker, the compiler error names the
 * line. #2341 fix wave 4 (H4): the REAL tsc dialect carries the location on
 * the error line itself (`file.ts:LINE:COL - error TSNNNN: …`) — that is what
 * buys the naming right; a location-less `error TSNNNN:` line is the
 * cross-file fold the `diagnostic-unlocated` arm refuses (see
 * TSC_DIAG_NO_LOCATION). */
export const TSC_CHAIN_STAGE_TAIL = `src/work-driver-foo.ts:42:10 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
  Type 'string' is not comparable to type 'number'.`;

/** The chain-stage biome tail: no FAILED marker, the ✗ line names the rule. */
export const BIOME_CHAIN_STAGE_TAIL = `Checked 239 files in 66ms.
✗ use single quotes (style/useTemplate)
    --> src/biome-test.ts:10:5`;

/** The #804 multi-failure smoke tail: two markers, two ✗ lines, the count summary last. */
export const SMOKE_MULTI_FAILURE_TAIL = `✓ 3 other checks
FAILED: smoke-tests/test-alpha.ts
✗ alpha assertion: expected 0 got 2
FAILED: smoke-tests/test-beta.ts
✗ beta assertion: expected 1 got 9
FAILED: 2 test(s) — smoke-tests/test-alpha.ts, smoke-tests/test-beta.ts`;

/** The exact #746 combined stream: echo, banner, echo, tsc error, marker, ✗. */
export const EXACT_746_TAIL = `$ cd extension && bun run check
Checked 276 files in 61ms. No fixes applied.
$ cd extension && bunx tsc --noEmit
error TS2552: Cannot find name 'foo'. Did you mean 'bar'?
FAILED: smoke-tests/test-repo-root-residue-poisoning.ts
✗ check on scaffolded file: exit 0 (got 1)`;

/**
 * The #827/#772 single-failure tail. The failing test's per-test output is
 * emitted first, then (post-#827) the bounded `✗` lines are repeated after the
 * final summary. The pre-fix defect: the `✗` lines sat thousands of chars
 * BEFORE the summary, so the 800-char window was summary-only; post-fix they
 * are repeated after it, inside the window.
 */
export const FILE_SIZE_LOOP_TAIL_827 = `FAILED: extension/smoke-tests/test-file-size-limit.ts
✗ extension/smoke-tests/test-loop-detector.ts: 667 lines (exceeds 500-line hard limit)
✗ extension/smoke-tests/test-dispatch-caps.ts: 528 lines (exceeds 500-line hard limit)
FAILED: 1 test(s) — extension/smoke-tests/test-file-size-limit.ts
✗ extension/smoke-tests/test-loop-detector.ts: 667 lines (exceeds 500-line hard limit)`;

/** The #827 two-test tail: each failing test's bounded ✗ repeats under the summary. */
export const ALPHA_BETA_TAIL_827 = `FAILED: extension/smoke-tests/test-alpha.ts
✗ alpha assertion: expected 0 got 2
FAILED: extension/smoke-tests/test-beta.ts
✗ beta assertion: expected 1 got 9
FAILED: 2 test(s) — extension/smoke-tests/test-alpha.ts, extension/smoke-tests/test-beta.ts
✗ alpha assertion: expected 0 got 2
✗ beta assertion: expected 1 got 9`;

/** The #827 tail whose repeated ✗ line carries credential material. */
export const SECRET_ASSERTION_TAIL_827 = `FAILED: extension/smoke-tests/test-auth.ts
✗ response body: api_key = a9f2k3j8f2j9f2j9f2j9f2
FAILED: 1 test(s) — extension/smoke-tests/test-auth.ts
✗ response body: api_key = a9f2k3j8f2j9f2j9f2j9f2
✗ auth check failed: expected 200 got 401`;

/** A green libtest run closed by cargo's target summary — it names no assertion. */
export const LIBTEST_GREEN_TALLY_STREAM = [
  "running 3 tests",
  "test a::tests::one ... ok",
  "test a::tests::two ... ok",
  "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
  CARGO_TARGET_SUMMARY,
].join("\n");

/** The assertion helper both suites print through. */
export function makeAssert(): {
  assert: (cond: boolean, msg: string) => void;
  failed: () => boolean;
} {
  let failed = false;
  const assert = (cond: boolean, msg: string): void => {
    if (cond) console.log(`✓ ${msg}`);
    else {
      console.error(`✗ ${msg}`);
      failed = true;
    }
  };
  return { assert, failed: () => failed };
}
