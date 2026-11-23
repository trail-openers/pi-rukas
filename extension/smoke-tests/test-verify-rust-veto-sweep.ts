#!/usr/bin/env bun
/**
 * #2341 fix wave 9 — the RUST VETO SWEEP: a generated corpus of cargo/libtest
 * streams with a per-case ground truth (the generator knows what it built),
 * asked against the PRODUCTION extractor, plus the two control arms that make
 * a zero count mean "the sweep can see failures" rather than "the sweep is
 * blind". The wave-7 sweep reported `underRefusals = 0` on a classifier whose
 * predicate was strictly weaker than the veto's, so ABSENT could not fail —
 * the falsifiability these controls supply is the whole point. The corpus, the
 * three vetoes and the model extractor live in `lib/verify-rust-sweep-corpus.ts`
 * (AGENTS.md §12 size split); this file keeps the counts and the assertions —
 * the parts that can fail.
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
 *   - control arm 2 (the PRE-WAVE predicate, a verbatim copy in the corpus
 *     module) must produce under-refusals AND folds: the exact defects the wave
 *     executed (the same-named-crate capture quoted because a later
 *     `... FAILED` was the name's last word; base and change extracting the
 *     byte-identical capture header so the added failure was excused). If a
 *     re-spell ever makes these controls trivially pass, the sweep has stopped
 *     being able to see its own failures.
 *
 * Runtime: pure string generation and regex scans — well under a second.
 *
 * WHAT THE CORPUS COVERS (#2372): every case is asked TWICE, once in the id-less
 * spelling and once carrying cargo's per-thread id —
 * `thread 'a::t' (40001) panicked at src/a.rs:7:5:` — which is the spelling a
 * current cargo prints on every header, `main` and pool worker included. The
 * id-bearing half is not decoration: the whole #2341 suite ran for weeks on the
 * id-less spelling alone while the shipped dialect could not match a real run, so
 * the parity arm below (same corpus, same ground truth, ids inserted by the
 * shared builder) is what keeps "the dialect is inert on the current toolchain"
 * from being a green build again. Identity strips the id out of BOTH of its
 * operands, so both halves of the corpus judge a capture a capture and a real
 * failure a real failure.
 *
 * WHAT STAYS DEFERRED, AND WHY IT IS NOT COVERED HERE: the two unobserved-name
 * classes — a panic on a non-test thread inside an otherwise green target, and a
 * `#[should_panic]` doctest — are refused by nothing in the shipped QUOTE veto.
 * Their headers now PARSE (their names read, their keys read, and the asks below
 * are genuinely made of them), and the excuse gate (`panicCanExcuseChange`)
 * excuses nothing from them; what no verdict line can do is say which RUN a
 * header belongs to, and that needs cargo's per-target banner identity
 * (`     Running unittests src/main.rs (…)`, `   Doc-tests pkg`). Those banners
 * are stderr-only while headers and verdict lines are stdout-only, and the exec
 * layer concatenates stdout before stderr, so no banner precedes the verdict
 * lines it would have to bind: target-scoped verdict lookup is unavailable on the
 * production stream, which is why no case here generates those classes and why
 * the follow-up's two shapes — the aborted-target then green-target composite
 * (one target aborts with its panic, the next closes `0 failed`) and the
 * `---- <name> stdout ----` block label (a label names its own block, never the
 * header below it) — are pinned with the refusal, not before it.
 */

import {
  NO_SPECIFIC_ASSERTION,
  extractSpecificAssertion,
} from "../src/work-driver-verify-assertion.ts";
import { rustPanicSamenessKey } from "../src/work-driver-verify-failures.ts";
import { makeAssert } from "./lib/verify-failure-shapes-fixtures.ts";
import {
  cases,
  foldPairs,
  modelExtract,
  neuteredVeto,
  preWaveVeto,
  shippedVeto,
  withThreadIds,
  type Case,
  type Veto,
} from "./lib/verify-rust-sweep-corpus.ts";

const { assert, failed } = makeAssert();

const corpus = cases();

/** The whole corpus, every header carrying an id — the spelling cargo prints. */
const ID = 40001;
const idCorpus: Case[] = corpus.map((c) => ({
  stream: withThreadIds(c.stream, ID),
  header: withThreadIds(c.header, ID),
  kind: c.kind,
}));

/**
 * One pass of the sweep: what the production extractor and the model extractor
 * answer for each case, and the two counts that must both be zero. Extracted so
 * the id-bearing corpus is asked the IDENTICAL questions — an arm that asks a
 * weaker question than the sweep it mirrors proves nothing about the spelling it
 * was written for.
 */
function sweep(cs: Case[]): {
  underRefusals: number;
  wrongAbsences: number;
  fidelityFailures: number;
} {
  let underRefusals = 0;
  let wrongAbsences = 0;
  let fidelityFailures = 0;
  for (const c of cs) {
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
  return { underRefusals, wrongAbsences, fidelityFailures };
}

const main = sweep(corpus);
const idArm = sweep(idCorpus);

const underWith = (cs: Case[], veto: Veto): number =>
  cs.filter(
    (c) =>
      c.kind === "capture" &&
      modelExtract(c.stream, veto) !== null &&
      rustPanicSamenessKey(modelExtract(c.stream, veto)!) === rustPanicSamenessKey(c.header),
  ).length;

const neuteredUnder = underWith(corpus, neuteredVeto);
const preWaveUnder = underWith(corpus, preWaveVeto);
// The same two controls over the id-bearing corpus: if that arm ever degenerates
// so its controls cannot see a failure, it has stopped being able to see its own
// failures — exactly the condition the id-less controls exist to report.
const idNeuteredUnder = underWith(idCorpus, neuteredVeto);
const idPreWaveUnder = underWith(idCorpus, preWaveVeto);

const foldCountOn = (veto: Veto, pairs: Array<{ base: string; change: string }>): number =>
  pairs.filter((p) => {
    const a = modelExtract(p.base, veto);
    const b = modelExtract(p.change, veto);
    return a !== null && b !== null && rustPanicSamenessKey(a) === rustPanicSamenessKey(b);
  }).length;
// The same two folds with a DIFFERENT id on each run's header, which is what two
// runs of one failure actually print: the fold must still be visible to the
// control and still impossible under the shipped predicate, so the id
// normalisation cannot quietly turn the fold arm into a blind one.
const foldPairsIdBearing: Array<{ base: string; change: string }> = foldPairs.map((p) => ({
  base: withThreadIds(p.base, ID),
  change: withThreadIds(p.change, ID + 1),
}));
const preWaveFolds = foldCountOn(preWaveVeto, foldPairs);
const shippedFolds = foldCountOn(shippedVeto, foldPairs);
const preWaveIdFolds = foldCountOn(preWaveVeto, foldPairsIdBearing);
const shippedIdFolds = foldCountOn(shippedVeto, foldPairsIdBearing);

const captures = corpus.filter((c) => c.kind === "capture").length;
const idCaptures = idCorpus.filter((c) => c.kind === "capture").length;
const idReal = idCorpus.length - idCaptures;

console.log(
  `sweep: ${corpus.length} permutations (${captures} capture / ${corpus.length - captures} real), ` +
    `underRefusals=${main.underRefusals}, wrongAbsences=${main.wrongAbsences}, ` +
    `fidelity=${main.fidelityFailures}, folds=${shippedFolds}; controls: ` +
    `neutered=${neuteredUnder}, pre-wave=${preWaveUnder} under-refusals + ${preWaveFolds} folds\n` +
    `id-bearing arm: ${idCorpus.length} permutations (${idCaptures} capture / ${idReal} real), ` +
    `underRefusals=${idArm.underRefusals}, wrongAbsences=${idArm.wrongAbsences}, ` +
    `fidelity=${idArm.fidelityFailures}, folds=${shippedIdFolds}; controls: ` +
    `neutered=${idNeuteredUnder}, pre-wave=${idPreWaveUnder} under-refusals + ${preWaveIdFolds} folds`,
);

assert(
  main.fidelityFailures === 0,
  `sweep fidelity: model and production extractor agree on all ${corpus.length} permutations`,
);
assert(
  main.underRefusals === 0,
  `sweep: a passing capture is never quoted (got ${main.underRefusals} under-refusals)`,
);
assert(
  main.wrongAbsences === 0,
  `sweep: a real failure never reports absence (got ${main.wrongAbsences} wrong absences)`,
);
assert(
  shippedFolds === 0,
  `sweep: no two-failure fold under the shipped veto (got ${shippedFolds})`,
);
assert(
  neuteredUnder > corpus.length / 4,
  `sweep control (veto neutered): a veto-less reader must quote most captures (got ${neuteredUnder})`,
);
assert(
  preWaveUnder > 0,
  `sweep control (pre-wave predicate): must see the capture defects it shipped with (got ${preWaveUnder})`,
);
assert(
  preWaveFolds > 0,
  `sweep control (pre-wave predicate): must see the fold the base commit produced (got ${preWaveFolds})`,
);

// #2372 — the id-bearing parity arm. Every question above, asked of the spelling
// a current cargo prints, with its own non-zero counts: an arm that silently saw
// no case is the blind sweep the ticket names.
assert(
  idCorpus.length === corpus.length && idCaptures > 0 && idReal > 0,
  `id-bearing arm: the whole corpus is generated in both spellings (${idCorpus.length} cases, ${idCaptures} capture / ${idReal} real — all non-zero)`,
);
assert(
  idCorpus.every((c) => c.header.includes(`(${ID})`)),
  "id-bearing arm: every case's header really carries the id (the arm is not asking the id-less question)",
);
// The same non-vacuity guard for the fold arm, which has no `header` field to
// check: if `withThreadIds`' anchor stopped matching, this arm would silently
// re-measure the id-less pairs and still report the counts it always reported.
assert(
  foldPairsIdBearing.every((p) =>
    [p.base, p.change].every(
      (t) =>
        /^thread '[^']+' \(\d+\) panicked at /m.test(t) &&
        !/^thread '[^']+' panicked at /m.test(t),
    ),
  ),
  "id-bearing fold arm: both runs of every pair really carry their ids (no header left in the id-less spelling)",
);
assert(
  idArm.fidelityFailures === 0,
  `id-bearing arm fidelity: model and production extractor agree on every id-bearing permutation (got ${idArm.fidelityFailures})`,
);
assert(
  idArm.underRefusals === 0,
  `id-bearing arm: a passing capture with an id is never quoted (got ${idArm.underRefusals} under-refusals)`,
);
assert(
  idArm.wrongAbsences === 0,
  `id-bearing arm: an id-bearing real failure never reports absence (got ${idArm.wrongAbsences} wrong absences) — a matcher that lost the id fails HERE`,
);
assert(
  shippedIdFolds === 0,
  `id-bearing arm: no two-failure fold under the shipped veto (got ${shippedIdFolds})`,
);
assert(
  idNeuteredUnder > idCorpus.length / 4,
  `id-bearing control (veto neutered): a veto-less reader must quote most id-bearing captures (got ${idNeuteredUnder})`,
);
assert(
  idPreWaveUnder > 0,
  `id-bearing control (pre-wave predicate): must see the capture defects on the id-bearing spelling (got ${idPreWaveUnder})`,
);
assert(
  preWaveIdFolds > 0,
  `id-bearing control (pre-wave predicate): must see the id-bearing fold across differing ids (got ${preWaveIdFolds})`,
);

console.log(failed() ? "SWEEP FAILED" : "All Rust veto sweep checks passed.");
process.exit(failed() ? 1 : 0);
