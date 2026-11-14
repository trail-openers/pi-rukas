#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED` switch is documented, and off ONLY on
 * `"0"`.
 *
 * The same three things its sibling switch's file pins for the rewind lease
 * (`test-lean-rewind-lease-binds-switch.ts`), because the same failure mode
 * applies to a knob whose off arm is a force-push guard:
 *
 *   - the `docs/configuration.md` row — a `HEADLESS_INPUTS` entry nobody can
 *     discover is a knob that does not exist, and `test-headless-inputs.ts`
 *     checks the roster against the readers without ever opening `docs/`;
 *   - the truth table on the exported reader: on for unset, `"1"`, `""` and
 *     `"false"`, off for the literal `"0"` alone;
 *   - the sentence on the docs row that says WHAT the on arm does, so the knob is
 *     understandable from the docs alone rather than from this file.
 *
 * What makes this switch different from the rewind one is what its off arm
 * restores: the pre-fix guard skipped its mainline rule whenever the mainline
 * could not be read, which is the fail-open #2255 is a fix for. `docs/lean.md`
 * names both halves — the origin probe and the refusal — so the row is not the
 * only place a reader learns the policy.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an
 * operator's exported `=0`, would otherwise make the ON cases measure the wrong
 * arm.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanGuardFailClosed } from "../src/lean/guard-fail-closed-switch.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED",
  );
  // The row has to state the mechanism, not just name the knob: an operator who
  // sets `=0` is putting a fail-OPEN back on a force-push guard, and should read
  // that from the row rather than from the source.
  assert(
    doc.includes("ls-remote") && doc.includes("fail"),
    "and that row says the guard probes origin with ls-remote and refuses when that fails too, so the knob is understandable from the docs alone",
  );
}

{
  // The engine guide is where a reader learns what the publish guard checks; it
  // must say the guard asks origin, and name the switch.
  const lean = docs("lean.md");
  assert(
    lean.includes("PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED"),
    "docs/lean.md names the switch in the publishable-branch section",
  );
  for (const needle of ["mainline", "origin", "refus"]) {
    assert(
      lean.includes(needle),
      `and the section states what the guard decides, which a reader needs: "${needle}"`,
    );
  }
}

await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED: value }, async () => {
      assert(
        leanGuardFailClosed() === want,
        `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
