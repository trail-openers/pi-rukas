#!/usr/bin/env bun
/**
 * #2283 — the two develop-gate switches.
 *
 * The gate's own behaviour is pinned in `test-verify-develop-data-provenance.ts` and
 * `test-work-driver-verify-command-criteria-classic.ts`. This file pins the narrower thing
 * the switches have to guarantee, which the behaviour suites cannot: **an off switch is
 * indistinguishable from a missing switch, and neither is ever a silent green.**
 *
 * That distinction is the whole reason these gates are safe to ship on. A switch that let a
 * gate be skipped without a trace would make `PI_ENSEMBLE_VERIFY_PROVENANCE=0` the most
 * reliable way to pass the develop step, and the driver could not tell a judged run from an
 * unjudged one. So each arm is asserted on all three axes:
 *
 *   - **on** — the gate runs: a blocking failure where the defect is, and no NOT-CHECKED note;
 *   - **off** — no failure, and the note that says the check did not run;
 *   - **absent** — identical to off, because the shipped default is on only in the resolver
 *     and the caller is the one that omits the flag in a test; and
 *   - **unparsable** — resolves to the same as absent, never to a crash or a silent pass.
 *
 * Plus the resolver's own truth table, which `docs/configuration.md` and
 * `headless/inputs-b.ts` both restate: the four truthy spellings, the two falsy ones, and
 * anything else falling back to the default.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  COMMAND_CRITERIA_CHECKED_NOTE_PREFIX,
  COMMAND_CRITERIA_DISABLED_NOTE,
  COMMAND_CRITERIA_PREFIX,
  MISSING_VERIFY_TEST_TEMPLATE_FAILURE,
  VERIFY_COMMAND_CRITERIA_ENV,
} from "../src/work-driver-verify-develop-command-criteria.ts";
import {
  PROVENANCE_CHECKED_NOTE,
  PROVENANCE_DISABLED_NOTE,
  PROVENANCE_FAILURE_PREFIX,
  PROVENANCE_NOT_CHECKED_PREFIX,
  VERIFY_PROVENANCE_ENV,
  verifySwitchOff as parseVerifySwitch,
} from "../src/work-driver-verify-develop-provenance.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import {
  type ProvenanceFixture,
  makeProvenanceFixture,
} from "./lib/verify-develop-provenance-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── the resolver's truth table ─────────────────────────────────────────────────────────────
{
  // The rule every driver kill-switch answers, pinned here so the two develop gates cannot
  // drift into a wider parser a develop child could exploit: exactly "0" is off, and every
  // other value — including the plausible `false`, `no` and `off`, a typo, and the empty
  // string — leaves the gate ON.
  for (const raw of [
    undefined,
    "",
    "  ",
    "false",
    "FALSE",
    "no",
    "off",
    "OFF",
    "maybe",
    "2",
    "00 ",
    " 0 ",
  ]) {
    assert(
      parseVerifySwitch(raw) === false,
      `not a disable: ${JSON.stringify(raw)} does NOT turn a gate off — a misspelled disable must never read as a deliberate one`,
    );
  }
  for (const raw of ["0"]) {
    assert(
      parseVerifySwitch(raw) === true,
      `the one disable: ${JSON.stringify(raw)} turns the gate off`,
    );
  }
  assert(
    VERIFY_PROVENANCE_ENV === "PI_ENSEMBLE_VERIFY_PROVENANCE" &&
      VERIFY_COMMAND_CRITERIA_ENV === "PI_ENSEMBLE_VERIFY_COMMAND_CRITERIA",
    "the two switch names are the ones docs/configuration.md and headless/inputs-b.ts document",
  );
}

const GREEN_CRITERION = {
  id: "AC1",
  text: "The existing suite still passes.",
  verify: "command",
  command: "tests/quota.test.ts",
};

function specBody(criteria: Record<string, unknown>[]): string {
  return `Add a quota check.\n\n\`\`\`pi-spec v1\n${JSON.stringify(
    { problem: "The meter must refuse an over-quota draw.", criteria, size: "S" },
    null,
    2,
  )}\n\`\`\`\n`;
}

interface Drive {
  failures: string[];
  notes: string[];
}

/** Set or unset one switch for one arm, and restore it exactly.
 *
 * The switch is a process env read at call time (each gate reads it per call, so a driver
 * process that inherited a stale value cannot be talked out of it later). An `undefined`
 * value must REMOVE the key: the Bun-1.4 assignment of an undefined value stringifies to
 * `"undefined"`, which is neither the absent arm nor an off arm, and would leave every later
 * case in this file judged by a value nobody set. */
async function withSwitch(
  name: string,
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await run();
  } finally {
    if (had && prev !== undefined) process.env[name] = prev;
    else delete process.env[name];
  }
}

const PROVENANCE_ENV = "PI_ENSEMBLE_VERIFY_PROVENANCE";
const COMMAND_CRITERIA_ENV = "PI_ENSEMBLE_VERIFY_COMMAND_CRITERIA";

async function driveProvenance(f: ProvenanceFixture): Promise<Drive> {
  const failures: string[] = [];
  const notes: string[] = [];
  await verifyDevelopOutcome(f.ctxFor(), f.stateFor(), f.execFn, failures, notes, {});
  return { failures, notes };
}

async function driveCriteria(f: ProvenanceFixture, artifact: string): Promise<Drive> {
  const failures: string[] = [];
  const notes: string[] = [];
  await verifyDevelopOutcome(
    f.ctxFor(),
    f.stateFor({ issueBodyArtifact: artifact }),
    f.execFn,
    failures,
    notes,
    {},
  );
  return { failures, notes };
}

async function rm(f: ProvenanceFixture): Promise<void> {
  const { rmSync } = await import("node:fs");
  rmSync(f.root, { recursive: true, force: true });
}

// ── the provenance switch ──────────────────────────────────────────────────────────────────
async function provenanceFixture(): Promise<ProvenanceFixture> {
  return makeProvenanceFixture({
    issue: 2283,
    developFiles: {
      "src/quota.ts": "export const quota = 1;\n",
      // A record naming a file that exists nowhere: the defect the gate exists to catch.
      "tasks/record.json": '{"source":"results/never-measured.ndjson","rows":[]}\n',
    },
  });
}

await withSwitch(PROVENANCE_ENV, "0", async () => {
  const f1 = await provenanceFixture();
  const off = await driveProvenance(f1);
  assert(
    off.failures.some((x) => x.includes(PROVENANCE_FAILURE_PREFIX)) === false,
    `provenance OFF never blocks on a missing source (got: ${off.failures.join(" | ")})`,
  );
  assert(
    off.notes.some((x) => x === PROVENANCE_DISABLED_NOTE) === true,
    `provenance OFF says so, in the constant's own words: an off run is never a silent green (got: ${off.notes.filter((x) => x.includes("provenance")).join(" | ")})`,
  );
  await rm(f1);
});

await withSwitch(PROVENANCE_ENV, undefined, async () => {
  const fOn = await provenanceFixture();
  const on = await driveProvenance(fOn);
  assert(
    on.failures.some((f) => f.includes(PROVENANCE_FAILURE_PREFIX)) === true &&
      on.notes.some((n) => n.startsWith(PROVENANCE_NOT_CHECKED_PREFIX)) === false,
    `provenance ON blocks the missing source and does not hedge (got: ${on.failures.join(" | ")})`,
  );

  await rm(fOn);
});

await withSwitch(PROVENANCE_ENV, "off", async () => {
  // Only the exact string "0" disables, so a misspelled disable must judge exactly like the
  // ON arm above — the same failure, not an off note.
  const f2 = await provenanceFixture();
  const absent = await driveProvenance(f2);
  assert(
    absent.failures.some((x) => x.includes(PROVENANCE_FAILURE_PREFIX)) === true,
    `provenance with no env at all is the ON default and blocks (got: ${absent.failures.join(" | ")})`,
  );
  await rm(f2);
});

{
  // The checked note appears only when the gate actually judged something.
  const clean = await makeProvenanceFixture({
    issue: 2283,
    baseFiles: { "results/measured.ndjson": '{"ok":true}\n' },
    developFiles: {
      "src/quota.ts": "export const quota = 1;\n",
      "tasks/record.json": '{"source":"results/measured.ndjson","rows":[]}\n',
    },
  });
  const judged = await driveProvenance(clean);
  assert(
    judged.failures.some((f) => f.includes(PROVENANCE_FAILURE_PREFIX)) === false,
    `a record whose source exists passes (got: ${judged.failures.join(" | ")})`,
  );
  assert(
    judged.notes.some((n) => n.startsWith(PROVENANCE_CHECKED_NOTE)) === true,
    `and the run records what it judged — a green that named its corpus (got: ${judged.notes.filter((n) => n.includes("provenance")).join(" | ")})`,
  );
  await rm(clean);
}

// ── the command-criteria switch ────────────────────────────────────────────────────────────
async function criteriaFixture(): Promise<{ f: ProvenanceFixture; artifact: string }> {
  const f = await makeProvenanceFixture({
    issue: 2283,
    baseFiles: {
      // No .pi/work.json at all: with the tier on this is the missing-template blocking
      // failure, which is exactly what the off and absent arms must NOT produce.
      "tests/run.sh": '#!/bin/sh\nif grep -q FAIL "$1"; then exit 1; fi\nexit 0\n',
      "tests/quota.test.ts": "ok\n",
    },
    developFiles: { "src/quota.ts": "export const quota = 1;\n" },
  });
  const rel = ".pi/work-state/2283/issue-body.txt";
  mkdirSync(path.join(f.repo, ".pi", "work-state", "2283"), { recursive: true });
  writeFileSync(path.join(f.repo, rel), specBody([GREEN_CRITERION]));
  return { f, artifact: rel };
}

await withSwitch(COMMAND_CRITERIA_ENV, "0", async () => {
  const b = await criteriaFixture();
  const off = await driveCriteria(b.f, b.artifact);
  assert(
    off.failures.some((x) => x.includes(COMMAND_CRITERIA_PREFIX)) === false,
    `criteria OFF never blocks (got: ${off.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  assert(
    off.notes.some((x) => x === COMMAND_CRITERIA_DISABLED_NOTE) === true,
    `criteria OFF says so in the constant's own words (got: ${off.notes.filter((x) => x.includes("criteria")).join(" | ")})`,
  );
  assert(
    off.notes.some((x) => x.startsWith(COMMAND_CRITERIA_CHECKED_NOTE_PREFIX)) === false,
    "and an off run never prints the executed-pass note — a note claiming criteria ran when none did is the failure this pair of constants exists to prevent",
  );
  await rm(b.f);
});

await withSwitch(COMMAND_CRITERIA_ENV, undefined, async () => {
  const a = await criteriaFixture();
  const on = await driveCriteria(a.f, a.artifact);
  assert(
    on.failures.includes(MISSING_VERIFY_TEST_TEMPLATE_FAILURE) === true,
    `criteria ON blocks on the missing template (got: ${on.failures.filter((f) => f.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await rm(a.f);
});

await withSwitch(COMMAND_CRITERIA_ENV, "false", async () => {
  const c = await criteriaFixture();
  const absent = await driveCriteria(c.f, c.artifact);
  assert(
    absent.failures.includes(MISSING_VERIFY_TEST_TEMPLATE_FAILURE) === true,
    `criteria UNPARSABLE ("false") stays ON — the plausible spellings of "off" are not switches (got: ${absent.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  assert(
    absent.notes.some((x) => x === COMMAND_CRITERIA_DISABLED_NOTE) === false,
    "and an unparsable value never prints the disabled note",
  );
  await rm(c.f);
});

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
