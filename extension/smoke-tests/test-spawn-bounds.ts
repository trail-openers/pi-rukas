#!/usr/bin/env bun
/**
 * A child's life is bounded by liveness, and the cap bounds pids — not tokens.
 *
 * Two defects, one theme: both invented a number to stand in for information
 * we did not have.
 *
 * 1. **Six per-role wall-clock caps.** They were raised twice — #296 (lens and
 *    ops sat below a single xhigh-thinking turn) and #553 (a developer was 43
 *    min into substantive work when the 30-min cap SIGTERM'd it) — and both
 *    times the finding was identical: the number was too small for a HEALTHY
 *    child. Provider speed varies by an order of magnitude, so no wall-clock
 *    number means the same thing on two models. The table had already drifted
 *    out of sync with its own documentation (troubleshooting.md claimed 15 min
 *    for lenses the code set to 45). Replaced by ONE runaway backstop, with
 *    `inactivityTimeoutMs` — silence, not slowness — as the real detector.
 *
 * 2. **A global spawn cap of 12.** Its own docstring conceded that "a single
 *    M=6 develop step needs 6 (or 12 with speculative explores)" — so one
 *    cycle consumed the entire global cap and a second concurrent cycle got
 *    ZERO slots, queueing FIFO behind it. That queueing was measured across 69
 *    terminal cycles as "roles run ~2.4x slower under concurrency" and read as
 *    provider contention. It was this semaphore. Provider capacity is rationed
 *    by the provider (429 + `retry-after`, which `retry-config-check` verifies
 *    the host honours); this cap only ever bounded local pids.
 *
 * The compensation is gone too: `develop` used to switch speculative explore
 * OFF whenever groups ran concurrently, degrading a cycle's context to fit
 * under a cap we chose.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnCap } from "../src/spawn-semaphore.ts";
import { SPAWN_BACKSTOP_MS, inactivityTimeoutMs, spawnBackstopMs } from "../src/spawn-support.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");
/** Source with comments stripped — asserting on prose proves nothing. */
const code = (f: string) =>
  read(f)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ---------------------------------------- one backstop, no role dimension

{
  const support = code("spawn-support.ts");
  assert(
    !/ROLE_TIMEOUT_DEFAULTS_MS/.test(support),
    "canary: the per-role timeout table is gone — six numbers, each raised twice for healthy children",
  );
  assert(
    !/PI_ENSEMBLE_SPAWN_TIMEOUT_MS_/.test(support),
    "canary: the per-role env override chain is gone — one knob, one meaning",
  );
  assert(
    typeof spawnBackstopMs === "function" && !/function roleTimeoutMs/.test(support),
    "canary: roleTimeoutMs is replaced by spawnBackstopMs — the role argument was unused once the table went",
  );

  // The backstop must stay clear of #553's measured 43-minute LEGITIMATE
  // developer run. A backstop tuned near real work is just the old defect.
  const MEASURED_LEGITIMATE_MS = 43 * 60_000;
  assert(
    SPAWN_BACKSTOP_MS > MEASURED_LEGITIMATE_MS * 2,
    `canary: the backstop (${SPAWN_BACKSTOP_MS / 60_000}m) is far above #553's measured 43m of real work — it guards runaways, not budgets`,
  );
  // ...and above every value the old table held, so nothing regresses.
  assert(
    SPAWN_BACKSTOP_MS >= 90 * 60_000,
    "canary: no role got a SHORTER budget than it had (the old maximum was developer at 90m)",
  );
}

{
  assert(
    withEnv({ PI_ENSEMBLE_SPAWN_TIMEOUT_MS: undefined }, () => spawnBackstopMs()) ===
      SPAWN_BACKSTOP_MS,
    "with no env set, the backstop is the default",
  );
  assert(
    withEnv({ PI_ENSEMBLE_SPAWN_TIMEOUT_MS: "2000" }, () => spawnBackstopMs()) === 2000,
    "the operator/CI override still wins — smoke tests rely on short timeouts",
  );
  assert(
    withEnv({ PI_ENSEMBLE_SPAWN_TIMEOUT_MS: "junk" }, () => spawnBackstopMs()) ===
      SPAWN_BACKSTOP_MS,
    "a garbage value falls back to the default rather than to NaN",
  );
}

{
  // Liveness is deliberately UNCHANGED and remains the primary detector. If a
  // future edit weakens it, the backstop is all that is left and we are back
  // to measuring the wrong thing.
  assert(
    withEnv({ PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS: undefined }, () => inactivityTimeoutMs()) ===
      25 * 60_000,
    "the inactivity watchdog stays at 25 min of zero stdout — the model-independent signal",
  );
  assert(
    inactivityTimeoutMs() < SPAWN_BACKSTOP_MS,
    "canary: liveness fires well before the backstop — otherwise the backstop is the de-facto detector",
  );
}

// ------------------------------------- the cap bounds pids, not providers

{
  // The peak fanout of one cycle is `develop` at 2 children per workstream,
  // against #290's MAX_WORKSTREAMS ceiling. A cap at or below that serialises
  // a step against itself, which is exactly what 12 did at M=6.
  const PEAK_SINGLE_CYCLE_FANOUT = 2 * 10;
  assert(
    spawnCap() > PEAK_SINGLE_CYCLE_FANOUT,
    `canary: the cap (${spawnCap()}) exceeds one cycle's peak fanout (${PEAK_SINGLE_CYCLE_FANOUT}) — at 12 a single M=6 develop step consumed it entirely`,
  );
  assert(
    withEnv({ PI_ENSEMBLE_SPAWN_CAP: "0" }, () => spawnCap()) === 0,
    "PI_ENSEMBLE_SPAWN_CAP=0 still disables the semaphore entirely",
  );
  assert(
    withEnv({ PI_ENSEMBLE_SPAWN_CAP: "4" }, () => spawnCap()) === 4,
    "an operator who wants a tighter local bound still gets one",
  );
}

{
  // Provider backpressure must stay the provider's job. If this check ever
  // disappears, a low `maxRetryDelayMs` silently discards `retry-after` and
  // the semaphore becomes the only throttle again — by accident.
  const index = code("index.ts");
  assert(
    /retry-config-check|judgeRetryConfig|checkRetryConfig/.test(index),
    "the startup retry-config check is still wired — it is what makes 'let the provider throttle us' true",
  );
}

// ------------------------- develop no longer degrades itself to save slots

{
  const develop = code("work-driver-branch-develop.ts");
  assert(
    !/parallelCycles[^\n]*<=\s*1/.test(develop),
    "canary: speculative explore no longer switches off under concurrency — that compensated for the old cap",
  );
  assert(
    /PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE/.test(develop),
    "...while the explicit opt-out remains for an operator who wants it",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
