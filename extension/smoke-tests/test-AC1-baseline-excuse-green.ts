#!/usr/bin/env bun
/**
 * #2042 AC1 — on the arm where `classifyBaseRun` answers `red`, `verify` returns
 * GREEN carrying `preexistingFailures` when the Resolutions' rule holds, and keeps
 * today's `baseline red:` hand-back otherwise. Neither arm bills a build round: the
 * tier runs twice at HEAD and once at the base, both times.
 *
 * Driven through the real `verifyOutcome` on the real fixture repo: real git, a
 * real throwaway base checkout, and a tier that really exits 1 on both sides while
 * printing its own pytest `FAILED <path>::<name>` lines. The base run's NAME SET is
 * declared by the case — the base predates the run's contract, so only the case can
 * say what that run printed, which is the same seam `lib/lean-verify-probe-shapes.ts`
 * already uses for the base's bytes.
 */
import { rmSync } from "node:fs";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { pytestFailTier } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC1-baseline-excuse-green.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const NAMES = ["tests/x_test.py::test_a", "tests/x_test.py::test_b"];

/** The tier's record — the record is keyed by tier name — or `undefined`. */
function record(r: Awaited<ReturnType<typeof runVerify>>): Record<string, unknown> | undefined {
  const all = (r.outcome as { preexistingFailures?: Record<string, Record<string, unknown>> } | undefined)
    ?.preexistingFailures;
  return all?.["fast"];
}

// ---- every head failure also failed at the base: green with a disclosure
{
  const r = await runVerify({
    issue: 501,
    implement: true,
    config: { fast: pytestFailTier("preexisting", NAMES) },
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: NAMES.map((n) => `FAILED ${n} - AssertionError`).join("\n"),
    headTierOutput: NAMES.map((n) => `FAILED ${n} - AssertionError`).join("\n"),
  } as never);
  assert(
    r.outcome?.kind === "green",
    `(all-named-at-base) green, not a baseline-red hand-back (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 110)})`,
  );
  assert(
    Array.isArray(record(r)?.names) &&
      (record(r)?.names as string[]).join(",") === NAMES.join(",") &&
        record(r)?.total === 2,
    `(all-named-at-base) the tier's record carries the head names and the true total (${JSON.stringify(record(r))})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("pre-existing"),
    `(all-named-at-base) the green discloses the excuse instead of claiming a clean gate (${(r.outcome?.reason ?? "").slice(0, 180)})`,
  );
  assert(
    !(r.outcome?.reason ?? "").includes("baseline red:"),
    "(all-named-at-base) and it is not reported as a hand-back",
  );
  assert(r.outcome?.verifiedHead === r.head, "(all-named-at-base) the excused head is certified");
  assert(
    r.tierRuns === 2 && r.baseTierRuns === 1,
    `(all-named-at-base) no build round: two runs at HEAD, one at the base (${String(r.tierRuns)}/${String(r.baseTierRuns)})`,
  );
}

// ---- one head-only name: the excuse is forfeited, today's red stands
{
  const stream = (names: string[]): string => names.map((n) => `FAILED ${n} - Assert`).join("\n");
  const r = await runVerify({
    issue: 502,
    implement: true,
    config: { fast: pytestFailTier("head-only", NAMES) },
    headTierRedRuns: 2,
    baseRedContract: true,
    // The base printed only the first name; the second is this run's own breakage.
    baseTierOutput: stream([NAMES[0] as string]),
    headTierOutput: stream(NAMES),
  } as never);
  assert(
    r.outcome?.kind === "red" && (r.outcome?.reason ?? "").startsWith("baseline red:"),
    `(head-only-name) still today's red hand-back (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 130)})`,
  );
  assert(
    record(r) === undefined,
    `(head-only-name) no excuse recorded on a red (${JSON.stringify(record(r))})`,
  );
  assert(r.outcome?.verifiedHead === undefined, "(head-only-name) a red certifies no head");
  assert(
    r.tierRuns === 2 && r.baseTierRuns === 1,
    `(head-only-name) and still no build round (${String(r.tierRuns)}/${String(r.baseTierRuns)})`,
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
