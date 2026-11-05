#!/usr/bin/env bun
/**
 * #2042 AC3/AC5 — the record that licenses the green, and what the body prints.
 *
 * The excuse turns a tier that exited non-zero into a GREEN, and the only thing
 * standing between that green and a reviewer is a bounded record plus the section
 * `publish` renders from it. So the pair is tested as one contract: what the gate
 * may claim, and what the reader may see.
 *
 *   (shape) the recorded tier carries the command VERBATIM, the head run's names in
 *     stream order, its TRUE total, the base sha, and the base's complete name set —
 *     the set `ci` needs to reuse the proof instead of paying for a second probe
 *   (cap) more failures than the name cap are bounded in what is PRINTED while the
 *     total keeps telling the truth, and a base set too large to persist is omitted
 *     rather than truncated (a partial base set would let `ci` excuse a failure it
 *     never saw at base)
 *   (validator) a record that could not have been written by the gate is refused by
 *     `state-outcome`'s validator, which forfeits the excuse rather than throwing
 *   (body) `publish` renders `## Pre-existing test failures` from the RECORD — tier,
 *     command, base commit, total, names — and prints nothing when no tier was excused
 */
import { rmSync } from "node:fs";
import {
  PREEXISTING_BASE_NAMES_CAP,
  PREEXISTING_NAMES_CAP,
  preexistingFailuresProblem,
  validatedPreexistingFailures,
} from "../src/lean/state-outcome-maps.ts";
import { leanPreexistingFailuresSection, publishBody } from "../src/lean/publish-body.ts";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";
import { ROOTS, runVerify } from "./lib/lean-verify-fixture.ts";
import { pytestFailTier } from "./lib/lean-verify-tiers.ts";

const SELF = "test-AC3-baseline-excuse-record.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const NAMES = ["tests/x_test.py::test_a", "tests/x_test.py::test_b"];
const stream = (names: string[]): string => names.map((n) => `FAILED ${n} - Assert`).join("\n");

type Ran = Awaited<ReturnType<typeof runVerify>>;
function recordOf(r: Ran): PreexistingTierRecord | undefined {
  return (r.outcome as { preexistingFailures?: Record<string, PreexistingTierRecord> } | undefined)
    ?.preexistingFailures?.["fast"];
}

// ------------------------------------------------------------------ (shape)
{
  const tier = pytestFailTier("record", NAMES);
  const r = await runVerify({
    issue: 521,
    implement: true,
    config: { fast: tier },
    headTierRedRuns: 2,
    baseRedContract: true,
    baseTierOutput: stream(NAMES),
    headTierOutput: stream(NAMES),
  } as never);
  const rec = recordOf(r);
  assert(
    r.outcome?.kind === "green" && rec !== undefined,
    `(shape) the excused run is green and carries a record (${r.outcome?.kind})`,
  );
  assert(rec?.cmd === tier, `(shape) the tier's command is recorded verbatim`);
  assert(
    rec?.names.join(",") === NAMES.join(","),
    `(shape) the head names are recorded in stream order (${JSON.stringify(rec?.names)})`,
  );
  assert(rec?.total === 2, `(shape) the true total is recorded (${String(rec?.total)})`);
  assert(
    typeof rec?.baseSha === "string" && /^[0-9a-f]{40}$/.test(rec.baseSha),
    `(shape) the base sha is the probe's commit (${String(rec?.baseSha)})`,
  );
  assert(
    rec?.baseNames?.join(",") === NAMES.join(","),
    `(shape) the base's complete name set is recorded for ci to reuse (${JSON.stringify(rec?.baseNames)})`,
  );
  assert(
    preexistingFailuresProblem({ fast: rec }) === undefined,
    `(shape) a record the gate really wrote passes its validator (${preexistingFailuresProblem({ fast: rec })})`,
  );
}

// -------------------------------------------------------------------- (cap)
{
  // More failures than the record may print: the total keeps telling the truth and
  // the printed set is bounded in stream order. Built through the validator rather
  // than a live tier so the case is about the bound, not about the fixture.
  const many = Array.from({ length: PREEXISTING_NAMES_CAP + 5 }, (_, i) => `tests/x.py::t${i}`);
  const rec: PreexistingTierRecord = {
    cmd: "pytest",
    names: many.slice(0, PREEXISTING_NAMES_CAP),
    total: many.length,
    baseSha: "b".repeat(40),
    baseNames: many,
  };
  assert(
    preexistingFailuresProblem({ fast: rec }) === undefined,
    `(cap) a capped record with the TRUE total is a valid record (${preexistingFailuresProblem({ fast: rec })})`,
  );
  assert(
    validatedPreexistingFailures({ fast: rec })?.["fast"]?.total === many.length,
    `(cap) the total survives the cap (${String(validatedPreexistingFailures({ fast: rec })?.["fast"]?.total)})`,
  );
  const over: PreexistingTierRecord = { ...rec, names: many };
  assert(
    preexistingFailuresProblem({ fast: over }) !== undefined,
    `(cap) more names than the cap is refused rather than silently clipped`,
  );
  const oversizedBase: PreexistingTierRecord = {
    cmd: "pytest",
    names: ["tests/x.py::t0"],
    total: 1,
    baseSha: "b".repeat(40),
    baseNames: Array.from({ length: PREEXISTING_BASE_NAMES_CAP + 1 }, (_, i) => `tests/x.py::t${i}`),
  };
  assert(
    preexistingFailuresProblem({ fast: oversizedBase }) !== undefined,
    `(cap) a base set too large to persist is refused, never truncated in place`,
  );
  assert(
    validatedPreexistingFailures({ fast: oversizedBase })?.["fast"] === undefined,
    `(cap) and the rebuilt record drops the tier rather than storing a partial base set`,
  );
}

// --------------------------------------------------------------- (validator)
{
  const good: PreexistingTierRecord = {
    cmd: "pytest",
    names: ["tests/x.py::t0"],
    total: 1,
    baseSha: "b".repeat(40),
  };
  const refusals: [string, Record<string, unknown>][] = [
    ["a tier with no names", { fast: { ...good, names: [] } }],
    ["a total of zero", { fast: { ...good, total: 0 } }],
    ["a non-integer total", { fast: { ...good, total: 1.5 } }],
    ["a base sha that is not 40-hex", { fast: { ...good, baseSha: "abc" } }],
    ["an empty command", { fast: { ...good, cmd: "  " } }],
    ["a name with a control character", { fast: { ...good, names: ["t\u0000x"] } }],
    ["a name that is not a string", { fast: { ...good, names: [1] } }],
    ["an empty base-name set", { fast: { ...good, baseNames: [] } }],
    ["not an object at all", { fast: "pytest said so" }],
  ];
  for (const [what, value] of refusals) {
    const why = preexistingFailuresProblem(value);
    assert(why !== undefined, `(validator) ${what} is refused (${why ?? "ACCEPTED"})`);
    assert(
      validatedPreexistingFailures(value) === undefined ||
        Object.keys(validatedPreexistingFailures(value) ?? {}).length === 0,
      `(validator) ${what} leaves nothing to render`,
    );
  }
  assert(
    preexistingFailuresProblem(undefined) !== undefined,
    "(validator) a map that is absent entirely is refused, not defaulted",
  );
}

// -------------------------------------------------------------------- (body)
{
  const rec: PreexistingTierRecord = {
    cmd: "pnpm test --filter x",
    names: ["tests/a.spec.ts::t1", "tests/b.spec.ts::t2"],
    total: 7,
    baseSha: "c".repeat(40),
  };
  const body = leanPreexistingFailuresSection({ fast: rec });
  assert(body.includes("## Pre-existing test failures"), "(body) the section heading is printed");
  assert(
    body.includes("Failing on the base commit too; not introduced by this change."),
    "(body) the section states what the failures are",
  );
  assert(body.includes("### `fast`"), "(body) the tier names itself");
  assert(body.includes("`pnpm test --filter x`"), "(body) the command is printed");
  assert(body.includes(`\`${"c".repeat(40)}\``), "(body) the base commit is printed");
  assert(body.includes("7 total, 2 named:"), `(body) the true total, not the printed count (${body.slice(0, 0)})`);
  assert(
    body.includes("`tests/a.spec.ts::t1`") && body.includes("`tests/b.spec.ts::t2`"),
    "(body) every recorded name is printed",
  );
  assert(leanPreexistingFailuresSection(undefined) === "", "(body) no record, no section");
  assert(leanPreexistingFailuresSection({}) === "", "(body) an empty record, no section");

  // And through the whole renderer: the section rides with the rest of the body,
  // and a run nobody excused prints no heading at all.
  const spec = { problem: "p", size: "S" as const, criteria: [{ id: "AC1", text: "t", verify: "test" as const }] };
  const withSection = publishBody({
    issue: 1,
    spec,
    tests: {},
    verifyKind: "green",
    preexistingFailures: { fast: rec },
    draft: false,
    version: "1.2.3",
    models: {},
    baseSha: "a".repeat(40),
  });
  assert(
    withSection.includes("## Pre-existing test failures"),
    "(body) publishBody renders the section from the record",
  );
  const without = publishBody({
    issue: 1,
    spec,
    tests: {},
    verifyKind: "green",
    draft: false,
    version: "1.2.3",
    models: {},
    baseSha: "a".repeat(40),
  });
  assert(
    !without.includes("Pre-existing test failures"),
    "(body) a green with no excused tier prints no such heading",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
