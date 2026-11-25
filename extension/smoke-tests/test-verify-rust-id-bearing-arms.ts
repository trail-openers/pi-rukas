#!/usr/bin/env bun
/**
 * #2372 part one — the ID-BEARING ARMS: every question the Rust dialect asks,
 * asked of the header a current cargo actually prints.
 *
 * The defect these arms exist for is not a wrong answer, it is an ABSENT one.
 * cargo prints a per-thread OS id inside every panic header —
 * `thread 'tests::failing_unit' (2348385) panicked at src/lib.rs:34:9:` — and
 * the dialect's matcher could not match it, while the looser "merely opens like
 * a header" look still fired. So the header was unparseable rather than absent:
 * the name read `undefined`, the sameness key read `null`, and every gate that
 * fails closed on those answers silently stopped gating. Real Rust failures
 * reached the operator without the assertion #2341 was built to surface, and
 * every unit test stayed green because every fixture spelled the header without
 * the id.
 *
 * So each arm below asserts BOTH halves of the fix, and each asserts that it saw
 * the class at all — an arm whose count is zero is indistinguishable from a
 * blind sweep:
 *
 *   - RECOGNITION: the id-bearing header classifies, its name reads WITHOUT the
 *     id, and the recognizer sees it through a gate's prefix;
 *   - IDENTITY, both operands: the key carries no id, and the containment side
 *     of `sharesAssertion` strips the id out of the HAYSTACK too — with a canary
 *     that the raw haystack does NOT contain the key, so this test would go red
 *     on a fix that normalised only the key (the trap the ticket names);
 *   - THE QUOTE KEEPS THE ID while the key never reads it;
 *   - THE EXCUSE CLASSES on id-bearing streams, each class with its own non-zero
 *     count;
 *   - PROVENANCE: the streams the recognition arms run on are CAPTURED runs (see
 *     `lib/verify-rust-golden-recipe.md`), and the recipe beside them records the
 *     command, flags and toolchain that produced them.
 *
 * Disclosed, not asserted (it is not reachable): the `name === undefined` guard
 * in `changePanicsAreBaseFailures` — every header the enumeration can produce
 * parses a name, id-bearing or not, so the branch answers a question no input
 * asks. The arm below asserts that unnameable-header count is ZERO, which is the
 * disclosure in the only form a test can state.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
  sharesAssertion,
} from "../src/work-driver-verify-assertion.ts";
import {
  changePanicsAreBaseFailures,
  classifyFailureLine,
  panicCanExcuseChange,
  panicIsCapturedPrint,
  rustPanicHeaderIn,
  rustPanicSamenessKey,
  rustPanicTestName,
} from "../src/work-driver-verify-failures.ts";
import { stripRustPanicThreadIds } from "../src/work-driver-verify-header-leaf.ts";
import {
  RUST_GOLDEN_CAPTURED,
  RUST_GOLDEN_NOCAPTURE,
  rustGoldenStream,
} from "./lib/verify-rust-golden.ts";
import {
  makeAssert,
  rustPanicHeader,
  rustPanicHeaderWithId,
} from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

/** AC1's literal, verbatim from the issue. */
const AC1_HEADER = "thread 'worker-3' (36061) panicked at src/lib.rs:39:17:";
/** The id-less spelling of the same header — the pre-1.73 / synthetic form. */
const AC1_HEADER_NO_ID = "thread 'worker-3' panicked at src/lib.rs:39:17:";

// ── arm 1: recognition (AC1) ─────────────────────────────────────────────────

{
  assert(
    classifyFailureLine(AC1_HEADER)?.shape === "rust-panic",
    "AC1: classifyFailureLine reads an id-bearing header as `rust-panic`",
  );
  assert(
    classifyFailureLine(AC1_HEADER)?.namesTest === true,
    "AC1: ...and that header names a check",
  );
  assert(
    classifyFailureLine(AC1_HEADER_NO_ID)?.shape === "rust-panic",
    "AC1: the id-less spelling keeps classifying (the fix did not trade one form for the other)",
  );
  assert(
    rustPanicTestName(AC1_HEADER) === "worker-3",
    `AC1: the name reads WITHOUT the id (got ${JSON.stringify(rustPanicTestName(AC1_HEADER))})`,
  );
  // The prefix case the #2341 recognizer exists for, in the id-bearing spelling:
  // a gate that printed the header behind its own `warning:` is still a header.
  const prefixed = `warning: ${AC1_HEADER}`;
  assert(
    rustPanicHeaderIn(prefixed) === AC1_HEADER,
    "AC1: the anywhere-in-text recognizer sees an id-bearing header through a gate prefix",
  );
  assert(
    rustPanicTestName(rustPanicHeaderIn(prefixed) ?? "") === "worker-3",
    "AC1: ...and the name it returns still parses",
  );
  // The fail-closed half: header-shaped, identity unparseable → no key, ever.
  assert(
    rustPanicSamenessKey("thread 'worker-3' (3606") === null,
    "AC1: a clipped id-bearing header compares as NOTHING, not by containment",
  );
}

// ── arm 2: identity, BOTH operands (AC2, AC3) ───────────────────────────────

const TEST = "session::fastpath_tests::fast_path_does_not_block";
const AT = "src/session/fastpath_tests.rs:91:5";
const MSG = "fast path took 101.409582ms, which is over the 100 ms bound";

/** The base run's assertion — header id 35798, joined with its message. */
const BASE_ASSERTION = `${rustPanicHeaderWithId(TEST, AT, 35798)} ${MSG}`;
/** The base run's own stream, carrying that header with its own id. */
const BASE_STREAM = [
  "running 2 tests",
  `test ${TEST} ... FAILED`,
  "",
  rustPanicHeaderWithId(TEST, AT, 35798),
  MSG,
  "",
  "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
  "error: test failed, to rerun pass `--lib`",
].join("\n");
/** The change run's stream for the SAME test, file and line — header id 40001. */
const CHANGE_STREAM = [
  "running 2 tests",
  `test ${TEST} ... FAILED`,
  "",
  rustPanicHeaderWithId(TEST, AT, 40001),
  MSG,
  "",
  "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
  "error: test failed, to rerun pass `--lib`",
].join("\n");
/** The change run's assertion, same failure, different id. */
const CHANGE_ASSERTION = `${rustPanicHeaderWithId(TEST, AT, 40001)} ${MSG}`;

{
  const key = rustPanicSamenessKey(BASE_ASSERTION);
  assert(
    key === rustPanicHeader(TEST, AT),
    `AC2: the key is the id-less header token run (got ${JSON.stringify(key)})`,
  );
  assert(
    key !== null && !key.includes("("),
    "AC2: the key carries no id, so nothing downstream can read one",
  );
  assert(
    stripRustPanicThreadIds(CHANGE_STREAM).includes(key ?? "\u0000"),
    "AC2: the haystack side normalises too — the stripped stream contains the key",
  );
  // THE CANARY. Without the haystack normalisation this containment is false,
  // which is the trap the ticket names: key-only normalisation keeps every
  // key-vs-key unit test green while every base-excuse misses in production.
  assert(
    !CHANGE_STREAM.includes(key ?? "\u0000"),
    "AC2 canary: the RAW id-bearing haystack does NOT contain the key (so this arm is not vacuous)",
  );
  assert(
    sharesAssertion(CHANGE_STREAM, BASE_ASSERTION),
    "AC3: base id 35798 and change id 40001 for one test/file/line are the SAME assertion through the containment path",
  );
  assert(
    sharesAssertion(BASE_STREAM, CHANGE_ASSERTION),
    "AC3: and the same judgement holds with the operands swapped",
  );
  assert(
    rustPanicSamenessKey(BASE_ASSERTION) === rustPanicSamenessKey(CHANGE_ASSERTION),
    "AC3: key-to-key agrees with the containment path",
  );
  // Identity still discriminates: the id is what varies, not the test.
  assert(
    !sharesAssertion(CHANGE_STREAM, `${rustPanicHeaderWithId(TEST, "src/other.rs:7:7", 35798)} x`),
    "AC3: a DIFFERENT file is not the same assertion just because the id matches",
  );
  assert(
    !sharesAssertion(
      CHANGE_STREAM,
      `${rustPanicHeaderWithId("session::other_test", AT, 35798)} x`,
    ),
    "AC3: a DIFFERENT test name is not the same assertion",
  );
  // The non-Rust classic rule is untouched: no normalisation of anything else.
  assert(
    sharesAssertion("some gate output\n\u2717 got 1, expected 2", "\u2717 got 1, expected 2"),
    "AC3: the classic containment rule for a non-panic assertion is unchanged",
  );
  assert(
    !sharesAssertion("some gate output\n\u2717 got 3, expected 2", "\u2717 got 1, expected 2"),
    "AC3: ...including its refusals",
  );
  // A parenthesised number that is not a header id survives untouched: the
  // normaliser is anchored on the whole header open, not on `(\d+)` in general.
  assert(
    stripRustPanicThreadIds("AssertionError (2) in one_test (3) failed") ===
      "AssertionError (2) in one_test (3) failed",
    "AC2: the normaliser touches ONLY header ids, never an ordinary parenthesised number",
  );
}

// ── arm 3: the published quote keeps the id (AC4) ────────────────────────────

{
  for (const run of [RUST_GOLDEN_CAPTURED, RUST_GOLDEN_NOCAPTURE]) {
    const stream = rustGoldenStream(run);
    const quote = extractSpecificAssertion(stream, stream);
    assert(
      quote !== NO_SPECIFIC_ASSERTION,
      `AC4 (${run.name}): the captured run yields an assertion, not honest absence`,
    );
    assert(
      /^thread '[^']+' \(\d+\) panicked at /.test(quote),
      `AC4 (${run.name}): the operator-facing quote KEEPS the per-thread id (${JSON.stringify(quote.slice(0, 72))})`,
    );
    const key = rustPanicSamenessKey(quote);
    assert(
      key !== null && !/\(\d+\)/.test(key),
      `AC4 (${run.name}): identity comparison never reads it (key ${JSON.stringify(key)})`,
    );
  }
}

// ── arm 4: the excuse classes on id-bearing streams (AC5) ────────────────────

/** One id-bearing stream per excuse class, with the assertion each is asked of. */
type ExcuseCase = {
  kind: "captured-print" | "base-failed" | "change-failed" | "no-verdict";
  stream: string;
  assertion: string;
  /** What `panicCanExcuseChange` must answer for this stream/assertion pair. */
  excuse: boolean;
  /** What `changePanicsAreBaseFailures` must answer, given this as the change run. */
  changeExcuse: boolean;
};

const excuseCases: ExcuseCase[] = [
  {
    // The `#[should_panic]` print of a test the run reports `ok` — the class the
    // quote veto exists for, and no excuse in either direction.
    kind: "captured-print",
    stream: [
      "running 2 tests",
      rustPanicHeaderWithId("a::t", "src/a.rs:7:5", 40001),
      "explicit panic",
      // libtest decorates a should_panic test's VERDICT line and not its
      // header's thread name — the spelling the captured golden carries.
      "test a::t - should panic ... ok",
      "test a::other ... FAILED",
      rustPanicHeaderWithId("a::other", "src/a.rs:9:9", 40002),
      "assertion failed: the real failure",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured",
    ].join("\n"),
    assertion: rustPanicHeaderWithId("a::t", "src/a.rs:7:5", 40001),
    excuse: false,
    // The captured print is SKIPPED rather than asked (the run reports its own
    // test `ok` and never `FAILED`), so it cannot refuse the excuse the run's
    // OTHER header — reported FAILED by both runs — genuinely earned.
    changeExcuse: true,
  },
  {
    // The base run reported this exact name FAILED: the one thing that excuses.
    kind: "base-failed",
    stream: [
      "running 2 tests",
      "test b::t ... FAILED",
      rustPanicHeaderWithId("b::t", "src/b.rs:3:1", 35798),
      "assertion failed: already broken at base",
      "test b::ok ... ok",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured",
    ].join("\n"),
    assertion: rustPanicHeaderWithId("b::t", "src/b.rs:3:1", 35798),
    excuse: true,
    changeExcuse: true,
  },
  {
    // The change's own run reports it FAILED too — the second question the
    // per-failing-test excuse asks.
    kind: "change-failed",
    stream: [
      "running 1 test",
      "test c::t ... FAILED",
      rustPanicHeaderWithId("c::t", "src/c.rs:1:1", 40003),
      "assertion failed: failing on base and on the change",
      "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
    ].join("\n"),
    assertion: rustPanicHeaderWithId("c::t", "src/c.rs:1:1", 40003),
    excuse: true,
    changeExcuse: true,
  },
  {
    // A name no per-test verdict line mentions: no evidence, so no excuse — the
    // loud direction, and the class the unreachable `name === undefined` guard
    // was supposed to (but cannot) reach.
    kind: "no-verdict",
    stream: [
      "running 1 test",
      rustPanicHeaderWithId("worker-3", "src/lib.rs:20:13", 40004),
      "pool bound exceeded: 101ms over the 100 ms bound",
      "Aborted (core dumped)",
      "error: process didn't exit successfully: signal: 6, SIGABRT",
    ].join("\n"),
    assertion: rustPanicHeaderWithId("worker-3", "src/lib.rs:20:13", 40004),
    excuse: false,
    changeExcuse: false,
  },
];

{
  const counts: Record<ExcuseCase["kind"], number> = {
    "captured-print": 0,
    "base-failed": 0,
    "change-failed": 0,
    "no-verdict": 0,
  };
  const unnameable: string[] = [];
  for (const c of excuseCases) {
    counts[c.kind]++;
    // Every header these streams carry parses a name — the disclosure that the
    // `name === undefined` arm is unreachable, in the only form a test states it.
    for (const line of c.stream.split("\n")) {
      if (!line.startsWith("thread '")) continue;
      if (rustPanicTestName(line) === undefined) unnameable.push(line);
    }
    assert(
      panicCanExcuseChange(c.stream, c.assertion) === c.excuse,
      `AC5 (${c.kind}): panicCanExcuseChange answers ${c.excuse} on the id-bearing stream`,
    );
    // The same question asked of a stream whose id is DIFFERENT, which is what
    // two runs of one failure print: the answer must not move.
    const otherId = c.assertion.replace(/\((\d+)\)/, "($199)");
    assert(
      otherId !== c.assertion && panicCanExcuseChange(c.stream, otherId) === c.excuse,
      `AC5 (${c.kind}): and the answer does not move when the change's id differs`,
    );
    assert(
      changePanicsAreBaseFailures(c.assertion, c.stream, c.stream) === c.changeExcuse,
      `AC5 (${c.kind}): changePanicsAreBaseFailures answers ${c.changeExcuse} on the id-bearing stream`,
    );
    if (c.kind === "captured-print") {
      assert(
        panicIsCapturedPrint(c.stream, rustPanicTestName(c.assertion)) === true,
        `AC5 (${c.kind}): the quote veto reads the same id-bearing verdict line`,
      );
    }
  }
  for (const kind of Object.keys(counts) as ExcuseCase["kind"][]) {
    assert(counts[kind] > 0, `AC5: the ${kind} class carries ${counts[kind]} asserted case(s) (non-zero)`);
  }
  assert(
    unnameable.length === 0,
    `disclosed: no id-bearing header the enumeration reaches is unnameable (got ${unnameable.length}) — the name === undefined guard is unreachable`,
  );

  // The two goldens, asked as a base/change pair of the SAME toolchain run: the
  // lib test fails in both, so its panic excuses, and the doctest `main` header
  // excuses nothing (no verdict names `main`).
  const both = [RUST_GOLDEN_CAPTURED, RUST_GOLDEN_NOCAPTURE] as const;
  assert(
    changePanicsAreBaseFailures(
      rustPanicHeaderWithId("tests::failing_unit", "src/lib.rs:34:9", 41000),
      rustGoldenStream(both[1]),
      rustGoldenStream(both[0]),
    ) === false,
    "AC5: the captured pair — an id-bearing header naming a test the change run never reports FAILED excuses nothing",
  );
  assert(
    panicCanExcuseChange(rustGoldenStream(RUST_GOLDEN_CAPTURED), "\u2717 got 1, expected 2") ===
      true,
    "AC5: a non-panic assertion is still decided by the classic rule (the gate refuses to excuse only what it can read as a panic)",
  );
}

// ── arm 5: provenance of the goldens (AC8) ───────────────────────────────────

{
  const recipePath = path.join(import.meta.dirname, "lib", "verify-rust-golden-recipe.md");
  const recipe = readFileSync(recipePath, "utf8");
  assert(
    recipe.includes("rustpanic_probe") &&
      recipe.includes("thread::Builder::new()") &&
      recipe.includes("#[should_panic"),
    "AC8: the committed recipe carries the probe crate that produced the goldens",
  );
  for (const run of [RUST_GOLDEN_CAPTURED, RUST_GOLDEN_NOCAPTURE]) {
    assert(run.command.startsWith("cargo test"), `AC8 (${run.name}): the command is recorded`);
    assert(run.flags.length > 0, `AC8 (${run.name}): its flags are recorded`);
    assert(
      /^cargo \d+\.\d+/.test(run.cargoVersion) && /^rustc \d+\.\d+/.test(run.rustcVersion),
      `AC8 (${run.name}): the cargo/rustc version is recorded (${run.cargoVersion} / ${run.rustcVersion})`,
    );
    assert(
      recipe.includes("cargo test") &&
        run.flags.every((flag) => recipe.includes(flag)) &&
        run.command.split(" ")[0] === "cargo",
      `AC8 (${run.name}): the recipe names the command and every flag this golden was captured with`,
    );
    assert(
      recipe.includes(run.cargoVersion) && recipe.includes(run.rustcVersion),
      `AC8 (${run.name}): the recipe records the toolchain of the capture`,
    );
    // The capture's own claims, re-verified against the bytes: the ids are there,
    // and the stream attribution the deferrals rest on holds.
    const idBearing = (s: string): number =>
      (s.match(/^thread '[^']+' \(\d+\) panicked at /gm) ?? []).length;
    assert(
      idBearing(run.stdoutBlock) + idBearing(run.stderrBlock) > 0,
      `AC8 (${run.name}): the golden carries id-bearing headers (${idBearing(run.stdoutBlock)}/${idBearing(run.stderrBlock)})`,
    );
    assert(
      run.nocapture === run.flags.includes("--nocapture"),
      `AC8 (${run.name}): the --nocapture state matches the flags recorded for it`,
    );
    assert(
      !run.stdoutBlock.includes("Doc-tests") && run.stderrBlock.includes("Doc-tests"),
      `AC8 (${run.name}): cargo's banner is stderr-only, as the deferrals state`,
    );
  }
  assert(
    RUST_GOLDEN_CAPTURED.nocapture === false && RUST_GOLDEN_NOCAPTURE.nocapture === true,
    "AC8: one golden is a captured-mode run and one passed --nocapture",
  );
}

// ── arm 6: the header's one owner (AC6) and the host cap (AC7) ───────────────

{
  const src = path.resolve(import.meta.dirname, "..", "src");
  const leaf = readFileSync(path.join(src, "work-driver-verify-header-leaf.ts"), "utf8");
  const readers = readFileSync(path.join(src, "work-driver-verify-rust.ts"), "utf8");
  const table = readFileSync(path.join(src, "work-driver-verify-shapes.ts"), "utf8");
  const five = [
    "RUST_PANIC_OPEN_SRC",
    "RUST_PANIC_RE",
    "RUST_PANIC_GLOBAL_RE",
    "RUST_PANIC_HEADER_FORM",
    "PANIC_HEADER_LOOK_RE",
  ];
  for (const name of five) {
    assert(
      new RegExp(`(?:const|export const) ${name}\\s*=`).test(leaf),
      `AC6: ${name} is declared in the leaf module`,
    );
    for (const [file, text] of [
      ["work-driver-verify-rust.ts", readers],
      ["work-driver-verify-shapes.ts", table],
    ] as const) {
      assert(
        !new RegExp(`(?:const|export const) ${name}\\s*=`).test(text),
        `AC6: ${file} does not declare ${name}`,
      );
    }
  }
  // No consumer re-spells the header's opening token run in a literal of its
  // own — the scan covers ALL of src/, not just the two known consumers: the
  // one header-shaped literal the two-file scan let through lived in a third
  // file, and a property that scans only where it already looked is the blind
  // sweep this ticket names.
  for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!file.endsWith(".ts") || file === "work-driver-verify-header-leaf.ts") continue;
    const text = readFileSync(path.join(src, file), "utf8");
    assert(
      !/thread\\s\+'/.test(text) && !/'\)\s*panicked/.test(text),
      `AC6: ${file} spells no panic-header token run of its own`,
    );
  }
  assert(
    /from "\.\/work-driver-verify-header-leaf\.ts"/.test(readers) &&
      /from "\.\/work-driver-verify-header-leaf\.ts"/.test(table),
    "AC6: both consumers import the header from the leaf",
  );
  // The vocabulary surface the four call sites import through is unchanged.
  assert(
    classifyFailureLine(AC1_HEADER)?.shape === "rust-panic" &&
      rustPanicSamenessKey(BASE_ASSERTION) !== null &&
      rustPanicHeaderIn(BASE_ASSERTION) !== undefined &&
      rustPanicTestName(BASE_ASSERTION) === TEST,
    "AC6: work-driver-verify-failures.ts still publishes the header readers to its call sites",
  );
  // AC7: the host stayed inside the cap after the extraction.
  const lines = readers.split("\n").length;
  assert(
    lines <= 500,
    `AC7: work-driver-verify-rust.ts rewires to the leaf and stays within the 500-line cap (${lines} lines)`,
  );
  const leafLines = leaf.split("\n").length;
  assert(leafLines <= 500, `AC7: the leaf itself is within the cap (${leafLines} lines)`);
}

console.log(failed() ? "ID-BEARING ARMS FAILED" : "All id-bearing arms passed.");
process.exit(failed() ? 1 : 0);
