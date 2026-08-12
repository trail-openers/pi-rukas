/**
 * retry-config-check — does this host honour a provider's backoff?
 *
 * The harness's whole failure story assumes it does. `work-driver-failure-
 * taxonomy.ts` reads the `retry-after` a provider sends and waits it out; the
 * step router retries on that basis. All of that is downstream of one setting
 * in the operator's personal `~/.pi/agent/settings.json`, which pi-ensemble
 * does not set and cannot see from the code.
 *
 * Measured, on a real run: with `maxRetryDelayMs: 10000`, three parallel
 * research children and two `/work` developers were all killed by
 * `Server requested 59s retry delay (max: 10s). 429 status code (no body)`.
 * Cerebras was saturated — plausibly by our own concurrent children — said
 * "come back in a minute", and the client threw the request away.
 *
 * Two details make this worth a startup warning rather than a doc note:
 *
 *   1. **Nothing waits.** The throw happens inside `getRetryDelayMs` while
 *      *computing* the next delay, before any sleep is reached. It is not "wait
 *      10s then give up" — it is zero milliseconds of backoff, and the
 *      `maxRetries` budget is never consumed.
 *   2. **The setting has no other effect.** Pi's own exponential backoff is
 *      `min(0.5 * 2^i, 8) * 1000`, capped at 8s and therefore always under a
 *      10s ceiling. So this value never constrains Pi's own retries; its sole
 *      function is to discard an explicit provider instruction.
 *
 * Read-only and best-effort: an unreadable or absent settings file means the
 * default applies, which is fine, so it says nothing.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { trace } from "./trace.ts";

/** Pi's own default (`DEFAULT_MAX_RETRY_DELAY_MS` in pi-ai's provider-retry). */
export const PI_DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * Below this, a provider's normal `retry-after` gets discarded.
 *
 * Observed hints are 59-60s. Anything under a minute will drop them, so the
 * threshold is Pi's own default rather than a number of our own invention.
 */
export const SAFE_MAX_RETRY_DELAY_MS = PI_DEFAULT_MAX_RETRY_DELAY_MS;

export interface RetryConfigVerdict {
  /** The effective ceiling, or undefined when the file says nothing (= default). */
  maxRetryDelayMs?: number;
  /** True when a normal provider backoff would be thrown away. */
  tooLow: boolean;
  /** Operator-facing, only when `tooLow`. */
  warning?: string;
}

/** Judge a settings object. Pure, so the threshold logic is directly testable. */
export function judgeRetryConfig(settings: unknown): RetryConfigVerdict {
  const value = (settings as { retry?: { provider?: { maxRetryDelayMs?: unknown } } })?.retry
    ?.provider?.maxRetryDelayMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return { tooLow: false };
  // 0 disables the ceiling entirely in Pi (`maxDelayMs > 0` guards the throw),
  // so it honours any delay — the opposite of the problem.
  if (value === 0 || value >= SAFE_MAX_RETRY_DELAY_MS) {
    return { maxRetryDelayMs: value, tooLow: false };
  }
  return {
    maxRetryDelayMs: value,
    tooLow: true,
    warning: [
      `pi-ensemble: retry.provider.maxRetryDelayMs is ${Math.round(value / 1000)}s in`,
      "~/.pi/agent/settings.json. Providers routinely ask for 59-60s on a 429, and a delay",
      "above this ceiling is discarded WITHOUT waiting — the retry budget is never used.",
      `Set it to ${SAFE_MAX_RETRY_DELAY_MS / 1000}s (Pi's default) or remove the key.`,
    ].join(" "),
  };
}

/** Read the operator's settings and judge them. Never throws. */
export async function checkRetryConfig(
  settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json"),
): Promise<RetryConfigVerdict> {
  try {
    return judgeRetryConfig(JSON.parse(await fs.readFile(settingsPath, "utf8")));
  } catch {
    // Absent or unparseable means Pi's default applies, which is safe.
    return { tooLow: false };
  }
}

/**
 * Warn once at startup if this host would discard provider backoffs.
 *
 * Traced rather than surfaced in the UI: it is a standing configuration note,
 * not an event, and `/ensemble-debug` is where an operator goes looking.
 */
export async function warnIfRetryConfigTooLow(): Promise<void> {
  const verdict = await checkRetryConfig();
  if (verdict.warning) trace(verdict.warning);
}
