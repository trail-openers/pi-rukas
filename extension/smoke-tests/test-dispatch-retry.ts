#!/usr/bin/env bun
/**
 * The tool dispatch path must honour a provider's backoff.
 *
 * The #366/#433 taxonomy knows a 429 stating 59 seconds is a burst worth
 * waiting out, and one stating 24 hours is a quota window that waiting cannot
 * fix. That knowledge was reachable only from the compiled /work driver.
 * `dispatch_specialist` and `dispatch_parallel` had no retry at all.
 *
 * Pi's own in-process retry is not a substitute: measured on the real
 * transcripts, it backs off 2s/4s/8s — 14.6 seconds of waiting against a server
 * asking for 59 — so all four attempts land inside the same rate-limit window.
 * Four children were throttled; three died having fetched ~305k characters
 * between them, and all of it was discarded.
 */

import { retryDecision, withProviderBackoff } from "../src/dispatch-retry.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const res = (over: Partial<DispatchResult>): DispatchResult =>
  ({
    role: "explore",
    ok: false,
    exitCode: 0,
    ms: 1000,
    text: "",
    toolUses: [],
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  }) as any as DispatchResult;

const BURST = res({
  errorStop: { reason: "error", message: "Server requested 59s retry delay (max: 10s). 429" },
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
} as any);
const QUOTA = res({
  errorStop: { reason: "error", message: "Server requested 86399s retry delay (max: 60s). 429" },
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
} as any);

// ------------------------------------------------------------ the decision

{
  const burst = retryDecision(BURST);
  assert(
    burst.retry,
    "canary: the real 59s 429 is retried — the tool path did nothing at all before",
  );
  assert(burst.waitMs === 59_000, `...after the delay the provider stated (${burst.waitMs}ms)`);
  assert(
    burst.cause === "rate-limited:burst",
    "...classified by the same taxonomy the driver uses",
  );

  const quota = retryDecision(QUOTA);
  assert(!quota.retry, "a ~24h quota window is NOT retried — waiting cannot clear it");

  assert(!retryDecision(res({ ok: true, text: "done" })).retry, "a success is not retried");
  assert(
    !retryDecision(res({ killCause: "timeout" })).retry,
    "a self-kill is not blamed on the provider, and not retried",
  );
  assert(!retryDecision(res({ killCause: "abort" })).retry, "a cancelled dispatch is not retried");
}

// -------------------------------------------------------- the retry loop

{
  const waits: number[] = [];
  const notices: number[] = [];
  let attempts = 0;
  const result = await withProviderBackoff(
    async () => {
      attempts++;
      return attempts < 3 ? BURST : res({ ok: true, text: "gathered 136k chars" });
    },
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
      onRetry: (n) => notices.push(n.attempt),
      rand: () => 0.5,
    },
  );

  assert(attempts === 3, `it retried until it succeeded (${attempts} attempts)`);
  assert(result.ok, "and returns the successful result — the work is not discarded");
  assert(waits.length === 2, "it waited between attempts");
  assert(
    waits.every((w) => w > 8_000),
    `each wait exceeds Pi's own 8s backoff ceiling (${waits.join(", ")}ms) — that is the whole point`,
  );
  assert(
    notices.length === 2,
    "each wait is announced, so a paused child does not read as a stall",
  );
}

{
  // Exhaustion returns the REAL failure, never a synthesised one.
  let attempts = 0;
  const result = await withProviderBackoff(
    async () => {
      attempts++;
      return BURST;
    },
    { sleep: async () => {}, maxAttempts: 3 },
  );
  assert(attempts === 3, "attempts are bounded");
  assert(
    result.errorStop?.message?.includes("429") === true,
    "the last real error survives, so the report can still name the cause",
  );
}

{
  // A quota window must not burn attempts it cannot use.
  let attempts = 0;
  await withProviderBackoff(
    async () => {
      attempts++;
      return QUOTA;
    },
    { sleep: async () => {}, maxAttempts: 3 },
  );
  assert(attempts === 1, "a quota window is attempted exactly once");
}

{
  // Abort wins over any pending backoff.
  const ac = new AbortController();
  let attempts = 0;
  await withProviderBackoff(
    async () => {
      attempts++;
      ac.abort();
      return BURST;
    },
    { signal: ac.signal, sleep: async () => {}, maxAttempts: 5 },
  );
  assert(attempts === 1, "an aborted dispatch stops immediately, mid-backoff");
}

{
  // Jitter spreads N children so they do not re-arrive in unison. Same input,
  // different randomness → different waits.
  const seen = new Set<number>();
  for (const r of [0.01, 0.5, 0.99]) {
    await withProviderBackoff(async () => BURST, {
      sleep: async (ms) => {
        seen.add(ms);
      },
      maxAttempts: 2,
      rand: () => r,
    });
  }
  assert(seen.size > 1, `jitter varies the wait across children (${[...seen].join(", ")}ms)`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
