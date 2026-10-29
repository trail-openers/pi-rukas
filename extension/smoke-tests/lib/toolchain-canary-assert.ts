/**
 * test-toolchain-canary-assert — the shared pass/fail counter for both halves
 * of the #1879 canary test, so the two files report one verdict each and share
 * one shape. `assertRed` is the mutation-control counterpart of `assert`: it
 * fails when the condition is TRUE, which is how a mutant that behaves like the
 * honest implementation is caught — a test that stays green under mutation was
 * never testing anything.
 */

let exit = 0;

export function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Assert that `cond` is FALSE — and fail the run if it was TRUE. */
export function assertRed(cond: boolean, msg: string) {
  if (!cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

export function exitCode(): number {
  return exit;
}
