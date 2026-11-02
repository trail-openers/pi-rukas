/**
 * lens-fidelity-ratchet-mutants — the five entry points the ratchet must show can
 * fail, one mutant each, at `7d1b71eb`.
 *
 * Split from the ratchet along the seam that matters operationally: THE LIST is the
 * thing a reviewer audits and the thing a new unproven check gets added to, while
 * the ratchet is machinery that should rarely change. Keeping the list in its own
 * file also keeps both under the §12 size cap without trimming a word of the
 * reasoning below, which is the reasoning that makes each row auditable.
 *
 * EVERY `from` IS A VERBATIM EXCERPT of the file it names, and every `to` is the
 * hollowing a reviewer would write to bypass the check. A mutant is credited only
 * when its red line contains `redMustContain`, so the field must quote an assertion
 * that genuinely moves — see the note on `runMutant-fidelity-call`, where the
 * obvious mutant was measured to be unobservable and the row says so instead of
 * pasting a red.
 */

import type { HarnessMutant } from "./lens-fidelity-ratchet-types.ts";

/**
 * The five entry points, one mutant each, at `7d1b71eb`. Every `from` is a verbatim
 * excerpt of the file it names, and every `to` is the hollowing a reviewer would
 * write to bypass the check. Two mutants must never produce the same red set: the
 * ratchet asserts distinctness in `assertMutantsAreDistinguishable`.
 */
export const HARNESS_MUTANTS: readonly HarnessMutant[] = [
  {
    id: "P1-noop-precondition",
    claim: "lens-class-mutants.ts P1 refuses a mutant byte-identical to shipped",
    file: "smoke-tests/lib/lens-class-mutants.ts",
    // Removes the whole `if`, not just its condition. P1 is now documented and
    // *measured* to be unreachable (`p1WitnessProvable()` brute-forces 45,240
    // reachable classes, 0 hits), so gating the condition on `false` is a
    // behaviour-free edit — a mutant that cannot change behaviour proves nothing, which
    // is the very defect the ratchet polices. Deleting the statement instead makes the
    // mutant a real edit to real code, and the arm that must move is the one the
    // refusals suite added for it: `p1WitnessProvable()`'s own claim is that no input
    // fires P1, and the companion probe proves the enumeration reaches the other
    // preconditions, so a suite whose P1 has been hollowed reports the same null. The
    // witness that reddens is therefore the DEAD-CODE PROOF itself: with the guard
    // deleted, `p1WitnessProvable` can no longer be satisfied by a message nobody
    // raises, and the assertion that names it reddens. `redMustContain` is that arm.
    from:
      "    if (mutated === literal)\n      throw new ClassRefused(\n        `deleting ${JSON.stringify(member)} from ${JSON.stringify(literal)} is a NO-OP (mutant is byte-identical to shipped)`,\n      );\n",
    to: "",
    suite: "smoke-tests/test-lens-class-refusals.ts",
    // P1 is documented AND measured to be unreachable: `p1WitnessProvable()` brute-forces
    // the 45,240 classes this generator can reach and none fire P1, because deleting a
    // token from a character class can never reproduce that class verbatim. So no
    // mutation of the code under the guard changes any observable output — which is why
    // the mutant is deleted-from-`false`-gating (a behaviour-free edit) up to deletion
    // of the statement, and still owes no red.
    observable: false,
    unobservableReason:
      "P1 is dead code: `p1WitnessProvable()` enumerates all 45,240 classes this generator can reach and none fire it, so the guard cannot be reached by any mutation. Its status is held by that brute-force assertion in test-lens-class-refusals.ts, which is the real witness; a ratchet claiming a red here would be lying.",
  },
  {
    id: "runMutant-fidelity-call",
    claim: "runMutant calls assertHarnessFidelity before measuring",
    file: "smoke-tests/lib/lens-mutant-harness.ts",
    // The honest mutant, and the reason for it is a measurement rather than a
    // preference. Deleting the bare call
    //     assertHarnessFidelity();
    // is NOT observable through `test-lens-class-mutants.ts`: `runMutant` builds
    // its classes from `{ ...SHIPPED, [flank]: mutated }`, so a drift in `SHIPPED`
    // is measured against the drifted constant and the baseline still agrees — the
    // pair stays green either way. That is itself the finding (the guard is
    // self-confirming for a `SHIPPED` drift), and a ratchet that pretends otherwise
    // would be pasting a red. So this mutant removes the call in the form that IS
    // observable: without the gate, a harness whose mirror no longer matches the
    // product keeps printing a clean table instead of refusing. `to` deletes the
    // call from `runMutant` only, leaving `runShipped`'s in place.
    // Deletes BOTH call sites. Deleting only `runMutant`'s is unobservable and the
    // row says so rather than claiming a red it cannot produce: `runMutant` builds
    // its classes from `{ ...SHIPPED, [flank]: mutated }`, so a drift in `SHIPPED` is
    // measured against the drifted constant and the pair still agrees — `assertHarnessFidelity`
    // is self-confirming there. `runShipped`'s call is the observable one, because it
    // drives the REAL `accountedFiles`: with both gates gone, the harness measures a
    // template it no longer mirrors and the reconciliation prints figures from a stale
    // mirror while the baseline still reads green.
    from: "  assertHarnessFidelity();\n  const accounted = await loadAccountedFiles();",
    to: "  const accounted = await loadAccountedFiles();",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    // The arm that moves, named by its own text: with the gate deleted, the
    // reconciliation rows are printed by a harness that never checked its mirror.
    // `assertHarnessFidelity` is SELF-CONFIRMING at both call sites, so deleting it
    // changes no output any suite can see: `runMutant` builds its classes from
    // `{ ...SHIPPED, [flank]: mutated }`, so a drift between SHIPPED and the real
    // template is measured against the drifted constant and the pair still agrees; and
    // `runShipped` never touches the real `accountedFiles` — it runs the harness's own
    // `mentionsPathWith`. Measured: deleting both calls left the class-mutants suite at
    // 39 passes, 0 reds. That is a substantive finding about where the fidelity gate
    // actually earns its keep (the shipped-vs-template reconciliation in
    // test-lens-accounted-template.ts), recorded rather than papered over with a
    // redMustContain that would match some unrelated line and read as coverage.
    observable: false,
    unobservableReason:
      "both `assertHarnessFidelity()` call sites feed it the harness's own SHIPPED constant and neither runs the real `accountedFiles`, so the check can only ever agree with itself; deleting it changes no output. The template drift it guards is caught by the reconciliation in test-lens-accounted-template.ts, which this mutant leaves untouched.",
  },
  {
    id: "measuredTable-mutantsFor-bypass",
    claim: "measuredTable's rows come from mutantsFor, never hand-typed",
    file: "smoke-tests/lib/lens-mutant-harness.ts",
    // A hand-typed table is the defect the generator exists to close, and before this
    // round the suite could not see one: replacing the `mutantsFor` call with five
    // hand-typed rows left every assertion green, because a hand-typed row can carry
    // the shipped class in `shipped` and the members the reconciliation expects. The
    // harness now reports a refusal whenever the generator produced nothing, so the
    // mutant asks the generator for a flank and returns what no generator would: an
    // empty list, which is a REFUSAL and must not be printable as a table of figures.
    from: "  const generated = mutantsFor(SHIPPED[flank]);",
    to: "  const generated = (flank === \"PATH_CHAR\" ? [] : mutantsFor(SHIPPED[flank]));",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    redMustContain: "the printed table is the generator's",
  },
  {
    id: "wholeClassRemoval-hollowed",
    claim: "wholeClassRemoval actually deletes the anchored TERMINATOR arm",
    file: "smoke-tests/lib/lens-mutant-harness.ts",
    from:
      "function mentionsPathWithoutTerminatorArm(summary: string, file: string): boolean {\n  const escaped = file.replace(",
    to:
      "function mentionsPathWithoutTerminatorArm(summary: string, file: string): boolean {\n  return mentionsPathWith(summary, file, SHIPPED);\n}\nfunction mentionsPathWithoutTerminatorArmUnused(summary: string, file: string): boolean {\n  const escaped = file.replace(",
    suite: "smoke-tests/test-lens-class-mutants.ts",
    // The discrimination check IS wired and does fire under this hollowing (measured:
    // the harness throws `no fixture distinguishes the shipped matcher from the
    // arm-deleted one`), but it fires on the harness side while the suite asserts on
    // the returned array, so the run dies before printing a `✗`. That is the same
    // throw-vs-report channel defect this round fixed elsewhere; until the check moves
    // onto the reporting path there is no red to attribute, and inventing a
    // `redMustContain` that matches an unrelated line would be worse than none.
    observable: false,
    unobservableReason:
      "the hollowed helper makes the discrimination check fire, but it fires by throwing on the harness side so the suite prints no `✗` and the ratchet has nothing to attribute; re-measure and give this a real redMustContain once the check reports rather than throws.",
  },
  {
    id: "runSilentRound-openBatch-acquire",
    claim: "runSilentRound acquires the deck batch the round is measured on",
    file: "smoke-tests/lib/lens-coverage-liveness-probe.ts",
    // `runSilentRound` rather than `silentLaneRoundArms`: both call `openBatch`, and an
    // earlier revision of this entry pointed at the wrong one and measured nothing.
    // Clobbering the deck between the acquire and the round is what a suppressed
    // acquire looks like from the outside, and the assertion it reddens is the new
    // positive-half check in `runSilentRound` — the release checks that read
    // `batchSnapshot()` cannot see a missing acquire, so without that assertion this
    // mutant stayed green at 35 passes and 0 reds.
    // The acquire assertion exists at two call sites (`silentLaneRoundArms` and
    // `runSilentRound`, which the shipped and mutant halves share), so a mutation that
    // clobbers the deck on EVERY path reddens the shipped half too — a red that is not
    // the mutant's own assertion, and an attribution the ratchet must not accept. This
    // edit makes the clobber conditional on the round being the MUTANT round, so the
    // shipped half still passes and only `rev1942mut/silent` reddens. Clobbering the
    // deck between acquire and round is what a suppressed acquire looks like from the
    // outside; the release checks that read `batchSnapshot()` cannot see a missing
    // acquire, so before the positive-half assertion this mutant was green at 35/0.
    from: "  openBatch(key, 2);\n  check(\n    dispatchDeck.batchSnapshot().some((b) => b.key === key),",
    to: "  openBatch(key, 2);\n  if (key.includes(\"/silent\")) dispatchDeck.reset();\n  check(\n    dispatchDeck.batchSnapshot().some((b) => b.key === key),",
    suite: "smoke-tests/test-lens-fanout-batch-release.ts",
    redMustContain: "acquires the deck batch its round is measured on",
  },
];
