/**
 * verify-select-changed-paths-switch — the ONE reader of the switch that governs
 * how the develop verify's test selection treats a changed file the import graph
 * cannot place (#2649).
 *
 * Before this, the selector had one answer for every such file: the full offline
 * suite. A docs edit, an ignore-file edit and a test-helper edit each paid for
 * ~1,600 tests, so nearly every factory cycle spent its develop gate on tests no
 * part of its diff could reach. With the switch on, those classes are classified
 * (`work-driver-verify-classify`) and each gets the sound subset it deserves; a
 * TypeScript helper under `smoke-tests/lib/` joins the import graph; configuration
 * still runs everything.
 *
 * With the switch off, the selector is what shipped before #2649 — the same node
 * set, the same pre-check order, the same reason strings. The claim is not a
 * paraphrase: `test-verify-select-changed-paths-off-arm.ts` compares a table of
 * changed-file sets against a golden captured once from a detached checkout of the
 * base commit.
 *
 * Only the literal `"0"` turns the new rules off. Unset and any other value leave
 * them on: the full-suite fallback is the behaviour this exists to remove, and an
 * unset variable must not quietly restore it.
 *
 * The env var is read at CALL time, not at module load: the offline smoke files
 * run in one bun process each and pin the off/on arms, so a load-time read would
 * let one file's pin disable the rule in the next.
 */

/** Whether the #2649 classification of changed non-graph paths is in force. */
export function changedPathRulesEnabled(): boolean {
  return process.env.PI_ENSEMBLE_VERIFY_SELECT_CHANGED_PATHS !== "0";
}
