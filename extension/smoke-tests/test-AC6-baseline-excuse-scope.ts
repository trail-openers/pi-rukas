#!/usr/bin/env bun
/**
 * #2042 AC6 — the excuse excuses a TIER, not the gate.
 *
 * A baseline excuse turns a tier that exited non-zero into a green, so the question
 * a reviewer will ask is what else that green now waves through. It waves through
 * nothing: the excuse changes what a tier's exit code means and has no effect on a
 * criterion the gate could not execute, which `publish` still refuses to make ready.
 *
 *   (excused-tier,manual) a `manual` criterion -> the PR opens as a DRAFT even
 *     though the record is a green whose reason carries the pre-existing disclosure
 *   (excused-tier,command-unrunnable) a `command` criterion the gate did not run ->
 *     DRAFT, for the same reason `publish` already gives it
 *   (excused-tier,clean) the same green with an executable-only spec -> READY, so
 *     the two cases above are not carried by a draft that was always coming
 *
 * Driven through the real `publish` step on its real repo and fake forge, with the
 * excused green written on the log exactly as `verify` writes it — green, head
 * certified, disclosure recorded — so the assertion is about what the record buys.
 */
import { rmSync } from "node:fs";
import type { PreexistingTierRecord } from "../src/lean/state-outcome-maps.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import { ROOTS, runPublish } from "./lib/lean-publish-fixture.ts";

const SELF = "test-AC6-baseline-excuse-scope.ts";
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

/** The record `verify` writes when it excuses the `fast` tier over the base commit. */
const EXCUSED: PreexistingTierRecord = {
  cmd: "pnpm test",
  names: NAMES,
  total: NAMES.length,
  baseSha: "b".repeat(40),
};

/** A green verify record of the shape an excused run leaves behind. */
const excusedVerify = {
  kind: "green" as const,
  reason: `frozen tests and project tiers passed — pre-existing failures on the base commit: fast`,
};

function spec(criteria: PiSpec["criteria"]): PiSpec {
  return { problem: "the helper must retry", size: "S", criteria };
}

const TEST_CRITERION = { id: "AC1", text: "the helper retries", verify: "test" } as const;

// ------------------------------------------------------------------ (manual)
{
  const r = await runPublish({
    issue: 531,
    verify: excusedVerify,
    spec: spec([TEST_CRITERION, { id: "AC2", text: "an operator signs it off", verify: "manual" }]),
    preexistingFailures: { fast: EXCUSED },
  } as never);
  assert(
    r.outcome?.kind === "ok",
    `(manual) the excused green still opens the PR (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    r.forge.prCreateCalls[0]?.draft === true,
    `(manual) a manual criterion keeps it a DRAFT (${String(r.forge.prCreateCalls[0]?.draft)})`,
  );
  assert(
    r.body.includes("## Pre-existing test failures"),
    "(manual) and the body still discloses the excused tier",
  );
}

// ---------------------------------------------------- (command-unrunnable)
{
  const r = await runPublish({
    issue: 532,
    verify: excusedVerify,
    spec: spec([
      TEST_CRITERION,
      { id: "AC2", text: "the old contract holds", verify: "command", command: "tests/old.sh" },
    ]),
    // The gate declined the criterion: nothing recorded as executed.
    preexistingFailures: { fast: EXCUSED },
  } as never);
  assert(
    r.outcome?.kind === "ok",
    `(command-unrunnable) the excused green still opens the PR (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    r.forge.prCreateCalls[0]?.draft === true,
    `(command-unrunnable) a command criterion the gate did not run keeps it a DRAFT (${String(r.forge.prCreateCalls[0]?.draft)})`,
  );
}

// ------------------------------------------------------------------ (clean)
{
  const r = await runPublish({
    issue: 533,
    verify: excusedVerify,
    spec: spec([TEST_CRITERION]),
    preexistingFailures: { fast: EXCUSED },
  } as never);
  assert(
    r.outcome?.kind === "ok",
    `(clean) the excused green opens the PR (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`,
  );
  assert(
    r.forge.prCreateCalls[0]?.draft === false,
    `(clean) a spec with nothing to hand to a human is READY, so the two cases above are the criterion's doing and not the excuse's (${String(r.forge.prCreateCalls[0]?.draft)})`,
  );
  assert(
    r.body.includes("## Pre-existing test failures") &&
      r.body.includes(`\`${"b".repeat(40)}\``),
    "(clean) the disclosure names the tier, its names and the base commit",
  );
  assert(
    r.body.includes(NAMES[0] as string),
    "(clean) every recorded failure line is printed, so the disclosure came from the record",
  );
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
