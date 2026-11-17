#!/usr/bin/env bun
/**
 * lean/spec-intake — what a config the run cannot READ becomes, and what a
 * refused mode becomes.
 *
 * `contractOf` reads `.pi/work.json` at the base to decide the intake mode, and
 * the read has three outcomes which must not collapse into two:
 *
 *   - ABSENT (no file at the base): today's behaviour, byte for byte — the shipped
 *     default (`require`) decides, and a prose ticket declines with `no pi-spec v1
 *     block`;
 *   - UNREADABLE / INVALID (`LeanConfigError`: git show failed, or the bytes are
 *     not valid JSON): a config the loader refused is infrastructure, NOT "no
 *     config". Collapsing it into the default posts a not-ready comment on an
 *     innocent ticket — the run's own `ready` step treats a broken config as a
 *     failure to report, and an intake decision made from bytes nobody read is not
 *     an intake decision;
 *   - REFUSED MODE (`SpecIntakeError` from `resolveSpecIntake`): a refusal naming
 *     the knob, returned as a rule — never a raw throw out of the step.
 *
 * The mode is resolved BEFORE any child is billed in both failure arms, which the
 * derive counts below pin.
 */

import type { WorkConfig } from "../src/lean/config.ts";
import { LeanConfigError } from "../src/lean/config.ts";
import {
  EMPTY_CONFIG,
  driveContractOf,
  realLoadConfig,
} from "./lib/lean-spec-intake-config-fixture.ts";

let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    failed++;
    console.log(`✗ ${label}`);
  }
}

// ── An INVALID committed config is `infra`, not a decline, and bills no child.
{
  const r = await driveContractOf({
    tag: "invalid-json",
    configFile: "{not json",
    intake: "derive",
    loadConfig: realLoadConfig,
  });
  try {
    const c = r.contract as { rule?: string; infra?: boolean } | undefined;
    assert(r.thrown === undefined, `an invalid config does not throw out of the step (${r.thrown})`);
    assert(c?.infra === true, `…and the verdict is infra, not a decline (got ${JSON.stringify(c)})`);
    assert(
      (c?.rule ?? "").includes("work.json"),
      `…and the rule names the config it could not read (got ${JSON.stringify(c?.rule)})`,
    );
    assert(r.derives === 0, `…and no child was billed for a config nobody read (derives=${r.derives})`);
  } finally {
    r.cleanup();
  }
}

// ── A config whose READ failed (git show) is the same verdict.
{
  const r = await driveContractOf({
    tag: "read-failed",
    intake: "derive",
    loadConfig: () => Promise.reject(new LeanConfigError("could not read base:.pi/work.json: boom")),
  });
  try {
    const c = r.contract as { rule?: string; infra?: boolean } | undefined;
    assert(
      r.thrown === undefined && c?.infra === true,
      `a LeanConfigError from the read is an infra verdict, not a throw (got ${JSON.stringify(r.contract ?? r.thrown)})`,
    );
    assert(
      (c?.rule ?? "").includes("work.json"),
      `…and the rule still names the knob (got ${JSON.stringify(c?.rule)})`,
    );
    assert(r.derives === 0, `…and no child ran (derives=${r.derives})`);
  } finally {
    r.cleanup();
  }
}

// ── A mode the switch REFUSED comes back as a refusal naming the knob, never a raw
// throw out of the step, and bills no child.
{
  const r = await driveContractOf({
    tag: "bad-mode-knob",
    loadConfig: () => Promise.resolve(EMPTY_CONFIG),
    // An invalid value on the knob itself is what makes `resolveSpecIntake` refuse.
    intake: "deriver",
  });
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
    assert(r.loadAttempts === 1, `…which means the config was read (${r.loadAttempts})`);
    assert(r.derives === 0, `…and no child ran (derives=${r.derives})`);
  } finally {
    r.cleanup();
  }
}

// ── An ABSENT config keeps today's behaviour: the default decides, prose declines.
{
  const r = await driveContractOf({
    tag: "absent",
    // The loader's own answer to "that file is not in that commit": absence is not a
    // `LeanConfigError`, and `loadWorkConfig` reports it by returning `undefined`.
    loadConfig: () => Promise.resolve(undefined as unknown as WorkConfig),
  });
  try {
    assert(
      r.thrown === undefined && r.contract?.rule === "no pi-spec v1 block",
      `a config read that reports a plain absence still declines with the missing-block rule (got ${JSON.stringify(r.contract ?? r.thrown)})`,
    );
    assert(
      r.contract?.infra === undefined,
      "…and an absent config is not an infra verdict — the default is the normal case",
    );
    assert(r.derives === 0, `…and no child ran (derives=${r.derives})`);
  } finally {
    r.cleanup();
  }
}

// ── A mode the switch refuses is a refusal naming the knob, never a raw throw.
{
  const r2 = await driveContractOf({
    tag: "config-invalid-knob",
    intake: undefined,
    configFile: JSON.stringify({ version: 1, lean: { specIntake: "derve" } }),
    loadConfig: realLoadConfig,
  });
  try {
    const c = r2.contract as { rule?: string; infra?: boolean } | undefined;
    assert(
      r2.thrown === undefined,
      `a committed config carrying an unusable lean.specIntake is refused by the loader, not thrown out of the step (${String(r2.thrown)})`,
    );
    assert(
      (c?.rule ?? "").includes("specIntake"),
      `…and the rule still names the knob it refused (got ${JSON.stringify(c?.rule)})`,
    );
    assert(
      c?.infra === true,
      `…and an unreadable config is infrastructure whichever byte caused it (infra=${JSON.stringify(c?.infra)})`,
    );
    assert(r2.derives === 0, `…and no child ran (derives=${r2.derives})`);
  } finally {
    r2.cleanup();
  }
}

// ── The healthy arm, beside the broken ones: derive really derives.
{
  const r = await driveContractOf({
    tag: "derive-ok",
    configFile: JSON.stringify({ version: 1, lean: { specIntake: "derive" } }),
    loadConfig: realLoadConfig,
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
