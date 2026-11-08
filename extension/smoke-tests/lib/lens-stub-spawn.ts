#!/usr/bin/env bun
/**
 * lens-stub-spawn — drives the REAL lens spawn chain with `spawnSpecialist`
 * replaced by a recorder, for the suites that pin what a lens CHILD was handed
 * (#2127: the advisory turn ceiling).
 *
 * Why it is not in `test-lens-child-bound.ts`: that file already occupies
 * `mock.module` on `../src/spawn.ts` for the driver path, and a second
 * `mock.module` of the same specifier does not reliably replace the first. The
 * lean-path suite therefore needs its own process and its own recorder, and
 * this module is what keeps the two recorders from drifting in shape.
 *
 * The mock answers for EVERY spawn the lens chain can reach, so a capture that
 * belongs to a lens child is told apart from a sibling child's by the fields the
 * case asserts on (`budgetTurns`), not by faith about who else might have
 * dispatched.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute it (same shape as lib/review-ledger-test-helpers.ts).
 */

import { mock } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "../../src/pi-event-shapes.ts";
import { LENS_ROSTER } from "../../src/lens-roster.ts";

/** What one spawn was handed — only the fields these suites read. */
export interface StubSpawnCall {
  role: string;
  prompt: string;
  childBoundMs?: number;
  budgetTurns?: number;
}

/** Install the recorder over `src/spawn.ts`. Returns the growing call list.
 *
 * The mock must be installed BEFORE the lens modules are imported (the
 * `mock.module` pattern in test-lens-skill-wiring.ts), which is why callers get
 * the list from here and `await import` the modules under test themselves.
 */
export function stubLensSpawn(): StubSpawnCall[] {
  const calls: StubSpawnCall[] = [];
  mock.module(new URL("../../src/spawn.ts", import.meta.url).href, () => ({
    makeRunId: () => "run-stub",
    spawnSpecialist: async (
      spec: { role: string; prompt: string },
      opts: SpawnOptions = {},
    ) => {
      calls.push({
        role: spec.role,
        prompt: spec.prompt,
        childBoundMs: opts.childBoundMs,
        budgetTurns: opts.budgetTurns,
      });
      return {
        role: spec.role,
        ok: true,
        text: "Checked the inlined diff; nothing in my lane.",
        toolUses: [],
        ms: 10,
        exitCode: 0,
      };
    },
  }));
  return calls;
}

/** A skills dir holding one valid `SKILL.md` per bundled lens, so the roster is
 * healthy and a lens is never blocked for a reason unrelated to the case. */
export function installLensSkills(skills: string): void {
  let prec = 10;
  for (const l of LENS_ROSTER) {
    mkdirSync(path.join(skills, l.skill), { recursive: true });
    writeFileSync(
      path.join(skills, l.skill, "SKILL.md"),
      `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
    );
    prec += 10;
  }
}
