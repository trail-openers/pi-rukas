/**
 * lib/lean-result-gates-switch — the ONE reader of the switch that decides whether
 * `work-lean`'s result record carries its `gates` object.
 *
 * The gate events (which files froze per criterion, what the challenge returned,
 * which tier went red at which criterion, what each review round found, which head
 * a fix wave pushed, and what the handback shipped) are the run's internal verdicts.
 * `pi-rukas-result.json` is the host contract, and a host that reads the document
 * today has to reconstruct them from `.pi/lean-state/<issue>.json` — the driver's
 * private persistence, which carries no stability promise. Publishing them under
 * `issues[].gates` moves the question to the record that does promise.
 *
 * Because it is a new surface on a published document, it ships behind its own
 * switch: only the literal `"0"` takes the object out, and with it out the document
 * is byte-for-byte the one this build wrote before the object existed. Unset and any
 * other value leave it on.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs
 * in one bun process and pins off/on arms with `withEnv`, so a load-time read would
 * let one file's pin silently disable the object in the next.
 */

/** Whether the result record carries `issues[].gates`. */
export function leanResultGatesEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_RESULT_GATES !== "0";
}
