/**
 * test-child-codemode-workers — a codemode child's env carries Pi's worker cap
 * (`PI_CODEMODE_MAX_WORKERS`), read through the real `buildChildEnv` the spawn
 * calls: the default, the operator override (which beats an inherited value),
 * the fallback for a value Pi itself would reject, and no stamp at all when
 * codemode is off.
 */

import assert from "node:assert";
import { buildChildEnv } from "../src/spawn-child-env.ts";

const plan = {
  forge: { socketPath: undefined, configDir: undefined, secret: undefined },
  ready: Promise.resolve(),
} as never;

function workers(env: Record<string, string | undefined>): string | undefined {
  const saved = { ...process.env };
  for (const k of [
    "PI_ENSEMBLE_CHILD_CODEMODE",
    "PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS",
    "PI_CODEMODE_MAX_WORKERS",
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  try {
    return buildChildEnv("developer", plan).PI_CODEMODE_MAX_WORKERS;
  } finally {
    process.env = saved;
  }
}

assert.equal(workers({}), "4", "default cap is stamped");
assert.equal(workers({ PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS: "8" }), "8", "the knob sets it");
assert.equal(
  workers({ PI_CODEMODE_MAX_WORKERS: "1", PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS: "6" }),
  "6",
  "the knob beats an inherited Pi value",
);
for (const bad of ["0", "-2", "2.5", "x", ""]) {
  assert.equal(
    workers({ PI_ENSEMBLE_CHILD_CODEMODE_MAX_WORKERS: bad }),
    "4",
    `${JSON.stringify(bad)} keeps the default`,
  );
}
assert.equal(
  workers({ PI_ENSEMBLE_CHILD_CODEMODE: "0" }),
  undefined,
  "codemode off: no stamp, the env is unchanged",
);
console.log("✓ child codemode worker cap");
