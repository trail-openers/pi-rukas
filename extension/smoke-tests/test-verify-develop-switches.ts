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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  verifyProvenanceProseEnabled,
  VERIFY_PROVENANCE_PROSE_ENV,
  VERIFY_PROVENANCE_ROOT_ENV,
  verifySwitchOff as parseVerifySwitch,
  type ProvenanceDisclosure,
  type ProvenanceDisclosureSink,
} from "../src/work-driver-verify-develop-provenance.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import {
  type ProvenanceFixture,
  makeProvenanceFixture,
} from "./lib/verify-develop-provenance-fixture.ts";
import {
  GREEN_CRITERION,
  RUNNER_SCRIPT,
  specBody,
} from "./lib/verify-develop-criteria-fixture.ts";

let exit = 0;

/** The heading `provenanceDisclosureSectionOf` writes into the PR body. Spelled out rather than
 * imported from the module under test: the docs pin below is meant to fail when the emitted
 * heading and the documented one disagree, which a shared constant can never do. */
const PROVENANCE_DISCLOSURE_HEADING = "## Data provenance (warning — not blocking)";
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

// ── the two switches are discoverable, and their failure strings are explainable ───────────
{
  // `test-headless-inputs.ts` checks the roster against the readers and never opens `docs/`,
  // so a switch that is wired but undocumented is invisible to this suite. Each row is
  // asserted to say what the gate does AND what the operator does about it, which is the
  // difference between a named knob and a usable one.
  const docs = (file: string): string =>
    readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");
  const conf = docs("configuration.md");
  for (const [name, needle] of [
    [VERIFY_PROVENANCE_ENV, "present in that commit"],
    [VERIFY_COMMAND_CRITERIA_ENV, "verify.test"],
    [VERIFY_PROVENANCE_PROSE_ENV, "path-bearing fragment"],
    [VERIFY_PROVENANCE_ROOT_ENV, "realpath"],
  ] as const) {
    assert(
      conf.includes(`\`${name}\``) && conf.includes(needle),
      `docs/configuration.md carries a row for ${name} that explains the judgement it makes`,
    );
  }
  // #2295: the prose switch's off arm is defined as "v0.14.85 byte-for-byte", and the only
  // operator-facing statement of what that arm does lives in these two files. Both rows name
  // the switch and both name the value that turns it off, so a reader who finds the failure in
  // the PR body can find the escape hatch from the same place.
  for (const [needle] of [
    ["PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE"],
    ["PI_ENSEMBLE_VERIFY_PROVENANCE_ROOT"],
  ] as const) {
    assert(
      conf.includes(needle),
      `docs/configuration.md names ${needle} — the two #2295 knobs an operator has to be able to find`,
    );
  }
  // AGENTS.md §11 asks for a symptom → cause → fix entry on a PR that resolves a class of
  // user-facing failure. Both gates can stop a cycle on a string an operator has to act on,
  // so both strings have to be findable in troubleshooting.md rather than only in source.
  const trouble = docs("troubleshooting.md");
  assert(
    trouble.includes("data provenance:") && trouble.includes("does not exist in commit"),
    "docs/troubleshooting.md has an entry for the provenance failure an operator will see",
  );
  // #2295 D5 / Resolution 9: the disclosure section's heading is the string a reviewer pastes
  // when a row looks wrong, and #2295 makes prose claims land in failures rather than only in
  // that section. The row's Symptom text therefore carries the heading verbatim, and the pin
  // below is what keeps the two from drifting apart.
  assert(
    trouble.includes(PROVENANCE_DISCLOSURE_HEADING),
    `docs/troubleshooting.md quotes the emitted disclosure heading \`${PROVENANCE_DISCLOSURE_HEADING}\` verbatim, so an operator searching the PR body's heading finds the entry (pin: the heading string emitted by provenanceDisclosureSectionOf)`,
  );
  assert(
    trouble.includes(VERIFY_PROVENANCE_PROSE_ENV),
    "and it names the prose switch, which is the hatch for a record whose prose claims cannot be satisfied from the commit",
  );
  assert(
    trouble.includes(MISSING_VERIFY_TEST_TEMPLATE_FAILURE),
    "and one for the missing-verify.test blocking failure, quoting the string verbatim so a paste finds it",
  );
}

interface Drive {
  failures: string[];
  notes: string[];
  /** Filled only by a run that executed the provenance gate and disclosed something. Typed as
   * the gate's own row rather than `unknown[]`: the assertions below read `file` and `reason`
   * off these rows, and an `unknown[]` sink made every one of those reads untyped — a gate that
   * returned rows missing the field a case depended on would have compiled, and the disclosure
   * count would still have been green. */
  disclosures: ProvenanceDisclosure[];
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
  const sink: ProvenanceDisclosureSink = { disclosures: [] };
  await verifyDevelopOutcome(f.ctxFor(), f.stateFor(), f.execFn, failures, notes, {
    provenanceDisclosures: sink,
  });
  // `?? []` because the sink's field is optional by the gate's own declaration — the gate
  // creates it only when it runs, so "the gate never ran" and "it ran and disclosed nothing"
  // both arrive as an absent array. Collapsing them here is deliberate and is what the switch
  // arms below read: they ask whether this run disclosed rows, and both answers mean it did not.
  return { failures, notes, disclosures: sink.disclosures ?? [] };
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
  return { failures, notes, disclosures: [] };
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
  // The exact row, count included — not the prefix. A prefix match also passes on
  // `judged 0 provenance token(s)`, which is a note claiming an executed pass over a corpus
  // the gate never probed, so the number is the assertion here.
  const JUDGED_1 = `${PROVENANCE_CHECKED_NOTE} 1 provenance token(s) in workstream "a" against its pinned commit`;
  assert(
    judged.notes.some((n) => n === JUDGED_1) === true,
    `and the run records exactly what it judged — a green that named its corpus (got: ${judged.notes.filter((n) => n.includes("provenance")).join(" | ")})`,
  );
  await rm(clean);

  // The negative arm of the same invariant: a workstream whose added data file the gate
  // could not read judged NOTHING, so no `judged N` row may print at all — not `judged 0`.
  const unjudged = await makeProvenanceFixture({
    issue: 2283,
    developFiles: {
      "src/quota.ts": "export const quota = 1;\n",
      "runs/broken.json": "{ this is not json",
    },
  });
  const unjudgedRun = await driveProvenance(unjudged);
  assert(
    unjudgedRun.disclosures.length === 1,
    `the unparsable file was disclosed rather than skipped (got: ${JSON.stringify(unjudgedRun.disclosures)})`,
  );
  assert(
    unjudgedRun.notes.some((n) => n.startsWith(PROVENANCE_CHECKED_NOTE)) === false,
    `a run that probed nothing never prints the executed-pass note, not even as \`judged 0\` (got: ${unjudgedRun.notes.filter((n) => n.includes("provenance")).join(" | ")})`,
  );
  await rm(unjudged);
}

// ── the prose switch: same truth table, and its name is the documented one ─────────────────
{
  // #2295 D6. The prose arm ships ON and the one disable is the literal "0", so the same
  // narrower-than-truthy rule governs it; a wider parser would let a develop child switch the
  // gate off by putting a value in an environment it controls.
  for (const raw of [undefined, "", "1", "false", "no", "off", " 0 ", "00 ", "maybe"]) {
    assert(
      parseVerifySwitch(raw) === false,
      `prose switch: ${JSON.stringify(raw)} does NOT disable the prose arm — only the literal "0" does`,
    );
  }
  // The reader itself, on both arms: unset is on, and the literal "0" is off. The reader is
  // what `runProvenanceGate` consults at call time, so pinning it here is what stops a switch
  // that parses correctly and is then never consulted.
  await withSwitch(VERIFY_PROVENANCE_PROSE_ENV, undefined, async () => {
    assert(
      verifyProvenanceProseEnabled() === true,
      "the prose arm is ON when its variable is unset — the shipped default",
    );
  });
  await withSwitch(VERIFY_PROVENANCE_PROSE_ENV, "0", async () => {
    assert(
      verifyProvenanceProseEnabled() === false,
      "the prose arm is OFF on the literal \"0\" — the one disable",
    );
  });
  assert(
    VERIFY_PROVENANCE_PROSE_ENV === "PI_ENSEMBLE_VERIFY_PROVENANCE_PROSE" &&
      VERIFY_PROVENANCE_ROOT_ENV === "PI_ENSEMBLE_VERIFY_PROVENANCE_ROOT",
    "the two #2295 knob names are the ones docs/configuration.md, headless/inputs-b.ts and LIVE_INPUTS all name",
  );
}

// ── the command-criteria switch ────────────────────────────────────────────────────────────
async function criteriaFixture(): Promise<{ f: ProvenanceFixture; artifact: string }> {
  const f = await makeProvenanceFixture({
    issue: 2283,
    baseFiles: {
      // No .pi/work.json at all: with the tier on this is the missing-template blocking
      // failure, which is exactly what the off and absent arms must NOT produce.
      "tests/run.sh": RUNNER_SCRIPT,
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
