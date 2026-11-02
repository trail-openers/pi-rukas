/**
 * The shared checker the two generator-witness files use, so "refused for the
 * right reason" cannot mean two things.
 *
 * `test-lens-class-mutants.ts` holds the acceptances and the table
 * reconciliation; `test-lens-class-refusals.ts` holds the refusals. Both assert
 * refusals, and the value of a refusal assertion is entirely in the helper that
 * distinguishes "the generator refused" from "this test file has a typo" — so
 * the helper is one file's code and both files' contract. Its `exit` counter is
 * module state the caller reads for its process exit code.
 */

import { ClassRefused } from "./lens-class-mutants.ts";

export const state = { exit: 0 };

/**
 * Evaluate `cond`, treating a THROW as a failed assertion.
 *
 * WHY THIS IS HERE AND NOT JUST `if (cond)`. A witness that computes its condition
 * can throw — and the witness that most needs to run is the one that throws
 * specifically when the thing under test is broken: `wholeClassRemoval` now throws
 * when the whole-class helper has been hollowed into a copy of the shipped matcher,
 * and if that throw escaped the assertion the suite would die before printing any
 * `✗` and before its exit code, which a mutation harness reads as "nothing failed".
 * A witness that cannot report its own failure is the defect this branch exists to
 * close, relocated into the assertion helper. The message carries the exception so
 * the throw is visible rather than laundered into a bare false.
 */
function evalCond(cond: boolean | (() => boolean), msg: string): [boolean, string | null] {
  if (typeof cond !== "function") return [cond, null];
  try {
    return [cond(), null];
  } catch (e) {
    return [false, `threw ${(e as Error).constructor.name}: ${(e as Error).message}`];
  }
}

/** `cond` may be a boolean or a thunk; a thunk that throws is a RED, not a crash. */
export function assert(cond: boolean | (() => boolean), msg: string): void {
  const [ok, thrown] = evalCond(cond, msg);
  if (ok) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}${thrown ? ` — assertion ${thrown}` : ""}`);
    state.exit = 1;
  }
}

/** Run `fn`, and assert it refused with a message matching `why`. */
export function refused(fn: () => unknown, why: RegExp, label: string): void {
  let threw: Error | undefined;
  let value: unknown;
  let callFailure: string | null = null;
  try {
    value = fn();
  } catch (e) {
    threw = e as Error;
    // A generator that throws something other than an Error (or dies in a way that
    // is not a refusal) must still be reported, not propagated: this helper's whole
    // job is to distinguish "the generator refused" from "this test file has a
    // typo", and propagating conflates the two by killing the run either way.
    if (!(e instanceof Error)) callFailure = `threw non-Error: ${String(e)}`;
  }
  if (callFailure) {
    assert(false, `${label}: ${callFailure}`);
    return;
  }
  if (!threw) {
    assert(
      false,
      `${label}: expected a REFUSAL and the generator returned ${JSON.stringify(value).slice(0, 160)} — a silent wrong set is the defect this file exists to catch`,
    );
    return;
  }
  assert(
    threw instanceof ClassRefused,
    threw instanceof ClassRefused
      ? `${label}: refused as ClassRefused (expected /${why.source}/)`
      : `${label}: threw ${threw.constructor.name}, not ClassRefused (${threw.message})`,
  );
  assert(
    why.test(threw.message),
    why.test(threw.message)
      ? `${label}: refused for the expected reason (${JSON.stringify(threw.message).slice(0, 120)})`
      : `${label}: refused for the WRONG reason — message was ${JSON.stringify(threw.message)}, expected /${why.source}/`,
  );
}
