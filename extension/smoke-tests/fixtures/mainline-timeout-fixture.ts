#!/usr/bin/env bun
/**
 * #1387 fix round — the fake executor behind `test-mainline-probe-timeout.ts`.
 *
 * The probe under test is `detectMainline`, which sits on the fail-closed
 * paths: the review ledger (`identityBase`) and the merge guard both resolve
 * `<remote>/<mainline>` through it. The finding is that neither probe passed a
 * `timeout`, so a `gh` on a stalled connection settled never.
 *
 * The fake proves the bound by RECORDING the `timeout` option each probe hands
 * it, and by rejecting immediately with node's exec timeout shape. No real
 * delay and no wall-clock watchdog: an assertion about an option a call carried
 * is a fact about the code, not about this machine's scheduler, and a test that
 * measures elapsed time fails on a loaded CI box for reasons unrelated to the
 * bound.
 */

/** What a recorded probe call looked like. */
export interface ProbeCall {
  cmd: string;
  /** The bound the probe passed. `undefined` is the finding: no bound at all. */
  timeout?: number;
  cwd?: string;
}

/**
 * The rejection node's `promisify(exec)` produces when `opts.timeout` fires.
 *
 * `killed` / `signal` are the fields `exec` stamps on the error — present so a
 * caller that ever discriminates on them sees the real shape rather than a
 * bare Error.
 */
export function execTimeoutError(cmd: string): Error & { killed: boolean; signal: string } {
  return Object.assign(new Error(`Command timed out after ${cmd.slice(0, 40)}: killed`), {
    killed: true,
    signal: "SIGTERM",
  });
}

/**
 * A fake executor that records each call and rejects with the exec timeout
 * shape for the probes `hangWhich` selects.
 *
 * @param hangWhich which probes fail. `"both"` is the case that matters for the
 *                  BOUND: the `gh` fallback only runs after the `git
 *                  symbolic-ref` probe returns, so if only the first probe is
 *                  bounded and the second hangs, the second call still reaches
 *                  this executor — it just never settles. Recording the
 *                  `timeout` option each call CARRIED (rather than waiting for a
 *                  rejection) is what makes that shape observable at all: a
 *                  hanging probe that never returns would hide the second call
 *                  from a `calls.length` assertion, and "the second call is
 *                  missing" is indistinguishable from "the second call hung".
 *                  `"symbolic-ref"` exercises the other half — the first probe
 *                  failing is the only thing that makes the `gh` fallback run,
 *                  so an attribution bug that blamed the timeout on the probe
 *                  that ANSWERED is only visible when the two probes fail
 *                  differently.
 */
export function mkFailingExec(hangWhich: "both" | "symbolic-ref" | "gh" = "both"): {
  fn: (cmd: string, opts?: Record<string, unknown>) => Promise<{ stdout: string }>;
  calls: ProbeCall[];
} {
  const calls: ProbeCall[] = [];
  const fails = (cmd: string) =>
    hangWhich === "both" ||
    (hangWhich === "gh" ? cmd.includes("gh ") : cmd.includes("symbolic-ref"));
  const fn = async (cmd: string, opts: Record<string, unknown> = {}) => {
    calls.push({
      cmd,
      timeout: opts.timeout as number | undefined,
      cwd: opts.cwd as string,
    });
    if (!fails(cmd)) return { stdout: "" };
    throw execTimeoutError(cmd);
  };
  return { fn, calls };
}

/** An executor that resolves every probe with the given stdout. */
export function mkGreenExec(stdout: string) {
  return async () => ({ stdout });
}

/**
 * An executor that rejects every probe with a caller-supplied message — the
 * three faults the finding says were indistinguishable (a timeout, a missing
 * `gh`, a non-zero exit) differ only in this text.
 *
 * The `opts` parameter is unused; it is here so the fake matches the
 * `MainlineExecFn` signature the probe calls with.
 */
export function mkThrowingExec(messageFor: (cmd: string) => string) {
  return async (cmd: string, _opts: Record<string, unknown> = {}) => {
    throw new Error(messageFor(cmd));
  };
}

/**
 * An executor that rejects with a caller-supplied ERROR OBJECT, so the fields
 * `exec` stamps (`stderr`, `code`, `killed`, `signal`) can be set explicitly.
 *
 * `mkThrowingExec` carries only a message, which is enough for the three-faults
 * case; sanitisation claims (a token on `stderr`, an exit code on `code`) live
 * on the fields, so they need a fake that can put them there.
 */
export function mkRejectingExec(errorFor: (cmd: string) => Error & Record<string, unknown>): {
  fn: (cmd: string, opts?: Record<string, unknown>) => Promise<{ stdout: string }>;
  calls: ProbeCall[];
} {
  const calls: ProbeCall[] = [];
  const fn = async (cmd: string, opts: Record<string, unknown> = {}) => {
    calls.push({
      cmd,
      timeout: opts.timeout as number | undefined,
      cwd: opts.cwd as string,
    });
    throw errorFor(cmd);
  };
  return { fn, calls };
}
