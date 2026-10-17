/**
 * Env hygiene for the offline smoke tests. Two files under smoke-tests/ carried
 * byte-identical copies of this helper; both now import it, so a block that
 * forgets to restore one variable cannot diverge from its sibling.
 *
 * Driver gates read their switches off `process.env` at call time
 * (`PI_ENSEMBLE_VERIFY`, `PI_ENSEMBLE_PROTECTED_PATHS`, …), so a test that
 * pins one leaks the pin into every later test file in the same `bun test`
 * run — and, in the per-file verify-loop runner, into whatever the next
 * invocation inherits. `withEnv` pins for the duration of the body and puts
 * back EXACTLY what was there, including an absent variable (which is deleted
 * again, not set to the empty string).
 */

type Env = Record<string, string | undefined>;

/** Run `body` with `overrides` applied to `process.env`, restoring on the way out. */
export async function withEnv(
  overrides: Record<string, string | undefined>,
  body: () => Promise<void>,
  env: Env = process.env as Env,
): Promise<void> {
  const saved: Env = {};
  for (const k of Object.keys(overrides)) saved[k] = env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  try {
    await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
}
