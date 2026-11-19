/**
 * verify-rust-golden — the Rust/cargo streams of #2372, captured from a real
 * toolchain run rather than written.
 *
 * WHY CAPTURED, NOT WRITTEN: the whole point of these fixtures is the shape a
 * hand-typed fixture cannot be trusted to carry — the per-thread id on every
 * panic header (`thread 'tests::failing_unit' (2348385) panicked at
 * src/lib.rs:34:9:`), which thread names really occur (`main` for a doctest,
 * `worker-3` for a pool thread), and ABOVE ALL the line ORDER, which cargo and
 * libtest do not sort and which no author guesses the same way twice. A golden
 * whose order was hand-written proves nothing about the reader that consumes it.
 * So every byte of `stdoutBlock` / `stderrBlock` below came off a pipe into a
 * file, and the only derived value is the join, which is exactly what the exec
 * layer hands the readers (see `rustGoldenStream`).
 *
 * The probe crate, its four tests, the exact commands, the environment, and the
 * generator that turns a fresh capture into this file all live in
 * `verify-rust-golden-recipe.md` beside it. The ids below are the ids THOSE runs
 * printed: they are per-THREAD, so a re-capture yields different numbers and may
 * reorder the verdict lines. A re-capture is therefore a NEW golden, never a diff
 * to patch by hand, and `capturedAt` records which capture these bytes are.
 *
 * Not a test: no assertions here, so the offline loop never runs it alone.
 */

/** One captured cargo run: the bytes it printed, and what was asked of it. */
export type RustGoldenRun = {
  readonly name: string;
  /** The cargo invocation, as typed (`<probe>` stands for the crate's dir). */
  readonly command: string;
  /** Its flags, so a reader can tell `--no-fail-fast` from `--nocapture`. */
  readonly flags: readonly string[];
  /** Whether the capture passed `--nocapture` to the test binary. */
  readonly nocapture: boolean;
  readonly cargoVersion: string;
  readonly rustcVersion: string;
  readonly exitCode: number;
  readonly capturedAt: string;
  /** The run's stdout, byte-for-byte (libtest verdicts, headers, tallies). */
  readonly stdoutBlock: string;
  /** The run's stderr, byte-for-byte (cargo's banners and target summaries). */
  readonly stderrBlock: string;
};

/** The environment every capture ran under (non-TTY: both streams to files). */
export const RUST_GOLDEN_ENV: readonly string[] = [
  "CARGO_TERM_COLOR=never",
  "stdout and stderr redirected to separate files (non-TTY)",
  "CARGO_TARGET_DIR=<capture>/target",
] as const;

/**
 * The stream a production reader is handed: the WHOLE stdout block, then the
 * WHOLE stderr block, joined the way the exec layer joins a failed gate's output
 * — `stdout + "\n" + stderr`, the same join
 * `work-driver-verify-develop-helpers.ts` asks before it extracts a tail.
 *
 * Keeping the two blocks separate above and the join here is the point: cargo
 * prints its per-target banners (`     Running unittests …`, `   Doc-tests …`) to
 * STDERR while libtest prints headers, verdict lines and tallies to STDOUT, so on
 * this stream no banner ever precedes the verdict lines it would have to bind.
 * That is the measured fact target-scoped verdict lookup would need, and it is why
 * that lookup — and the capture refusals built on it — stays deferred.
 */
export function rustGoldenStream(run: RustGoldenRun): string {
  return `${run.stdoutBlock}\n${run.stderrBlock}`;
}

/** RUST_GOLDEN_CAPTURED — `cargo test --manifest-path <probe>/Cargo.toml --no-fail-fast`, CARGO_TERM_COLOR=never, non-TTY. */
export const RUST_GOLDEN_CAPTURED: RustGoldenRun = {
  name: "RUST_GOLDEN_CAPTURED",
  command: "cargo test --manifest-path <probe>/Cargo.toml --no-fail-fast",
  flags: ["--no-fail-fast"] as const,
  nocapture: false,
  cargoVersion: "cargo 1.99.1 (5f94df478 2026-08-27)",
  rustcVersion: "rustc 1.99.1 (58cf8f9c3 2026-10-13)",
  exitCode: 101,
  capturedAt: "2026-11-19",
  stdoutBlock: "\nrunning 4 tests\ntest tests::passing_sibling ... ok\ntest tests::failing_unit ... FAILED\ntest tests::should_panic_capture - should panic ... ok\ntest tests::worker_panics ... ok\n\nfailures:\n\n---- tests::failing_unit stdout ----\n\nthread 'tests::failing_unit' (2348385) panicked at src/lib.rs:34:9:\nassertion `left == right` failed: fast path took 101.409582ms, which is over the 100 ms bound\n  left: 101\n right: 100\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\nfailures:\n    tests::failing_unit\n\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n\nrunning 1 test\ntest src/lib.rs - fast_path_ms (line 3) ... FAILED\n\nfailures:\n\n---- src/lib.rs - fast_path_ms (line 3) stdout ----\nTest executable failed (exit status: 101).\n\nstderr:\n\nthread 'main' (2348421) panicked at src/lib.rs:5:1:\nassertion `left == right` failed\n  left: 101\n right: 100\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\n\nfailures:\n    src/lib.rs - fast_path_ms (line 3)\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s\n\n",
  stderrBlock: "   Compiling rustpanic_probe v0.1.0 (/tmp/pi-2372-probe)\n    Finished `test` profile [unoptimized] target(s) in 0.15s\n     Running unittests src/lib.rs (/tmp/pi-2372-capture/target/debug/deps/rustpanic_probe-95ff97e870514c4f)\nerror: test failed, to rerun pass `--lib`\n   Doc-tests rustpanic_probe\nerror: doctest failed, to rerun pass `--doc`\nerror: 2 targets failed:\n    `--lib`\n    `--doc`\n",
};

/** RUST_GOLDEN_NOCAPTURE — `cargo test --manifest-path <probe>/Cargo.toml --no-fail-fast -- --nocapture`, CARGO_TERM_COLOR=never, non-TTY. */
export const RUST_GOLDEN_NOCAPTURE: RustGoldenRun = {
  name: "RUST_GOLDEN_NOCAPTURE",
  command: "cargo test --manifest-path <probe>/Cargo.toml --no-fail-fast -- --nocapture",
  flags: ["--no-fail-fast", "--", "--nocapture"] as const,
  nocapture: true,
  cargoVersion: "cargo 1.99.1 (5f94df478 2026-08-27)",
  rustcVersion: "rustc 1.99.1 (58cf8f9c3 2026-10-13)",
  exitCode: 101,
  capturedAt: "2026-11-19",
  stdoutBlock: "\nrunning 4 tests\ntest tests::failing_unit ... FAILED\ntest tests::passing_sibling ... ok\ntest tests::should_panic_capture - should panic ... ok\ntest tests::worker_panics ... ok\n\nfailures:\n\nfailures:\n    tests::failing_unit\n\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n\nrunning 1 test\ntest src/lib.rs - fast_path_ms (line 3) ... FAILED\n\nfailures:\n\nfailures:\n    src/lib.rs - fast_path_ms (line 3)\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s\n\n",
  stderrBlock: "    Finished `test` profile [unoptimized] target(s) in 0.00s\n     Running unittests src/lib.rs (/tmp/pi-2372-capture/target/debug/deps/rustpanic_probe-95ff97e870514c4f)\n\nthread 'tests::failing_unit' (2348436) panicked at src/lib.rs:34:9:\nassertion `left == right` failed: fast path took 101.409582ms, which is over the 100 ms bound\n  left: 101\n right: 100\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\nthread 'tests::should_panic_capture' (2348438) panicked at src/lib.rs:44:9:\nexplicit panic inside the should_panic test\n\nthread 'worker-3' (2348440) panicked at src/lib.rs:20:13:\npool bound exceeded: 101ms over the 100 ms bound\nerror: test failed, to rerun pass `--lib`\n   Doc-tests rustpanic_probe\nTest executable failed (exit status: 101).\n\nstderr:\n\nthread 'main' (2348472) panicked at src/lib.rs:5:1:\nassertion `left == right` failed\n  left: 101\n right: 100\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\nerror: doctest failed, to rerun pass `--doc`\nerror: 2 targets failed:\n    `--lib`\n    `--doc`\n",
};
