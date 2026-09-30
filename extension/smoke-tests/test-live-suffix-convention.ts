#!/usr/bin/env bun
/**
 * #944 — canary for the `*-live.ts` naming convention.
 *
 * The offline gate (smoke-tests/lib/verify-loop.sh, mirrored in CI and in
 * AGENTS.md §1) skips every `smoke-tests/*-live.ts` file: the suffix is the
 * convention that says "this test spawns a real Pi child and costs real
 * tokens, so it must stay out of the offline run". The skip is name-based
 * and silent — an OFFLINE test that happens to end in `-live.ts` is
 * excluded with no warning. That is exactly how
 * test-dispatch-deck-live.ts (an offline test of the live view that
 * spawns nothing) went unrun by the gate and CI for its whole life, and
 * how a syntax error in it went unnoticed until it was renamed
 * (test-dispatch-deck-liveview.ts, #944).
 *
 * This test closes the hole by asserting, for every `*-live.ts` file, that
 * it actually contains a real-spawn marker — a call to one of the spawn
 * seams the genuine live tests use (`spawnSpecialist(`, `runLensReview(`,
 * `runAdversarialLoop(`, `dispatchCore(`, `startWorkDriver(` /
 * `runWorkDriver(`, or a raw `spawn(` / `spawnSync(` / `execSync(`).
 * A `-live.ts` file with no marker fails the offline gate with a message
 * telling the author to rename it — because as named it would be silently
 * excluded.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SMOKE_DIR = path.resolve(import.meta.dirname);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Real-spawn markers: a call to any of these means the file can spawn a
// real Pi child (or shell out against real repo state) and is therefore a
// legitimate member of the `*-live.ts` exclusion. The list mirrors the
// seams the current genuine live tests actually use (spawnSpecialist,
// spawn, runLensReview, dispatchCore, execSync) plus the driver /
// adversarial seams, so a future genuine live test using any of them
// passes without editing this canary.
const LIVE_MARKERS = [
  "spawnSpecialist(",
  "runLensReview(",
  "runAdversarialLoop(",
  "dispatchCore(",
  "startWorkDriver(",
  "runWorkDriver(",
  "spawn(",
  "spawnSync(",
  "execSync(",
];

// Secondary markers: these names appear only in the lib helpers that
// actually wrap the real-spawn seam (runAbortProbe / runTimeoutProbe in
// lib/test-cancel-probes.ts call spawnSpecialist). A -live.ts file that
// imports and calls one of them is still genuinely live — it just
// delegates the spawn to the helper.
const LIVE_HELPER_MARKERS = ["runAbortProbe(", "runTimeoutProbe("];

function hasLiveSpawnMarker(src: string): boolean {
  return (
    LIVE_MARKERS.some((m) => src.includes(m)) ||
    LIVE_HELPER_MARKERS.some((m) => src.includes(m))
  );
}

// ---------------------------------------------------------------------------
// 1. Negative self-check of the predicate: a synthetic source without any
//    marker must be rejected, one with a marker must be accepted. Without
//    this the predicate could silently match everything (or nothing) —
//    e.g. via a regex/anchor slip — and the test would pass either way.
// ---------------------------------------------------------------------------
{
  const noMarker = "function f() { return 1 + 2; }\nconsole.log('offline only');\n";
  assert(!hasLiveSpawnMarker(noMarker), "1a: predicate rejects a source with no spawn marker");
  const withMarker = "import { spawnSpecialist } from \"../src/spawn.ts\";\nconst r = await spawnSpecialist(spec);\n";
  assert(hasLiveSpawnMarker(withMarker), "1b: predicate accepts a source with a spawn marker");
}

// ---------------------------------------------------------------------------
// 2. Every existing `*-live.ts` file carries at least one real-spawn
//    marker. A failure here means an OFFLINE test is masquerading under
//    the live suffix and is therefore silently excluded from the offline
//    gate — rename it (drop the `-live` suffix) so it runs in the gate.
// ---------------------------------------------------------------------------
{
  const liveFiles = readdirSync(SMOKE_DIR)
    .filter((f) => f.endsWith("-live.ts"))
    .sort();
  assert(liveFiles.length > 0, `2a: found ${liveFiles.length} -live.ts files (sanity: not zero)`);
  let offenders: string[] = [];
  for (const name of liveFiles) {
    const src = readFileSync(path.join(SMOKE_DIR, name), "utf8");
    if (!hasLiveSpawnMarker(src)) {
      offenders.push(name);
    } else {
      console.log(`  · ${name} — has real-spawn marker (ok)`);
    }
  }
  assert(
    offenders.length === 0,
    offenders.length === 0
      ? "2b: every -live.ts file has a real-spawn marker"
      : `2b: OFFLINE file(s) named *-live.ts would be silently excluded from the offline gate by verify-loop.sh: ${offenders.join(", ")}. They spawn nothing — rename them without the -live suffix so they run in the gate.`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
