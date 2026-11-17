/**
 * lean/ready-facts-switch — the ONE reader of the switch that decides whether the loader
 * rebuilds `ready`'s two step-owned facts into the loaded outcome.
 *
 * `buildOutcome` is the whitelist every step outcome passes through on its way back off
 * disk, and it rebuilds its fields by name. Until this knob it carried no clause for
 * `derivedSpec` or `baseSha`, the two fields `OWNER_OF_FIELD` gives to `ready` alone — so
 * the loader JUDGED both (`outcomeProblem` runs `derivedSpecProblem` over them and refuses
 * an unowned one) and then DROPPED both. The run-level copy survived because `settle`
 * copies them onto the run before its save, which is why derive mode worked while the step
 * log quietly disagreed with the record about which contract the run executes.
 *
 * With the knob on, `buildOutcome` rebuilds the step's copy the same way the record rebuilds
 * its own: the contract through the canonicalising reader in `state-derived-spec.ts` — the
 * `parsePiSpec(renderPiSpec(…))` round trip that makes the executed document the reader's
 * shape rather than the file's — and the sha only when it is a full commit oid. That reader
 * does not throw: `outcomeProblem` has already refused a malformed contract before the
 * rebuild runs, and a rebuilder that turned a validated value into a crash would trade a
 * silent drop for a record that will not load.
 *
 * The step's copy has no production reader today; what the rebuild restores is that the log
 * and the run agree. Which is exactly why it ships behind a switch: it changes what the run's
 * own step log retains, nothing a host consumes.
 *
 * `PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD=0` puts the drop back byte for byte: a loaded ready
 * outcome carries neither field, as every release through v0.14.87 loaded it. Only the
 * literal `"0"` turns the rebuild off.
 *
 * Read at CALL time, not at module load: every lean smoke file runs in one bun process and
 * pins off/on arms with `withEnv`, so a load-time read would let one file's pin disarm the
 * next's.
 */

/** Whether a loaded outcome keeps `ready`'s derived contract and base sha. */
export function leanReadyFactsOnLoadEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_READY_FACTS_ON_LOAD !== "0";
}
