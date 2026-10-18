/**
 * #1509 + #1041 — the develop verify wall clock is resolved PER TIER, and a
 * project can declare its own budget in `.pi/`.
 *
 * The bug this pins: one number bounded four gates of wildly different scale.
 * `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` (10 min) governed the 400 ms lint run, the
 * whole offline suite, the product-smoke path, the skip-ratchet's `git diff`,
 * the comment-retention check and the cap-kill checkpoint's typecheck — and
 * `.pi/verify-cmd-fast` made the two verify tiers share it, the full run
 * getting only what the fast run left. Measured on this repo's ~641-file
 * suite: 4m49s at 4 jobs on a quiet host, past 10 minutes under a parallel
 * fan-out — so a cycle with nothing wrong parked at `verify-failed:develop`
 * with evidence that blamed the diff.
 *
 * RED/GREEN discipline (each assertion is a behaviour the old code got wrong):
 *
 *  RED  — the suite tier resolves to the shared 10-minute number.      before: 600000
 *  GREEN — with no knob and no project file it resolves to 30 minutes.  after: 1800000
 *  RED  — a project that ships `.pi/verify-timeout-ms` is ignored.     before: unread
 *  GREEN — that file's number is the bound.                            after: honoured
 *  RED  — the fast tier's elapsed time was subtracted from the full run,
 *         clamping it toward 1 ms when the shared budget was exhausted.
 *  GREEN — each tier carries its own bound; nothing subtracts.
 *
 * Run: bun smoke-tests/test-verify-tier-timeouts.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TIER_KNOB,
  TIER_TIMEOUT_FILE,
  developTierTimeoutMs,
  fastTierTimeoutMs,
  smokeTierTimeoutMs,
  suiteTierTimeoutMs,
  tierDefaultMs,
  verifyTimeoutMs,
} from "../src/work-driver-verify-budget.ts";
import { readFirstConfigLine } from "../src/work-driver-verify-cmd.ts";
import { boundText } from "../src/work-driver-verify-develop-helpers.ts";
import { withFastTier } from "../src/work-driver-verify-fast.ts";

const KNOBS = [
  "PI_ENSEMBLE_VERIFY_TIMEOUT_MS",
  "PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS",
  "PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS",
  "PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS",
];

const saved = KNOBS.map((k) => [k, process.env[k]] as const);
function clearKnobs(): void {
  for (const k of KNOBS) delete process.env[k];
}
function restoreKnobs(): void {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A repo root with a `.pi/` directory, for the project-file precedence tests. */
async function scratchRepo(): Promise<{
  root: string;
  write: (f: string, c: string) => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-verify-budget-"));
  await mkdir(path.join(root, ".pi"), { recursive: true });
  return {
    root,
    write: async (file, content) => {
      await writeFile(path.join(root, ".pi", file), content, "utf-8");
    },
  };
}

const results: string[] = [];
function ok(name: string): void {
  results.push(`PASS ${name}`);
}

// ── 1. Each tier has its OWN default, and the suite tier is the wide one.
// RED before #1509: every one of these resolved to 600000, because there was
// one number and it was the 10-minute one.
clearKnobs();
{
  const root = (await scratchRepo()).root;
  assert.equal(
    await suiteTierTimeoutMs(root),
    1_800_000,
    "#1509 the suite tier's default is 30 min, not the shared 10 min",
  );
  assert.equal(await fastTierTimeoutMs(root), 600_000, "fast tier default is 10 min");
  assert.equal(await smokeTierTimeoutMs(root), 600_000, "smoke tier default is 10 min");
  assert.equal(
    await verifyTimeoutMs(),
    600_000,
    "the shared fallback knob is unchanged at 10 min — non-tier call sites keep their bound",
  );
  assert.equal(tierDefaultMs("suite"), 1_800_000, "tierDefaultMs agrees with the resolver");
  assert.equal(tierDefaultMs("fast"), 600_000, "tierDefaultMs agrees for fast");
  assert.equal(tierDefaultMs("smoke"), 600_000, "tierDefaultMs agrees for smoke");
  ok("per-tier defaults are independent (#1509 RED→GREEN)");
  await rm(root, { recursive: true, force: true });
}

// ── 2. Widening the suite tier does NOT widen anything else. This is the
// safety property the issue names outright: "widening the offline-suite bound
// must not widen the smoke gate's bound, the skip-ratchet's git bound, or the
// comment-retention check's bound."
clearKnobs();
{
  const root = (await scratchRepo()).root;
  process.env.PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS = "3600000";
  assert.equal(await suiteTierTimeoutMs(root), 3_600_000, "suite tier honours its own knob");
  assert.equal(await fastTierTimeoutMs(root), 600_000, "a wide suite bound does not widen fast");
  assert.equal(await smokeTierTimeoutMs(root), 600_000, "a wide suite bound does not widen smoke");
  assert.equal(
    await verifyTimeoutMs(),
    600_000,
    "a wide suite bound does not widen the shared/non-tier bound",
  );
  ok("a wide suite bound does not propagate to other tiers (#1509)");
  await rm(root, { recursive: true, force: true });
}

// ── 3. Precedence: tier knob → shared knob → .pi file → documented default.
clearKnobs();
{
  const { root, write } = await scratchRepo();
  await write(TIER_TIMEOUT_FILE.suite, "# comment\n1234567\n");
  assert.equal(await suiteTierTimeoutMs(root), 1_234_567, ".pi/verify-timeout-ms answers");
  process.env.PI_ENSEMBLE_VERIFY_TIMEOUT_MS = "999000";
  assert.equal(
    await suiteTierTimeoutMs(root),
    999_000,
    "the shared env knob wins over the project file",
  );
  process.env.PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS = "222000";
  assert.equal(
    await suiteTierTimeoutMs(root),
    222_000,
    "the tier's own env knob wins over the shared one",
  );
  ok("precedence is tier knob → shared knob → .pi file (#1041)");
  await rm(root, { recursive: true, force: true });
}

// ── 4. Each tier reads its OWN file; they do not bleed.
clearKnobs();
{
  const { root, write } = await scratchRepo();
  await write(TIER_TIMEOUT_FILE.fast, "61000\n");
  await write(TIER_TIMEOUT_FILE.smoke, "62000\n");
  assert.equal(await fastTierTimeoutMs(root), 61_000, "fast tier reads its own file");
  assert.equal(await smokeTierTimeoutMs(root), 62_000, "smoke tier reads its own file");
  assert.equal(
    await suiteTierTimeoutMs(root),
    1_800_000,
    "a fast/smoke file never answers for the suite tier",
  );
  ok("tier files are per tier, never shared (#1509/#1041)");
  await rm(root, { recursive: true, force: true });
}

// ── 5. A garbage budget is refused, and `0` in particular never reaches exec.
// The executor reads a zero timeout as "no bound at all", so a file holding `0`
// would silently unbound the gate — the one failure mode a bound exists to
// prevent.
clearKnobs();
{
  for (const garbage of ["0", "-5", "abc", "", "  ", "12x"]) {
    const { root, write } = await scratchRepo();
    await write(TIER_TIMEOUT_FILE.suite, `${garbage}\n`);
    assert.equal(
      await suiteTierTimeoutMs(root),
      1_800_000,
      `a suite file holding ${JSON.stringify(garbage)} is ignored, not taken as a bound`,
    );
    await rm(root, { recursive: true, force: true });
  }
  // An env knob holds the same value: the fallback chain must still answer.
  process.env.PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS = "0";
  const { root, write } = await scratchRepo();
  await write(TIER_TIMEOUT_FILE.suite, "45000\n");
  assert.equal(
    await suiteTierTimeoutMs(root),
    45_000,
    "an unsettable env value (0) falls through to the project file",
  );
  ok("a non-positive or unparseable budget never reaches exec (#1509)");
  await rm(root, { recursive: true, force: true });
}

// ── 6. A missing or unreadable file is "absent", not a failure.
clearKnobs();
{
  assert.equal(
    await suiteTierTimeoutMs("/nonexistent/pi-rukas-repo"),
    1_800_000,
    "an unreadable repoRoot falls back to the default rather than throwing",
  );
  ok("a missing project budget is absent, not an error (#1041)");
}

// ── 7. The fast tier no longer eats the full run's budget.
// RED before #1509: `withFastTier` derived the full run's timeout as
// `Math.max(1, bound - fastElapsed)` from ONE bound, so an exhausted shared
// budget clamped the full run to 1 ms and it "timed out" instantly. GREEN: each
// run gets its own bound and the full run's is the caller's, untouched.
clearKnobs();
{
  const calls: Array<number | undefined> = [];
  const exec = async (_cmd: string, opts?: { timeout?: number }) => {
    calls.push(opts?.timeout);
    return { stdout: "", stderr: "" };
  };
  await withFastTier(exec, "full cmd", "fast cmd", { fast: 60_000 })("full cmd", {
    timeout: 1_800_000,
  });
  assert.deepEqual(calls, [60_000, 1_800_000], "fast got its bound, full kept ITS OWN bound");
  ok("the full run keeps its own bound; nothing is subtracted (#1509 RED→GREEN)");

  // Back-compat: with no tierTimeouts the old shared-bound behaviour stands —
  // callers that have not been migrated are not silently unbounded.
  const calls2: Array<number | undefined> = [];
  const exec2 = async (_cmd: string, opts?: { timeout?: number }) => {
    calls2.push(opts?.timeout);
    return { stdout: "", stderr: "" };
  };
  await withFastTier(exec2, "full cmd", "fast cmd")("full cmd", { timeout: 300_000 });
  assert.equal(calls2.length, 2, "both runs executed");
  assert.equal(calls2[0], 300_000, "shared bound: the fast run gets the whole bound");
  assert.ok(
    (calls2[1] ?? 0) <= 300_000 && calls2[1]! >= 1,
    `shared bound: the full run gets what the fast run left (${calls2[1]})`,
  );
  ok("an unmigrated caller keeps the pre-#1509 shared-bound behaviour");
}

// ── 8. Every tier's bound formats as a real duration, never `0-min`.
// #1041's handoff criterion: the message names the bound that applied. A
// non-minute-aligned value used to print "0-min".
{
  assert.equal(boundText(1_800_000), "30-min");
  assert.equal(boundText(90_000), "90s");
  assert.notEqual(boundText(45_000), "0-min", "a sub-minute bound is not 0-min");
  assert.equal(boundText(45_000), "45s");
  ok("a bound renders as a duration, not 0-min (#1041)");
}

// ── 9. The knob and file NAMES the handoff quotes are the real ones.
// The handoff's value is that the operator edits the thing it names; a name
// that drifts makes an accurate-looking message wrong.
{
  assert.equal(TIER_KNOB.suite, "PI_ENSEMBLE_VERIFY_SUITE_TIMEOUT_MS");
  assert.equal(TIER_KNOB.fast, "PI_ENSEMBLE_VERIFY_FAST_TIMEOUT_MS");
  assert.equal(TIER_KNOB.smoke, "PI_ENSEMBLE_VERIFY_SMOKE_TIMEOUT_MS");
  assert.equal(TIER_TIMEOUT_FILE.suite, "verify-timeout-ms");
  assert.equal(TIER_TIMEOUT_FILE.fast, "verify-cmd-fast-timeout-ms");
  assert.equal(TIER_TIMEOUT_FILE.smoke, "smoke-cmd-timeout-ms");
  ok("the handoff names the knob and file that actually govern each tier (#1041)");
}

// ── 10. The tiers the handoff distinguishes exist as distinct gate ids.
clearKnobs();
{
  const tiers = await developTierTimeoutMs("/nonexistent/pi-rukas-repo");
  assert.equal(tiers, 1_800_000, "the develop-tier reader resolves the suite tier's bound (#1509)");
  ok("the develop gate's shared reader agrees with the suite tier (#1509)");
}

restoreKnobs();
console.log(results.join("\n"));
console.log(`\nverify-tier-timeouts: ${results.length} groups passed`);
