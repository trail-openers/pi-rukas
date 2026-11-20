/**
 * lib/lean-review-fixtures-golden-note — where the off-arm goldens for the fixer-truncation
 * continuation COME FROM, and what makes them goldens rather than a second copy of the code under test.
 *
 * The claim `test-lean-review-fixer-truncation-off-arm.ts` defends is that
 * `PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK=0` leaves the handback cause and the headless
 * `failure.message` byte-identical to what this repo wrote before the continuation existed. A string
 * re-derived from `review-progress.ts` in the same change that edits it proves only that the module
 * agrees with itself — the exact failure mode the two house precedents exist to avoid
 * (`lib/adversarial-verdict-reask-off-arm-golden.ts`, `lib/lean-review-incomplete-cap-golden.ts`, which
 * each capture the pre-change bytes and compare against those).
 *
 * So the two constants below were captured by checking out the base commit of this PR's branch —
 * `188a7a75b2` — and running the SAME step, with the switch unset (the pre-change build has no knob to
 * set), against a real temp repo:
 *
 *   1. `makeRepo()` + `setup({feature: "export const f = 3;\n"})` — the harness's own builders;
 *   2. `reviewOutcome(ctx, depsWith({ adversarial: blockingReject("1. the finding …") }))` with the
 *      default stub fixer, which changes nothing, so the wave throws `ReviewInfraError` at the no-change
 *      refusal (`lib/lean-gate-stubs.ts`, `lib/lean-review-fixtures.ts`);
 *   3. the message recorded verbatim, and the same record projected through
 *      `leanResultDocument(run, 10).doc` for `failure.message`.
 *
 * Nothing re-runs the pre-change modules to derive the values, and nothing re-types them: each constant
 * is the string a pre-change build emitted, pasted. `on !== off` is asserted in the suite beside them,
 * so the constants cannot be quietly replaced with the on-arm's own output — a golden equal to the new
 * behaviour is not an off arm, it is a missing test.
 *
 * The clause the on arm appends is stated here as its own constant because the two assertions it
 * supports pull in opposite directions, and one file has to hold both: it must be PRESENT in the on
 * arm's message and ABSENT from the off arm's byte-equality. Naming it once keeps a future edit to the
 * wording from being made in the test and not in the module.
 */

/** The pre-change `ReviewInfraError` message for a fix wave that changed nothing, captured at the base
 *  commit named above. Compared with `===`, never with `includes`. */
export const GOLDEN_OFF_CAUSE =
  "review fix produced no change: the fix wave left the branch at {HEAD12} — it fixed nothing, and re-reviewing an identical commit is a pass the run should not be given";

/** The clause the on arm appends and the off arm must never contain. */
export const ON_TRUNCATION_CLAUSES = [
  "the fixer's last turn was cut off at the output-token limit",
  "before any edit, and one continuation changed nothing",
];
