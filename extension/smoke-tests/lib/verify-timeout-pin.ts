/**
 * The env pin for tests that assert the verify gate's DEFAULT bound.
 *
 * The gate reads `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` from the environment, so an
 * operator who has raised it (a 45-min laptop setting) would fail a
 * "10-min timeout" assertion for the wrong reason. Rather than restate the
 * default — a pinned literal that silently disagrees with production the day
 * the default moves — the pin DELETES the variable, so the code under test
 * falls back to `verifyTimeoutMs()`'s own default, and one assertion here
 * ties that default to the text the cases quote.
 *
 * Not a test itself (no `test-` prefix, so the gate glob does not run it).
 */

import { boundText, verifyTimeoutMs } from "../../src/work-driver-verify-develop-helpers.ts";

/** The knob the verify gate reads its bound from. */
const VERIFY_TIMEOUT_ENV = "PI_ENSEMBLE_VERIFY_TIMEOUT_MS";

/** The production default bound as a person reads it ("10-min", "45s", …). */
export function defaultBoundText(): string {
  return boundText(defaultVerifyTimeoutMs());
}

/** The production default bound in ms, read with the knob absent. */
export function defaultVerifyTimeoutMs(): number {
  const saved = process.env[VERIFY_TIMEOUT_ENV];
  delete process.env[VERIFY_TIMEOUT_ENV];
  try {
    return verifyTimeoutMs();
  } finally {
    if (saved === undefined) delete process.env[VERIFY_TIMEOUT_ENV];
    else process.env[VERIFY_TIMEOUT_ENV] = saved;
  }
}

/**
 * Run `caseFn` with `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` absent, so the code under
 * test resolves the production default itself, and restore the operator's
 * value afterwards. Awaitable either way, so a sync or async block both work.
 */
export async function pinDefaultVerifyTimeout<T>(caseFn: () => T): Promise<T> {
  const saved = process.env[VERIFY_TIMEOUT_ENV];
  delete process.env[VERIFY_TIMEOUT_ENV];
  try {
    return await caseFn();
  } finally {
    if (saved === undefined) delete process.env[VERIFY_TIMEOUT_ENV];
    else process.env[VERIFY_TIMEOUT_ENV] = saved;
  }
}
