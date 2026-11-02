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

export function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    state.exit = 1;
  }
}

/** Run `fn`, and assert it refused with a message matching `why`. */
export function refused(fn: () => unknown, why: RegExp, label: string): void {
  let threw: Error | undefined;
  let value: unknown;
  try {
    value = fn();
  } catch (e) {
    threw = e as Error;
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
