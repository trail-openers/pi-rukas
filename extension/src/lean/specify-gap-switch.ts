/**
 * lean/specify-gap-switch — the ONE reader of the switch that decides how a run ends when `specify`'s own
 * child could not prove a criterion red.
 *
 * On, the attempt loop's final gap is `red-test-gap`, which hands the run back (exit 10): the run failed to
 * write a falsifiable test, and a test that passes on the base may equally mean the criterion already holds
 * there — neither is a fault of the issue's spec. Off, the gap is `no-red-test` and the run declines at exit
 * 11. The refusals `specify` makes before any child is dispatched (a spec that fails readiness, no
 * `verify.test` runner) and a provider fault on the final attempt are `no-red-test` on either arm. Only the
 * literal `"0"` turns it off, read at CALL time.
 */
/** The specify outcome kind for a gap the step's own child left. */
export const RED_TEST_GAP = "red-test-gap";

/** Whether a gap the specify child left hands the run back instead of declining it. */
export function leanSpecifyGapHandbackEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_SPECIFY_GAP_HANDBACK !== "0";
}
