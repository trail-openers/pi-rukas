/**
 * The generated corpus behind `test-verify-rust-veto-sweep.ts` — the cargo/libtest
 * streams, the three vetoes the sweep asks, and the model extractor that lets a
 * control arm swap the veto without a second extractor.
 *
 * Split out along the natural seam (AGENTS.md §12 file-size cap): the sweep file
 * owns what may FAIL (its counts, controls and assertions), this one owns what is
 * ASKED. The generator knows what it built, so each case carries its own ground
 * truth — a case that is a capture says so, and the sweep's whole falsifiability
 * rests on that being the generator's claim rather than the reader's guess.
 *
 * Not a test: no assertions here, so the offline loop never runs it alone.
 */

import {
  classifyFailureLine,
  panicIsCapturedPrint,
  rustPanicTestName,
} from "../../src/work-driver-verify-failures.ts";
import { rustPanicHeader, rustPanicHeaderWithId } from "./verify-failure-shapes-fixtures.ts";

/** A veto under test: the same shape as the shipped `panicIsCapturedPrint`. */
export type Veto = (stream: string, name: string | undefined) => boolean;

/** One generated stream, the panic header it carries, and the truth about it. */
export type Case = { stream: string; header: string; kind: "capture" | "real" };

const pad = (n: number, tag: string): string[] =>
  n === 0
    ? []
    : Array.from({ length: n }, (_, k) => `   Compiling ${tag}_${k} v0.1.0 (registry)`);
const noise = (n: number, tag: string): string[] =>
  n === 0
    ? []
    : Array.from({ length: n }, (_, k) => `crate dep_${tag}_${k} downloaded and compiled`);
const header = (name: string, at: string): string => rustPanicHeader(name, at);

const PADS = [0, 2, 7, 25];
const MARKERS = [true, false];

/**
 * The verdict line libtest prints for a PASSING `#[should_panic]` test.
 * libtest DECORATES that verdict line with ` - should panic` and does NOT
 * decorate the panic header's thread name — the captured golden
 * `verify-rust-golden.ts` carries both halves of the asymmetry side by side
 * (`thread 'tests::should_panic_capture' (2348438) panicked at …` above
 * `test tests::should_panic_capture - should panic ... ok`). So a capture case
 * spelled `test a::t ... ok` is a line libtest never prints for the test whose
 * print it claims to capture: the header's name would then have no verdict line
 * at all, the quote veto would answer "not observed passing", and the sweep
 * would certify a class it never asked. Every capture below carries the
 * decoration the toolchain prints.
 */
const shouldPanicOk = (name: string): string => `test ${name} - should panic ... ok`;

/**
 * The model extractor: the FIRST panic header the veto under test does not
 * refuse, returned as the header (the sameness key). Only valid for the
 * generated corpus, whose recognised lines are panic headers and verdict /
 * tally / marker lines — the sweep's fidelity arm asserts production agrees with
 * this on every permutation, so the model cannot silently drift from the
 * extractor.
 */
export function modelExtract(stream: string, veto: Veto): string | null {
  for (const raw of stream.split("\n")) {
    const line = raw.trim();
    if (classifyFailureLine(line)?.shape !== "rust-panic") continue;
    if (veto(stream, rustPanicTestName(line))) continue;
    return line;
  }
  return null;
}

export const shippedVeto: Veto = (stream, name) => panicIsCapturedPrint(stream, name);
export const neuteredVeto: Veto = () => false;

/**
 * CONTROL ARM 2 ONLY — the pre-ninth-wave `panicIsCapturedPrint` VERBATIM
 * (last `\S+`-token line for the name decides; no monotone-any-ok rule; the
 * spaced doctest path unmatchable). It is a deliberately dead copy: nothing but
 * that control reads it, and it exists so the sweep proves it can SEE the
 * defects the shipped predicate fixed. BOTH of its differences from the shipped
 * rule are exercised: the same-named-crate capture below is what the monotone
 * any-ok rule costs it, and the spaced-doctest-path capture is what the
 * whole-span name matcher costs it — 8 permutations each, so either rule being
 * re-spelled away shows up in this control's count AND in the shipped sweep's
 * under-refusals. A control whose count came from one rule alone would be blind
 * to the other's regression.
 */
const PRE_WAVE_VERDICT_RE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED)\b/;
export const preWaveVeto: Veto = (stream, name) => {
  if (name === undefined) return false;
  let passed = false;
  for (const raw of stream.split("\n")) {
    const m = PRE_WAVE_VERDICT_RE.exec(raw.trim());
    if (m !== null && m[1] === name) passed = m[2] === "ok";
  }
  return passed;
};

// ── the generator ────────────────────────────────────────────────────────────

export function cases(): Case[] {
  const out: Case[] = [];
  for (const p of PADS) {
    for (const marker of MARKERS) {
      const head = marker ? ["FAILED: smoke-tests/test-gate.ts"] : [];

      // CAPTURE: a passing `#[should_panic]` unit test's print — name-correlated
      // ok, the print both above and below its own verdict line (nocapture).
      for (const before of [false, true]) {
        out.push({
          stream: [
            ...head,
            "running 3 tests",
            ...(before
              ? [header("a::t", "src/a.rs:7:5"), "explicit panic", shouldPanicOk("a::t")]
              : [shouldPanicOk("a::t"), header("a::t", "src/a.rs:7:5"), "explicit panic"]),
            "test a::one ... ok",
            "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured",
            "make: *** [Makefile:12: e2e] Error 1",
            ...pad(p, `sp${before}`),
          ].join("\n"),
          header: header("a::t", "src/a.rs:7:5"),
          kind: "capture",
        });
      }

      // CAPTURE: same-named crates — the passing crate's capture sits beside a
      // later `... FAILED` for the same name (the pre-wave last-word defect
      // unshielded it), and the run closed FAILED on the SIBLING crate.
      out.push({
        stream: [
          ...head,
          "running 1 test",
          shouldPanicOk("shared::t"),
          header("shared::t", "src/a.rs:1:1"),
          "captured print of the passing crate",
          ...pad(p, "sf"),
          "test shared::t ... FAILED",
          "assertion failed: the sibling crate really failed",
          "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
        ].join("\n"),
        header: header("shared::t", "src/a.rs:1:1"),
        kind: "capture",
      });

      // CAPTURE: a `#[should_panic]` capture whose thread name carries SPACES —
      // the shape the WHOLE-SPAN name group exists for, spelled like the spaced
      // DOCTEST verdict path because that is the line family the name must be
      // matched against. (What cargo really prints for a doctest panic is
      // `thread 'main' …` — see `verify-rust-golden.ts`; this header is the
      // device that tells `(.+?)` from `(\S+)`, not a claimed toolchain print.)
      // With a `(\S+)` name group the matcher captures `src/lib.rs`, the name's
      // `ok` line goes unmatched, and the passing capture is quoted: this is the
      // one case in the corpus that tells the two matchers apart, so a re-spell
      // of the shipped group back to `(\S+)` goes red here and nowhere else.
      const spaced = "src/lib.rs - parses (line 3)";
      out.push({
        stream: [
          ...head,
          "running 1 test",
          `test ${spaced} ... ok`,
          header(spaced, "src/lib.rs:5:5"),
          "explicit panic",
          "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured",
          "make: *** [Makefile:12: e2e] Error 1",
          ...pad(p, "dt"),
        ].join("\n"),
        header: header(spaced, "src/lib.rs:5:5"),
        kind: "capture",
      });

      // REAL: the genuinely failing test's panic — observed FAILED for the
      // exact name, whatever else the stream reports around it.
      out.push({
        stream: [
          ...head,
          "running 4 tests",
          "test b::t ... ok",
          "test b::slow ... FAILED",
          header("b::slow", "src/b.rs:9:9"),
          "assertion failed: elapsed < 100ms",
          "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured",
          "error: test failed, to rerun pass `--lib`",
          ...pad(p, "rf"),
        ].join("\n"),
        header: header("b::slow", "src/b.rs:9:9"),
        kind: "real",
      });

      // REAL: #1762's chain shape — a completed green STAGE, then a later
      // binary dying as `main` with no capture label and no tally below. The
      // refusals above must never swallow this.
      out.push({
        stream: [
          ...head,
          "running 3 tests",
          "test m::a ... ok",
          "test m::b ... ok",
          "test m::c ... ok",
          "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured",
          ...pad(p, "ch"),
          header("main", "src/main.rs:12:5"),
          "smoke check failed: expected 200 got 500",
        ].join("\n"),
        header: header("main", "src/main.rs:12:5"),
        kind: "real",
      });

      // REAL: unobserved name, run ABORTED — no tally closed the region, so
      // nothing attributed the print away (the foreign-target shape).
      out.push({
        stream: [
          ...head,
          "running 1 test",
          header("pkg::other", "src/other.rs:4:4"),
          "assertion failed: `(left == right)` the value the change broke",
          "Aborted (core dumped)",
          "error: process didn't exit successfully: signal: 6, SIGABRT",
          ...pad(p, "ab"),
        ].join("\n"),
        header: header("pkg::other", "src/other.rs:4:4"),
        kind: "real",
      });

      // REAL: exact-name match — prefix-siblings' ok lines answer for nobody.
      out.push({
        stream: [
          ...head,
          "running 3 tests",
          "test px::t2 ... ok",
          "test px::t::nested ... ok",
          ...pad(p, "px"),
          header("px::t", "src/px.rs:1:1"),
          "assertion failed: a prefix-named sibling passed, I did not",
          "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured",
        ].join("\n"),
        header: header("px::t", "src/px.rs:1:1"),
        kind: "real",
      });

      // REAL: a bare truncated header alone — unobserved verdicts veto nothing.
      out.push({
        stream: [...head, ...noise(p, `tr${p}`), header("t::t", "src/t.rs:2:2")].join("\n"),
        header: header("t::t", "src/t.rs:2:2"),
        kind: "real",
      });
    }
  }
  return out;
}

// ── the fold pairs (control arm 2's other half) ──────────────────────────────
//
// A base run and a change run that differ by an ADDED failure yet, under the
// pre-wave veto, both extract the byte-identical capture header: the base's
// "assertion at base" then compared as the SAME as the change's failure and
// excused it (`baselineExplainsChange`'s input). Under the shipped veto both
// extracts refuse the capture and no pair folds.
const FOLD_CAPTURE = (extra: string[]): string[] => [
  "FAILED: smoke-tests/test-gate.ts",
  "running 1 test",
  shouldPanicOk("fold::t"),
  header("fold::t", "src/f.rs:1:1"),
  "captured print of the passing crate",
  ...extra,
  "test fold::t ... FAILED",
  "assertion failed: the sibling crate really failed",
  "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
];
export const foldPairs: Array<{ base: string; change: string }> = [
  {
    base: FOLD_CAPTURE(pad(20, "fb")).join("\n"),
    change: [
      "FAILED: smoke-tests/test-gate.ts",
      "running 1 test",
      shouldPanicOk("fold::t"),
      header("fold::t", "src/f.rs:1:1"),
      "captured print of the passing crate",
      header("y::added", "src/y.rs:8:8"),
      "assertion failed: the failure the change added",
      ...pad(20, "fc"),
      "test fold::t ... FAILED",
      "assertion failed: the sibling crate really failed",
      "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
    ].join("\n"),
  },
  // A SECOND, STRUCTURALLY DIFFERENT SAMPLE: the capture prints BELOW the
  // sibling's FAILED verdict (nocapture ordering, not first-in-stream), and the
  // failure the change adds is a non-panic assertion line rather than a second
  // panic header — so the pre-wave reader still returns the capture from both
  // runs and the pair folds, while the shipped predicate refuses it on the
  // name's own `ok`.
  {
    base: [
      "running 1 test",
      shouldPanicOk("dup::t"),
      "test dup::t ... FAILED",
      "assertion failed: the sibling crate really failed",
      "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
      header("dup::t", "src/d.rs:2:2"),
      "captured print of the passing crate, printed last",
      ...pad(12, "d2b"),
    ].join("\n"),
    change: [
      "running 1 test",
      shouldPanicOk("dup::t"),
      "test dup::t ... FAILED",
      "assertion failed: the sibling crate really failed",
      "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
      header("dup::t", "src/d.rs:2:2"),
      "captured print of the passing crate, printed last",
      ...pad(12, "d2c"),
      "Error: expect(received).toBe(expected) the check the change added",
      "    at Object.<anonymous> (src/added.ts:9:13)",
    ].join("\n"),
  },
];

/**
 * The id-bearing rendering of one text: every header line gains cargo's
 * per-thread id, spelled by the SHARED fixture builder rather than a literal here
 * — the same reason the sweep asks the shipped veto instead of copying it. The
 * id-bearing corpus is #2372's: the whole #2341 suite ran on the id-less spelling
 * while the shipped dialect could not match a real cargo run at all.
 */
export function withThreadIds(text: string, id: number): string {
  return text.replace(
    /^thread '([^']+)' panicked at (\S+):$/gm,
    (_match: string, name: string, at: string): string => rustPanicHeaderWithId(name, at, id),
  );
}
