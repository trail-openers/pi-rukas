#!/usr/bin/env bun
/**
 * #502 — refreshIfChanged() must not miss a rewrite that lands within one
 * mtime tick at identical byte size.
 *
 * model-config's freshness guard (stat mtime + size) exists per #300 so a
 * config edit in one session reaches the other live sessions. But the guard
 * treats "same mtime AND same size" as "unchanged" — true on a filesystem
 * whose timestamps are coarse (CI's ext4), wrong in general. A config
 * edit that collides in both dimensions is silently invisible, so the
 * edit never takes effect.
 *
 * Determinism: we pin the file's mtime with utimesSync BEFORE each write
 * and pin it back AFTER, so both versions share the exact same
 * `mtimeMs` and byte size on EVERY filesystem, including APFS with
 * nanosecond timestamps. The test does not depend on timing or on which
 * fs the host happens to run on.
 *
 * Proven in both directions (see test-file-size-limit.ts:14-21 — "a gate
 * never observed to fail is worthless"):
 *   1. Pre-fix: this test fails on the shipped guard
 *      (`diskStamp.mtimeMs === stat.mtimeMs && diskStamp.size === stat.size`).
 *   2. Post-fix: it passes. If the guard ever regresses to a
 *      stat-only comparison, the assertion below catches it.
 */
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "pi-ensemble-model-config-same-tick-"));
const file = path.join(dir, "ensemble-models.json");
process.env.PI_ENSEMBLE_MODELS_CONFIG = file;

const mc = await import("../src/model-config.ts");
const { resolveModel } = await import("../src/models.ts");

try {
  await mc.loadOverrides();
  await mc.clearAllOverrides();

  // v1 — establish the cache and pin its mtime.
  writeFileSync(file, JSON.stringify({ models: { __all__: { model: "vendor/model-v1" } } }));
  // utimesSync only preserves mtime at millisecond precision. The pin is
  // the value `refreshIfChanged` (which reads `statSync().mtimeMs`) would
  // see, so truncate the fractional ms before pinning.
  const pin = Math.floor(statSync(file).mtimeMs);
  utimesSync(file, new Date(pin), new Date(pin));
  const before = resolveModel("developer");
  assert(
    before.model === "vendor/model-v1" && before.source === "config-default",
    "v1 loads and resolves (cache primed)",
  );

  // v2 — identical size, identical mtime. The rewrite must still be seen.
  writeFileSync(file, JSON.stringify({ models: { __all__: { model: "vendor/model-v2" } } }));
  utimesSync(file, new Date(pin), new Date(pin));

  const s = statSync(file);
  // Sanity: the test actually constructed the collision. We assert on the
  // same mtimeMs (not raw mtime) because `refreshIfChanged` — and
  // Node's `fs.statSync().mtimeMs` — read it in ms, so that's the
  // granularity the guard saw.
  assert(s.size === 50, "v2 has identical byte size to v1");
  assert(
    s.mtimeMs === pin,
    "v2 has the same stat mtimeMs as the pinned v1 (collision constructed)",
  );

  const after = resolveModel("developer");
  assert(
    after.model === "vendor/model-v2" && after.source === "config-default",
    "same-tick same-size rewrite IS observed by refreshIfChanged (#502)",
  );

  // And in the other direction — a third rewrite, again same size/mtime,
  // must still be observed. Rules out "the fix works once and then
  // re-stamps to a collision".
  writeFileSync(file, JSON.stringify({ models: { __all__: { model: "vendor/model-v3" } } }));
  utimesSync(file, new Date(pin), new Date(pin));
  const third = resolveModel("developer");
  assert(
    third.model === "vendor/model-v3",
    "a second same-tick same-size rewrite is also observed",
  );
} finally {
  await mc.clearAllOverrides().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
