#!/usr/bin/env bun
/**
 * Does this host honour a provider's backoff?
 *
 * The harness's whole recovery story assumes it does — the fault taxonomy reads
 * `retry-after` and waits it out, and the step router retries on that basis.
 * All of it is downstream of one number in the operator's personal
 * `~/.pi/agent/settings.json`, which pi-ensemble neither sets nor can see.
 *
 * Measured on a real run: at `maxRetryDelayMs: 10000`, three parallel research
 * children and two `/work` developers were all killed by
 * `Server requested 59s retry delay (max: 10s). 429 status code (no body)` —
 * having gathered ~305k characters of research between them, which was
 * discarded and re-fetched.
 *
 * The arithmetic that matters, from pi-ai's `validateServerRetryDelayMs`:
 *
 *     if (maxDelayMs > 0 && delayMs > maxDelayMs) throw
 *
 * At Pi's default of 60_000, a 59s hint gives `59000 > 60000` = false → sleep
 * and recover. At 10_000, `59000 > 10000` = true → throw, with **no wait at
 * all**: the throw happens while computing the next delay, before any sleep,
 * so the `maxRetries` budget is never even consumed.
 */

import {
  PI_DEFAULT_MAX_RETRY_DELAY_MS,
  SAFE_MAX_RETRY_DELAY_MS,
  checkRetryConfig,
  judgeRetryConfig,
} from "../src/retry-config-check.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const settings = (ms: unknown) => ({ retry: { provider: { maxRetryDelayMs: ms } } });

// --------------------------------------- the exact configuration that broke

{
  const v = judgeRetryConfig(settings(10_000));
  assert(v.tooLow, "10s — the value that killed five dispatches — is flagged");
  assert(v.maxRetryDelayMs === 10_000, "...and the offending value is reported back");
  assert(
    /59-60s/.test(v.warning ?? ""),
    "...the warning names the delay providers actually ask for",
  );
  assert(
    /WITHOUT waiting/.test(v.warning ?? ""),
    "...and says plainly that nothing waits — not 'waits 10s then gives up'",
  );
  assert(
    /settings\.json/.test(v.warning ?? "") && /60s/.test(v.warning ?? ""),
    "...and names the file to edit and the value to use",
  );
}

// ------------------------------------------------ the guard's own arithmetic

{
  // Reproduces pi-ai's `validateServerRetryDelayMs` so the threshold is chosen
  // against the real predicate rather than a remembered one.
  const wouldThrow = (delayMs: number, maxDelayMs: number) => maxDelayMs > 0 && delayMs > maxDelayMs;

  assert(wouldThrow(59_000, 10_000), "canary: at 10s, a 59s hint throws");
  assert(!wouldThrow(59_000, 60_000), "at 60s it does NOT — the request is retried");
  assert(!wouldThrow(60_000, 60_000), "a 60s hint at 60s is also fine (strictly greater)");
  assert(
    !wouldThrow(600_000, 0),
    "0 disables the ceiling entirely — any delay is honoured",
  );

  // Pi's own backoff never reaches 10s, so the ceiling only ever discards a
  // provider instruction. This is why raising it has no downside.
  const piBackoff = (i: number) => Math.min(0.5 * 2 ** i, 8) * 1000;
  assert(
    [0, 1, 2, 3, 4, 5, 10].every((i) => piBackoff(i) <= 8_000),
    "Pi's own exponential backoff caps at 8s, always under a 10s ceiling",
  );
  assert(
    [0, 1, 2, 3, 4, 5, 10].every((i) => !wouldThrow(piBackoff(i), 10_000)),
    "...so the ceiling never constrains Pi's own retries — only the provider's hint",
  );
}

// ------------------------------------------------------- accepted settings

{
  assert(!judgeRetryConfig(settings(60_000)).tooLow, "60s (Pi's default) passes");
  assert(!judgeRetryConfig(settings(120_000)).tooLow, "higher than the default passes");
  assert(!judgeRetryConfig(settings(0)).tooLow, "0 passes — it disables the ceiling");
  assert(
    judgeRetryConfig(settings(59_999)).tooLow,
    "just under the default is flagged — a 60s hint would still be discarded",
  );
}

// ------------------------------------------- silence when there is nothing to say

{
  for (const [name, input] of [
    ["no retry block", { theme: "dark" }],
    ["no provider block", { retry: {} }],
    ["no key", { retry: { provider: {} } }],
    ["not a number", settings("10000")],
    ["null", null],
    ["a string", "nonsense"],
  ] as const) {
    const v = judgeRetryConfig(input);
    assert(!v.tooLow && v.warning === undefined, `silent: ${name} (Pi's default applies)`);
  }
}

// ------------------------------------------------------------- reading the file

{
  const missing = await checkRetryConfig("/nonexistent/path/settings.json");
  assert(!missing.tooLow, "an absent settings file is not a warning — the default applies");

  // The operator's real file, which this work just corrected. Not asserted as
  // a fixed value: it is theirs to change. Reported so a regression is visible.
  const live = await checkRetryConfig();
  console.log(
    `  … this host: maxRetryDelayMs=${live.maxRetryDelayMs ?? "(unset → default)"}${
      live.tooLow ? "  ⚠ TOO LOW" : ""
    }`,
  );
  assert(
    SAFE_MAX_RETRY_DELAY_MS === PI_DEFAULT_MAX_RETRY_DELAY_MS,
    "the threshold is Pi's own default, not a number we invented",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
