#!/usr/bin/env bun
/**
 * #366 — 429 classification by the provider's own requested delay.
 *
 * Every message below is a VERBATIM string captured from this machine's
 * `.pi/work-state/*.json` event logs. Synthesising plausible-looking provider
 * text would test the regex against itself; these are what the provider
 * actually sent when cycles died.
 *
 * The failure being fixed: a per-minute token bucket and a 24-hour quota
 * exhaustion arrive as the same status code, differing only in a number the
 * driver never read. Both killed the cycle with "retrying cannot help" —
 * which for the 60s case is simply false, and cost issue #279's cycle $7.08
 * plus 11 unstarted downstream issues.
 */

import { isSpendCapMsg, parseRetryDelaySeconds } from "../src/types.ts";
import {
  burstThresholdSeconds,
  classifyFailureCause,
  failureCauseReason,
  jitteredMs,
} from "../src/work-driver-failure-taxonomy.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Verbatim from the state files (279.json, 304.json).
const BURST_60 =
  "Provider request error: Server requested 60s retry delay (max: 10s). 429 status code (no body)";
const QUOTA_86399 =
  "Provider request error: Server requested 86399s retry delay (max: 60s). 429 status code (no body)";
const QUOTA_86400 =
  "Provider request error: Server requested 86400s retry delay (max: 60s). 429 status code (no body)";
const BARE_429 = "429 status code (no body)";

// ------------------------------------------------------------- delay parse

assert(parseRetryDelaySeconds(BURST_60) === 60, "parses 60s from the observed burst message");
assert(
  parseRetryDelaySeconds(QUOTA_86399) === 86399,
  "parses 86399s — NOT the `max:` value, which is Pi's own ceiling, not the provider's ask",
);
assert(parseRetryDelaySeconds(BARE_429) === undefined, "no delay stated → undefined");
assert(parseRetryDelaySeconds(undefined) === undefined, "undefined message → undefined");

// --------------------------------------------------------- classification

const cls = (providerMessage: string) =>
  classifyFailureCause({ kind: "dispatch-failed-provider", providerMessage });

{
  const c = cls(BURST_60);
  assert(c.cause === "rate-limited:burst", "60s → rate-limited:burst");
  assert(c.shouldRetry === true, "burst is retryable — this is the whole point of #366");
  assert(c.waitMs === 60_000, "burst carries the provider's requested wait in ms");
}
{
  const c = cls(QUOTA_86399);
  assert(c.cause === "rate-limited:quota-window", "86399s → rate-limited:quota-window");
  assert(c.shouldRetry === false, "a quota window is not worth retrying in-cycle");
  assert(c.waitMs === 86_399_000, "quota window still reports when it clears");
}
{
  const c = cls(BARE_429);
  assert(
    c.cause === "rate-limited:429" && c.shouldRetry === false,
    "429 with no stated delay keeps the conservative pre-#366 halt (no guessing)",
  );
}
{
  const c = cls("429 status code — monthly spend cap reached for this organization");
  assert(
    c.cause === "rate-limited:quota-terminal" && c.shouldRetry === false,
    "spend-cap wording → quota-terminal; waiting genuinely cannot help",
  );
}

// The threshold is the boundary, so pin both sides of it exactly.
{
  const t = burstThresholdSeconds();
  const at = cls(`Server requested ${t}s retry delay. 429 status code`);
  const over = cls(`Server requested ${t + 1}s retry delay. 429 status code`);
  assert(at.cause === "rate-limited:burst", `exactly ${t}s is still a burst (inclusive bound)`);
  assert(over.cause === "rate-limited:quota-window", `${t + 1}s crosses into quota-window`);
}
{
  const prev = process.env.PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S;
  process.env.PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S = "10";
  try {
    assert(
      cls(BURST_60).cause === "rate-limited:quota-window",
      "PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S lowers the boundary",
    );
  } finally {
    if (prev === undefined) process.env.PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S = undefined;
    else process.env.PI_ENSEMBLE_RATE_LIMIT_BURST_MAX_S = prev;
  }
}

// Regression guard: the pre-#366 behaviour must be genuinely gone.
assert(
  !/retrying cannot help/.test(
    failureCauseReason({ kind: "dispatch-failed-provider", providerMessage: BURST_60 }),
  ),
  'a 60s burst no longer tells the operator "retrying cannot help" — it was false',
);
assert(
  /60s/.test(failureCauseReason({ kind: "dispatch-failed-provider", providerMessage: BURST_60 })),
  "the burst reason names the wait so the operator knows what is happening",
);
assert(
  /quota window/.test(
    failureCauseReason({ kind: "dispatch-failed-provider", providerMessage: QUOTA_86400 }),
  ),
  "the quota-window reason says so, instead of a generic failure",
);

// Non-429 causes must be untouched by all of this.
{
  const severed = classifyFailureCause({
    kind: "dispatch-failed-provider",
    providerMessage: "terminated",
  });
  assert(
    severed.cause === "provider-severed" && severed.shouldRetry === true,
    "transport severance still classifies as provider-severed (no regression)",
  );
  const killed = classifyFailureCause({ kind: "dispatch-failed", killCause: "timeout" });
  assert(
    killed.cause === "self-killed:timeout" && killed.shouldRetry === false,
    "a self-kill is still never a provider failure (checked before 429)",
  );
}

assert(!isSpendCapMsg(BURST_60), "a plain rate limit is not mistaken for a spend cap");

// -------------------------------------------------------------- jitter

{
  // Full jitter matters the moment parallel groups land: without it, N cycles
  // tripping the same limit compute the same backoff and retry in lockstep.
  const samples = new Set(Array.from({ length: 25 }, () => jitteredMs(5000)));
  assert(samples.size > 1, "jitteredMs is actually random — identical inputs differ");
  assert(
    Array.from(samples).every((v) => v >= 0 && v <= 5000),
    "jitter stays within [0, base]",
  );
}
{
  // A provider-requested delay is a FLOOR — waiting less earns the next 429.
  const withFloor = Array.from({ length: 25 }, () => jitteredMs(5000, 60_000));
  assert(
    withFloor.every((v) => v >= 60_000),
    "a requested delay is honoured as a floor, never undercut by jitter",
  );
  assert(new Set(withFloor).size > 1, "jitter is still applied on top of the floor");
}
{
  assert(jitteredMs(5000, 0, () => 0.5) === 2500, "jitter is deterministic under an injected rand");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
