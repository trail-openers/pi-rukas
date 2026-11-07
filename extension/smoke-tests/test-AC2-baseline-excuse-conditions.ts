#!/usr/bin/env bun
/**
 * #2042 AC2/AC3 — the two halves of the excuse's own precondition, plus its bound.
 *
 * AC1 asks whether a tier whose failures the base also printed is graded green. This
 * file asks the two questions that decide whether the excuse was earned, and the one
 * bound it must respect:
 *
 *   (acceptance-red) base red + head names ⊆ base names + the run's OWN frozen test
 *     red -> today's red "baseline red:", no disclosure, no head certified. The tier
 *     arm returns before the frozen verdict is normally consulted, so the excuse
 *     asks it first, on purpose: a gate that graded this green would certify a run
 *     whose acceptance tests it never saw pass (R1).
 *   (beyond-the-window) a head stream whose ONLY `FAILED` line is longer than the
 *     classifier's per-line window -> no names parsed -> no excuse. The extractor
 *     reads only through `failureLines`, so the window is the known bound (R3).
 *   (cap) 25 base failures covering every head name -> green, with the record
 *     carrying 20 names in stream order and the TRUE total of 25: the cap bounds
 *     what is printed, never what was counted (R4).
 *
 * All three run the real `verifyOutcome` over a real repo and a real base checkout,
 * with a tier that really exits 1 and really prints pytest failing lines.
 */
import { rmSync } from "node:fs";
import { PREEXISTING_NAMES_CAP } from "../src/lean/state-outcome-maps.ts";
import {
  GREEN_TEST,
  RED_ACCEPTANCE_TEST,
  ROOTS,
  runVerify,
} from "./lib/lean-verify-fixture.ts";
import { pytestFailTier } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC2-baseline-excuse-conditions.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const NAMES = [
  "FAILED tests/x_test.py::test_a - Assert",
  "FAILED tests/x_test.py::test_b - Assert",
];
const stream = (names: string[]): string => names.join("\n");

type Ran = Awaited<ReturnType<typeof runVerify>>;
function record(r: Ran): { names: string[]; total: number } | undefined {
  return (r.outcome as { preexistingFailures?: Record<string, { names: string[]; total: number }> } | undefined)
    ?.preexistingFailures?.["fast"];
}

// ---------------------------------------------------------- (acceptance-red)
{
  // The tier's names match the base's exactly, so ONLY the frozen verdict can refuse
  // this — which is what makes the case worth having.
  const r = await runVerify({
    issue: 551,
    implement: true,
    config: { fast: pytestFailTier("acceptance-red", NAMES) },
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: stream(NAMES),
    headTierOutput: stream(NAMES),
    frozenText: RED_ACCEPTANCE_TEST,
  } as never);
  assert(
    r.outcome?.kind === "red" && (r.outcome?.reason ?? "").startsWith("baseline red:"),
    `(acceptance-red) today's hand-back, not a green with a disclosure (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 120)})`,
  );
  assert(record(r) === undefined, `(acceptance-red) nothing is disclosed (${JSON.stringify(record(r))})`);
  assert(r.outcome?.verifiedHead === undefined, "(acceptance-red) and no head is certified");
  assert(
    r.tierRuns === 2 && r.baseTierRuns === 1,
    `(acceptance-red) and no build round is billed (${String(r.tierRuns)}/${String(r.baseTierRuns)})`,
  );
}

// --------------------------------------------------- (acceptance-green pair)
{
  // The same run with the frozen contract green is the green AC1 asks for: the pair
  // proves the frozen verdict is what differs, not the tier or the fixture.
  const r = await runVerify({
    issue: 552,
    implement: true,
    config: { fast: pytestFailTier("acceptance-green", NAMES) },
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: stream(NAMES),
    headTierOutput: stream(NAMES),
    frozenText: GREEN_TEST,
  } as never);
  assert(
    r.outcome?.kind === "green" && record(r) !== undefined,
    `(acceptance-green) the same run with a green contract is green with a disclosure (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
}

// ----------------------------------------------------- (beyond-the-window)
{
  // The head's only failing-test line is a `FAILED …` whose prefix pushes the token
  // past the classifier's per-line window, so no name is parsed and the excuse has
  // nothing to compare.
  const r = await runVerify({
    issue: 553,
    implement: true,
    config: { fast: pytestFailTier("beyond-window", NAMES) },
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: stream(NAMES),
    // The ONLY failing-test line the head run prints is one whose prefix pushes the
    // token past the classifier's window: nothing is parsed, so nothing is excused.
    headTierOutput: `${"y".repeat(9 * 1024)} FAILED ${NAMES.join(", ")} - Assert`,
  } as never);
  assert(
    r.outcome?.kind === "red" && (r.outcome?.reason ?? "").startsWith("baseline red:"),
    `(beyond-window) a name past the window is no name at all (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`}; ${(r.outcome?.reason ?? "").slice(0, 100)})`,
  );
  assert(record(r) === undefined, "(beyond-window) no disclosure is recorded");
}

// -------------------------------------------------------------------- (cap)
{
  const many = Array.from(
    { length: PREEXISTING_NAMES_CAP + 5 },
    (_, i) => `FAILED tests/x_test.py::t${String(i)} - Assert`,
  );
  const r = await runVerify({
    issue: 554,
    implement: true,
    // The tier's own command prints all 25; the head stream the step reads is the
    // 25 the tier really prints, so head ⊆ base holds over the complete sets.
    config: { fast: pytestFailTier("cap", many) },
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: stream(many),
    headTierOutput: stream(many),
    frozenText: GREEN_TEST,
  } as never);
  const rec = record(r);
  assert(
    r.outcome?.kind === "green" && rec !== undefined,
    `(cap) 25 base failures covering every head name -> green (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    rec?.names.length === PREEXISTING_NAMES_CAP,
    `(cap) the record prints ${PREEXISTING_NAMES_CAP} names (${String(rec?.names.length)})`,
  );
  assert(
    rec?.names.join(",") === many.slice(0, PREEXISTING_NAMES_CAP).join(","),
    `(cap) and they are the first ${PREEXISTING_NAMES_CAP} in stream order (${rec?.names[0]}, ${rec?.names[rec.names.length - 1]})`,
  );
  assert(
    rec?.total === many.length,
    `(cap) while the TRUE total is kept (${String(rec?.total)} of ${String(many.length)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("pre-existing"),
    "(cap) the green still discloses the excuse",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
