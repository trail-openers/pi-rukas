/**
 * lib/lean-verify-rerun — the head TIER RE-RUN that observed nothing.
 *
 * The baseline excuse reads the re-run's OUTPUT to decide which tests the head
 * failed, and every shape the executor uses for "nobody ran anything" still carries
 * a `stdout`: a killed tier prints what it printed before the signal, an overflowed
 * one prints its first 16 MiB, an un-startable one arrives with the harness's own
 * message. A tier that observed nothing may not be excused over the base commit on
 * the strength of text nobody finished producing, so the step's own re-run is the
 * arm that has to refuse — and the shapes below are the ones `tierObserved` says
 * `false` for, built from `execp`'s own stamps rather than a case's invention.
 */

/** A tier killed by the executor's wall clock: `killed` + `timedOutKill`, no exit code. */
export function killedRerun(stream: string): unknown {
  return Object.assign(new Error("tier timed out"), {
    code: null,
    killed: true,
    timedOutKill: true,
    signal: "SIGKILL",
    stdout: stream,
    stderr: "",
  });
}

/** A tier whose output was truncated by `maxBuffer`: the evidence is not in hand. */
export function overflowedRerun(stream: string): unknown {
  return Object.assign(new Error("max buffer exceeded"), {
    code: 1,
    overflow: "stdout",
    stdout: stream,
    stderr: "",
  });
}

/** A tier the shell could not start: a STRING code, no exit status. */
export function unstartedRerun(): unknown {
  return Object.assign(new Error("spawn sh ENOENT"), {
    code: "ENOENT",
    errno: -2,
    syscall: "spawn",
    stdout: "",
    stderr: "",
  });
}
