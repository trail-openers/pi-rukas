/**
 * lib/verify-tier-pin — the LIVE-table reader for the #1509 per-tier verify
 * bounds, extracted from `test-headless-inputs.ts`.
 *
 * `test-headless-inputs.ts` asserts each `HEADLESS_INPUTS` default equals what
 * the live reader returns with the environment cleared. For the three tier
 * knobs that reader has to be built, not read: the resolvers are per-tier and
 * async, and they read a `.pi/*-timeout-ms` file, which is exactly the thing
 * the default comparison must exclude.
 *
 * The construction is the load-bearing part, so it lives where it can be read
 * on its own. A `tierDefaultReader` that read the AMBIENT environment would
 * make the assertion a tautology on any host that exports a verify knob — it
 * would compare the operator's setting against itself and pass while the
 * documented default drifted. So it deletes all four verify knobs and passes a
 * repoRoot that cannot exist: what survives is the resolver's own fallback,
 * which is the number `HEADLESS_INPUTS` claims.
 */

import {
  fastTierTimeoutMs,
  smokeTierTimeoutMs,
  suiteTierTimeoutMs,
} from "../../src/work-driver-verify-budget.ts";

/** Every knob that could answer for a verify bound, tier-specific or shared. */
const VERIFY_KNOBS = [
  "PI_ENSEMBLE_VERIFY_TIMEOUT_MS",
  "PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS",
  "PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS",
  "PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS",
];

/** A repoRoot with no `.pi/` under it — the resolver treats an unreadable file
 *  as absent, which is the "project declared nothing" case being tested. */
const NO_PROJECT_ROOT = "/nonexistent-pi-rukas-tier-default";

/**
 * A reader yielding a tier's DOCUMENTED default, with neither the environment
 * nor a project file able to answer. Returns a promise (the resolvers are
 * async because level 2 is a file read); the LIVE loop awaits each entry, so
 * the file's sync readers are unaffected.
 */
export function tierDefaultReader(tier: "fast" | "suite" | "smoke"): () => unknown {
  return () => {
    const saved = VERIFY_KNOBS.map((k) => [k, process.env[k]] as const);
    for (const k of VERIFY_KNOBS) delete process.env[k];
    try {
      return tier === "fast"
        ? fastTierTimeoutMs(NO_PROJECT_ROOT)
        : tier === "smoke"
          ? smokeTierTimeoutMs(NO_PROJECT_ROOT)
          : suiteTierTimeoutMs(NO_PROJECT_ROOT);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}
