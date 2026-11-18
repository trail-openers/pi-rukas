#!/usr/bin/env bun
/**
 * #2341 fix wave 9 — the RUST VETO SWEEP: a generated corpus of cargo/libtest
 * streams with a per-case ground truth (the generator knows what it built),
 * asked against the PRODUCTION extractor, plus the two control arms that make
 * a zero count mean "the sweep can see failures" rather than "the sweep is
 * blind". The wave-7 sweep reported `underRefusals = 0` on a classifier whose
 * predicate was strictly weaker than the veto's, so ABSENT could not fail —
 * the falsifiability these controls supply is the whole point.
 *
 *   - the classifier predicate IS the shipped veto: production cases ask
 *     `panicIsCapturedPrint` through `extractSpecificAssertion` itself and the
 *     model extractor through the imported `panicIsCapturedPrint` — one
 *     implementation, never a re-spelling;
 *   - a model-fidelity arm asserts the model extractor and the production
 *     extractor agree on every permutation (the model is what lets a control
 *     arm swap the veto without a second extractor);
 *   - control arm 1 (veto NEUTERED, `() => false`) must produce a LARGE
 *     under-refusal count — if the corpus ever degenerates so that even a
 *     veto-less reader cannot quote a passing capture, the corpus is dead and
 *     this sweep says so;
 *   - control arm 2 (the PRE-WAVE predicate, verbatim copy below — the ninth
 *     wave's fix target) must produce under-refusals AND folds: the exact
 *     defects the wave executed (the same-named-crate capture quoted because a
 *     later `... FAILED` was the name's last word; base and change extracting
 *     the byte-identical capture header so the added failure was excused).
 *     If a re-spell ever makes these controls trivially pass, the sweep has
 *     stopped being able to see its own failures.
 *
 * Runtime: pure string generation and regex scans — well under a second.
 *
 * KNOWN-DEFERRED, NOT COVERED HERE: the unobserved-name classes — a panic on a
 * non-test thread inside an otherwise green target, and a `#[should_panic]`
 * doctest — are refused by nothing in the shipped predicate (cargo per-target
 * banner identity is the missing evidence), so no case here generates them.
 */

import {
  classifyFailureLine,
  panicIsCapturedPrint,
  rustPanicSamenessKey,
  rustPanicTestName,
} from "../src/work-driver-verify-failures.ts";
import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-verify-assertion.ts";
import { makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";

const { assert, failed } = makeAssert();

type Veto = (stream: string, name: string | undefined) => boolean;

/** One generated stream, the panic header it carries, and the truth about it. */
type Case = { stream: string; header: string; kind: "capture" | "real" };

const pad = (n: number, tag: string): string =>
  n === 0
    ? []
    : Array.from({ length: n }, (_, k) => `   Compiling ${tag}_${k} v0.1.0 (registry)`);
const noise = (n: number, tag: string): string[] =>
  n === 0
    ? []
    : Array.from({ length: n }, (_, k) => `crate dep_${tag}_${k} downloaded and compiled`);
const header = (name: string, at: string): string => `thread '${name}' panicked at ${at}:`;

const PADS = [0, 2, 7, 25];
const MARKERS = [true, false];

/**
 * The model extractor: the FIRST panic header the veto under test does not
 * refuse, returned as the header (the sameness key). Only valid for the
 * generated corpus, whose recognised lines are panic headers and verdict /
 * tally / marker lines — {@link fidelity} asserts production agrees on every
 * permutation, so the model cannot silently drift from the extractor.
 */
function modelExtract(stream: string, veto: Veto): string | null {
  for (const raw of stream.split("\n")) {
    const line = raw.trim();
    if (classifyFailureLine(line)?.shape !== "rust-panic") continue;
    if (veto(stream, rustPanicTestName(line))) continue;
    return line;
  }
  return null;
}

const shippedVeto: Veto = (stream, name) => panicIsCapturedPrint(stream, name);
const neuteredVeto: Veto = () => false;

/**
 * CONTROL ARM 2 ONLY — the pre-ninth-wave `panicIsCapturedPrint` VERBATIM
 * (last `\S+`-token line for the name decides; no monotone-any-ok rule; the
 * spaced doctest path unmatchable). It is a deliberately dead copy: nothing but
 * this control reads it, and it exists so the sweep proves it can SEE the
 * defects the shipped predicate fixed — the monotone-any-ok rule and the
 * whole-span name matcher are the only differences the corpus still exercises.
 */
const PRE_WAVE_VERDICT_RE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED)\b/;
const preWaveVeto: Veto = (stream, name) => {
  if (name === undefined) return false;
  let passed = false;
  for (const raw of stream.split("\n")) {
    const m = PRE_WAVE_VERDICT_RE.exec(raw.trim());
    if (m !== null && m[1] === name) passed = m[2] === "ok";
  }
  return passed;
};

// ── the generator ────────────────────────────────────────────────────────────

function cases(): Case[] {
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
              ? [header("a::t", "src/a.rs:7:5"), "explicit panic", "test a::t ... ok"]
              : ["test a::t ... ok", header("a::t", "src/a.rs:7:5"), "explicit panic"]),
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
          "test shared::t ... ok",
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
  "test fold::t ... ok",
  header("fold::t", "src/f.rs:1:1"),
  "captured print of the passing crate",
  ...extra,
  "test fold::t ... FAILED",
  "assertion failed: the sibling crate really failed",
  "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
];
const foldPairs: Array<{ base: string; change: string }> = [
  {
    base: FOLD_CAPTURE(pad(20, "fb")).join("\n"),
    change: [
      "FAILED: smoke-tests/test-gate.ts",
      "running 1 test",
      "test fold::t ... ok",
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
      "test dup::t ... ok",
      "test dup::t ... FAILED",
      "assertion failed: the sibling crate really failed",
      "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured",
      header("dup::t", "src/d.rs:2:2"),
      "captured print of the passing crate, printed last",
      ...pad(12, "d2b"),
    ].join("\n"),
    change: [
      "running 1 test",
      "test dup::t ... ok",
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

// ── the sweep ────────────────────────────────────────────────────────────────

const corpus = cases();
let underRefusals = 0;
let wrongAbsences = 0;
let fidelityFailures = 0;
for (const c of corpus) {
  const extracted = extractSpecificAssertion(c.stream, c.stream);
  const modelled = modelExtract(c.stream, shippedVeto);
  // Fidelity: the model and the production extractor must answer identically
  // on every permutation, or the control arms would be testing a fiction.
  const prodAbsent = extracted === NO_SPECIFIC_ASSERTION;
  if (prodAbsent !== (modelled === null) || (!prodAbsent && !extracted.startsWith(modelled!))) {
    fidelityFailures++;
  }
  const quotedKey = prodAbsent ? null : rustPanicSamenessKey(extracted);
  const captureKey = rustPanicSamenessKey(c.header);
  if (c.kind === "capture" && quotedKey !== null && quotedKey === captureKey) underRefusals++;
  if (c.kind === "real" && quotedKey === null) wrongAbsences++;
}

const neuteredUnder = corpus.filter(
  (c) =>
    c.kind === "capture" &&
    modelExtract(c.stream, neuteredVeto) !== null &&
    rustPanicSamenessKey(modelExtract(c.stream, neuteredVeto)!) ===
      rustPanicSamenessKey(c.header),
).length;
const preWaveUnder = corpus.filter(
  (c) =>
    c.kind === "capture" &&
    modelExtract(c.stream, preWaveVeto) !== null &&
    rustPanicSamenessKey(modelExtract(c.stream, preWaveVeto)!) === rustPanicSamenessKey(c.header),
).length;
const foldCountOn = (veto: Veto): number =>
  foldPairs.filter((p) => {
    const a = modelExtract(p.base, veto);
    const b = modelExtract(p.change, veto);
    return a !== null && b !== null && rustPanicSamenessKey(a) === rustPanicSamenessKey(b);
  }).length;
const preWaveFolds = foldCountOn(preWaveVeto);
const shippedFolds = foldCountOn(shippedVeto);

const captures = corpus.filter((c) => c.kind === "capture").length;
console.log(
  `sweep: ${corpus.length} permutations (${captures} capture / ${corpus.length - captures} real), ` +
    `underRefusals=${underRefusals}, wrongAbsences=${wrongAbsences}, fidelity=${fidelityFailures}, ` +
    `folds=${shippedFolds}; controls: neutered=${neuteredUnder}, pre-wave=${preWaveUnder} under-refusals ` +
    `+ ${preWaveFolds} folds`,
);

assert(fidelityFailures === 0, `sweep fidelity: model and production extractor agree on all ${corpus.length} permutations`);
assert(underRefusals === 0, `sweep: a passing capture is never quoted (got ${underRefusals} under-refusals)`);
assert(wrongAbsences === 0, `sweep: a real failure never reports absence (got ${wrongAbsences} wrong absences)`);
assert(shippedFolds === 0, `sweep: no two-failure fold under the shipped veto (got ${shippedFolds})`);
assert(
  neuteredUnder > corpus.length / 4,
  `sweep control (veto neutered): a veto-less reader must quote most captures (got ${neuteredUnder})`,
);
assert(preWaveUnder > 0, `sweep control (pre-wave predicate): must see the capture defects it shipped with (got ${preWaveUnder})`);
assert(preWaveFolds > 0, `sweep control (pre-wave predicate): must see the fold the base commit produced (got ${preWaveFolds})`);

console.log(failed() ? "SWEEP FAILED" : "All Rust veto sweep checks passed.");
process.exit(failed() ? 1 : 0);
