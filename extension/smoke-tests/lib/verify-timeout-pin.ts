/**
 * The env pin for tests that assert the verify gate's DEFAULT bound.
 *
 * The gate reads `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` from the environment, so an
 * operator who has raised it (a 45-min laptop setting) would fail a
 * "10-min timeout" assertion for the wrong reason. Rather than restate the
 * default — a pinned literal that silently disagrees with production the day
 * the default moves — the pin DELETES the variable, so the code under test
 * falls back to `verifyTimeoutMs()`'s own default.
 *
 * Both consumers (`test-verify-baseline-red.ts`, `test-verify-fast-tier.ts`)
 * call the SAME two helpers: `pinDefaultVerifyTimeout` to run a block with the
 * knob absent, and `assertDefaultVerifyBound` to tie the production default to
 * the text their cases quote. The tie-down lives HERE rather than in one test
 * file so neither consumer can silently assert a bound the gate does not use.
 *
 * Not a test itself (no `test-` prefix, so the gate glob does not run it).
 */

import { boundText, verifyTimeoutMs } from "../../src/work-driver-verify-develop-helpers.ts";

/** The knob the verify gate reads its bound from. */
const VERIFY_TIMEOUT_ENV = "PI_ENSEMBLE_VERIFY_TIMEOUT_MS";

/** Run `body` with the knob absent, then put whatever was there back. */
// NOT reentrant and not concurrency-safe: the save/restore is a single
// read-modify-write of one process-global env var, so two overlapping blocks
// (nested calls, or `Promise.all` over two pinned cases) would restore the
// sentinel one block deleted. Every consumer here runs one top-level `await`
// at a time, which is the only shape this is correct for.
async function withKnobAbsent<T>(body: () => T | Promise<T>): Promise<T> {
  const saved = process.env[VERIFY_TIMEOUT_ENV];
  delete process.env[VERIFY_TIMEOUT_ENV];
  try {
    return await body();
  } finally {
    // Restore EXACTLY what was there: an absent knob stays absent, a set one
    // comes back with its value (an operator's 45-min laptop setting must
    // outlive the test block unchanged).
    if (saved === undefined) delete process.env[VERIFY_TIMEOUT_ENV];
    else process.env[VERIFY_TIMEOUT_ENV] = saved;
  }
}

/** The production default bound as a person reads it ("10-min", "45s", …). */
export async function defaultBoundText(): Promise<string> {
  return boundText(await defaultVerifyTimeoutMs());
}

/** The production default bound in ms, read with the knob absent. */
export function defaultVerifyTimeoutMs(): Promise<number> {
  return withKnobAbsent(verifyTimeoutMs);
}

/**
 * Run `caseFn` with `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` absent, so the code under
 * test resolves the production default itself, and restore the operator's
 * value afterwards. Awaitable either way, so a sync or async block both work.
 */
export async function pinDefaultVerifyTimeout<T>(caseFn: () => T): Promise<T> {
  return withKnobAbsent(caseFn);
}

/**
 * Self-check both consumers call: the production default really is the bound
 * their assertions quote, and restoring the knob puts the value back. Reports
 * through `report` (each test's own assert) rather than throwing, so a failure
 * lands in that test's ledger.
 */
export async function assertDefaultVerifyBound(
  report: (ok: boolean, msg: string) => void,
  expectedMs = 600_000,
  expectedText = "10-min",
): Promise<void> {
  const sentinel = `${expectedMs + 1}`;
  process.env[VERIFY_TIMEOUT_ENV] = sentinel;
  const restored = await defaultVerifyTimeoutMs();
  report(
    restored === expectedMs,
    `the pin restores the operator's knob afterwards (saw ${restored} = ${expectedMs} with the knob absent)`,
  );
  report(
    process.env[VERIFY_TIMEOUT_ENV] === sentinel,
    "the pin puts the sentinel knob value back after the block",
  );
  delete process.env[VERIFY_TIMEOUT_ENV];
  report(
    (await defaultVerifyTimeoutMs()) === expectedMs && boundText(expectedMs) === expectedText,
    `the default verify bound is ${expectedMs}ms / ${expectedText} with the knob absent`,
  );
}
