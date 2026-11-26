# verify-rust-golden capture recipe (#2372)

`verify-rust-golden.ts` holds cargo/libtest streams that were **captured**, not
written. This file is the recipe that reproduces it: the probe crate, the
commands, the environment, and the generator that turns a fresh capture into the
module. Re-capture rather than editing the golden — the per-thread ids and the
verdict order come off the run, and a golden whose line order was hand-written
proves nothing about the reader that consumes it.

## Why a probe crate at all

The dialect under test recognises libtest's panic header. A current cargo prints
an OS thread id between the quoted name and `panicked at` — per **thread**, not
per process — so it differs between two runs of the same failure. Whether the
dialect reads `thread 'tests::failing_unit' (2348385) panicked at
src/lib.rs:34:9:` is exactly the question #2372 was filed for, and it cannot be
answered by a fixture that spells the header from memory. The probe therefore
produces, in one run, every thread name the dialect has to answer for:

| thread name | where it comes from |
| --- | --- |
| `tests::failing_unit` | an `assert_eq!` that fails — the ordinary failing test |
| `main` | the failing DOCTEST (rustdoc runs the doctest body on the main thread) |
| `tests::should_panic_capture` | a passing `#[should_panic]` test — its captured print, observable only under `--nocapture` |
| `worker-3` | a pool thread spawned by `thread::Builder::new().name("worker-3")`, observable only under `--nocapture` |
| `tests::passing_sibling` | a passing test, so the tally is not all-failed |

## The probe crate

Two files, in a directory outside any checkout (`/tmp/pi-2372-probe` below).

`Cargo.toml`:

```toml
[package]
name = "rustpanic_probe"
version = "0.1.0"
edition = "2021"

[lib]
path = "src/lib.rs"

[profile.dev]
debug = false
```

`src/lib.rs`:

```rust
/// The fast path's measured bound.
///
/// ```
/// assert_eq!(rustpanic_probe::fast_path_ms(), 100);
/// ```
pub fn fast_path_ms() -> u128 {
    101
}

/// The value the unit assertion compares against.
pub fn over_bound() -> u128 {
    101
}

/// A pool worker that panics on a thread named after the pool, not a test.
pub fn spawn_panicking_worker() -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("worker-3".to_string())
        .spawn(|| {
            panic!("pool bound exceeded: 101ms over the 100 ms bound");
        })
        .unwrap()
}

#[cfg(test)]
mod tests {
    #[test]
    fn passing_sibling() {
        assert_eq!(super::fast_path_ms(), 101);
    }

    #[test]
    fn failing_unit() {
        assert_eq!(
            super::over_bound(),
            100,
            "fast path took 101.409582ms, which is over the 100 ms bound"
        );
    }

    #[test]
    #[should_panic(expected = "explicit panic")]
    fn should_panic_capture() {
        panic!("explicit panic inside the should_panic test");
    }

    #[test]
    fn worker_panics() {
        let handle = super::spawn_panicking_worker();
        let joined = handle.join();
        assert!(joined.is_err(), "worker-3 died as the change broke the pool");
    }
}
```

No dependencies, so the capture needs no network and no lockfile.

## The capture

stdout and stderr go to **separate files** — that is the whole point of the
capture, because the driver hands its readers the whole stdout block followed by
the whole stderr block, and where each line of a cargo run lands is measured
fact, not an assumption. Redirecting both to files also makes the run non-TTY,
which is how the driver runs a gate.

```bash
probe=/tmp/pi-2372-probe
out=/tmp/pi-2372-capture
mkdir -p "$out"
export CARGO_TERM_COLOR=never
export CARGO_TARGET_DIR="$out/target"

# GOLDEN_CAPTURED — captured mode: libtest's own per-test blocks on stdout.
cargo test --manifest-path "$probe/Cargo.toml" --no-fail-fast \
  >"$out/a.out" 2>"$out/a.err"          # exit 101

# GOLDEN_NOCAPTURE — --nocapture: the passing test's captured print and the
# pool worker's panic become observable, and they arrive on STDERR.
cargo test --manifest-path "$probe/Cargo.toml" --no-fail-fast -- --nocapture \
  >"$out/b.out" 2>"$out/b.err"          # exit 101

{ cargo --version; rustc --version; } >"$out/versions.txt"
```

`--no-fail-fast` is required: without it `cargo test` stops after the first
failing target and the run never reaches the doctest target, so the `main`
header (the doctest class) would not be in the capture.

Record in the golden's header, per run: the command, its flags, whether the
capture used `--nocapture`, and the `cargo`/`rustc` versions from
`versions.txt`. The committed golden was captured with:

```
cargo 1.99.1 (5f94df478 2026-08-27)
rustc 1.99.1 (58cf8f9c3 2026-10-13)
```

## Turning a capture into the module

Do not retype the streams. Read the four files and emit the records — a run's
bytes reach the module through `JSON.stringify`, so no transcription sits between
the pipe and the fixture:

```js
import { readFileSync, writeFileSync } from "node:fs";

const cap = "/tmp/pi-2372-capture";
const read = (f) => readFileSync(`${cap}/${f}`, "utf8");
const [cargoVersion, rustcVersion] = read("versions.txt").split("\n");
const ts = (s) => JSON.stringify(s);

const run = (name, command, flags, nocapture, o, e, exitCode, capturedAt) => [
  `/** ${name} — \`${command}\`, CARGO_TERM_COLOR=never, non-TTY. */`,
  `export const ${name}: RustGoldenRun = {`,
  `  name: ${ts(name)},`,
  `  command: ${ts(command)},`,
  `  flags: [${flags.map(ts).join(", ")}] as const,`,
  `  nocapture: ${nocapture},`,
  `  cargoVersion: ${ts(cargoVersion)},`,
  `  rustcVersion: ${ts(rustcVersion)},`,
  `  exitCode: ${exitCode},`,
  `  capturedAt: ${ts(capturedAt)},`,
  `  stdoutBlock: ${ts(read(o))},`,
  `  stderrBlock: ${ts(read(e))},`,
  "};",
  "",
].join("\n");
```

Keep the module's prose header and the `RustGoldenRun` / `RUST_GOLDEN_ENV` /
`rustGoldenStream` definitions as they are — the only thing a re-capture replaces
is the two records and the `capturedAt` / version fields inside them.

## What the capture shows, and what it therefore settles

- **Every header carries the id**, including `thread 'main' (…)`: the id-less
  spelling `thread 'main' panicked at …` never occurs on this toolchain. A
  dialect that cannot match it is inert, which is the #2372 defect.
- **Captured mode puts headers on stdout** (inside each `---- <name> stdout ----`
  block); **`--nocapture` puts them on stderr**, unattributed. The passing
  `#[should_panic]` test's print and the pool worker's panic are observable only
  in the second — libtest discards a passing test's captured output otherwise.
- **Cargo's banners are stderr-only** (`     Running unittests …`, five spaces;
  `   Doc-tests <crate>`, three spaces) while verdict lines, headers, tallies and
  `failures:` blocks are stdout-only. Joined stdout-then-stderr, **no banner ever
  precedes the verdict lines it would have to bind** — which is why target-scoped
  verdict lookup (and the capture refusals that would need it) is out of reach on
  the production stream and stays deferred.
- **Verdict order within a target is not stable** between runs (the two captures
  here differ), and the ids are never equal across runs. Both are why the golden
  is a recorded run rather than an authored one, and why identity comparisons
  normalise the id out of both of their operands.
