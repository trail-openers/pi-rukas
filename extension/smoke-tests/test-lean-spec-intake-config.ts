#!/usr/bin/env bun
/**
 * lean/spec-intake — what mode the run's config decides, and what a refused mode
 * becomes.
 *
 * `contractOf` is handed the config `ready` already read at the base (a config it
 * could not read is a setup refusal before the issue is touched —
 * `test-lean-ready-setup.ts`), and its arms here are:
 *
 *   - DEFAULTS (no file at the base): the shipped default (`require`) decides, and a
 *     prose ticket declines with `no pi-spec v1 block`;
 *   - REFUSED MODE (`SpecIntakeError` from `resolveSpecIntake`): a refusal naming
 *     the knob, returned as a rule — never a raw throw out of the step;
 *   - a committed `derive` mode really derives.
 */

import { defaultConfig } from "../src/lean/config.ts";
import { EMPTY_CONFIG, driveContractOf } from "./lib/lean-spec-intake-config-fixture.ts";

let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    failed++;
    console.log(`✗ ${label}`);
  }
}

// ── A mode the switch REFUSED comes back as a refusal naming the knob, never a raw
// throw out of the step, and bills no child.
{
  const r = await driveContractOf({ tag: "bad-mode-knob", config: EMPTY_CONFIG, intake: "deriver" });
  try {
    const c = r.contract as { rule?: string; infra?: boolean } | undefined;
    assert(
      r.thrown === undefined,
      `a knob value the switch refuses does not throw out of the step (${String(r.thrown)})`,
    );
    assert(
      (c?.rule ?? "").includes("PI_ENSEMBLE_LEAN_SPEC_INTAKE"),
      `…and the refusal names the knob (got ${JSON.stringify(c?.rule)})`,
    );
    assert(
      c?.infra !== true,
      `…and it is the repo's defect, so it declines rather than handing back (infra=${JSON.stringify(c?.infra)})`,
    );
    assert(r.derives === 0, `…and no child ran (derives=${r.derives})`);
  } finally {
    r.cleanup();
  }
}

// ── The defaults keep the shipped mode: prose declines.
{
  const r = await driveContractOf({ tag: "defaults", config: defaultConfig() });
  try {
    assert(
      r.thrown === undefined && r.contract?.rule === "no pi-spec v1 block",
      `the defaults decline a prose ticket with the missing-block rule (got ${JSON.stringify(r.contract ?? r.thrown)})`,
    );
    assert(r.contract?.infra === undefined, "…and that is not an infra verdict");
    assert(r.derives === 0, `…and no child ran (derives=${r.derives})`);
  } finally {
    r.cleanup();
  }
}

// ── A committed derive mode, read through the real loader, really derives.
{
  const r = await driveContractOf({
    tag: "derive-ok",
    configFile: JSON.stringify({ version: 1, lean: { specIntake: "derive" } }),
  });
  try {
    assert(
      r.thrown === undefined && r.contract?.spec !== undefined,
      `a committed derive mode with a readable config derives (got ${JSON.stringify(r.contract ?? r.thrown)})`,
    );
    assert(r.derives === 1, `…and bills exactly one child (${r.derives})`);
    assert(
      r.contract?.derived?.model !== undefined,
      "…and records the derivation's provenance",
    );
  } finally {
    r.cleanup();
  }
}

process.exit(failed);
