#!/usr/bin/env bun
/**
 * #2284 — `PI_ENSEMBLE_FORGE_READ_OFF_GUARD` is documented, and off ONLY on `"0"`.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere
 * else: the `docs/configuration.md` row (a `HEADLESS_INPUTS` entry nobody can
 * discover is a knob that does not exist — `test-headless-inputs.ts` checks the
 * roster against the readers and never opens `docs/`), the truth table on the
 * exported reader (on for unset, `"1"`, `""` and `"false"`; off for the literal
 * `"0"`), and a row that states what the knob actually reaches, so the operator who
 * sets `=0` reads — from the docs alone — that they are letting the parent shell
 * `gh` for a child again while the forge is off.
 *
 * The reader is read at CALL time, so every case pins the environment with
 * `withEnv`: a pin that leaked from another file in the same run, or an operator's
 * exported `=0`, would otherwise make the ON cases measure the wrong arm. The
 * broker-level effect of each arm is pinned by `test-forge-read-off-arm.ts`, which
 * compares the off arm against a committed pre-fix call log — the only way the off
 * arm can be caught drifting rather than agreeing with itself.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { forgeReadOffGuardEnabled } from "../src/forge-read-off-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  assert(
    doc.includes("`PI_ENSEMBLE_FORGE_READ_OFF_GUARD`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_FORGE_READ_OFF_GUARD",
  );
  // The row has to name what the knob guards and what turning it off costs, not
  // just the name: an operator who sets `=0` is letting the parent run `gh` for a
  // helper child on a forge they turned off, and should read that from the row.
  assert(
    doc.includes("forge_read") && doc.includes("broker"),
    "and that row names what it guards: the parent's forge_read broker",
  );
  assert(
    doc.includes("the forge is off: PI_ENSEMBLE_FORGE=none"),
    "and that row carries the refusal's exact text, which is the child-facing contract",
  );
  assert(
    doc.includes("git config --get remote.") || doc.includes("git remote"),
    "and that row names the remote reads the off value forbids, so the knob's cost is legible",
  );
  assert(
    doc.includes("forgeReadOffGuardEnabled") && doc.includes("forge-read-off-switch.ts"),
    "and that row names its reader and its module",
  );
  assert(
    doc.includes("forgeEnvIsOff") && doc.includes("forge-off.ts"),
    "and that row says the off decision is one shared predicate, not a second literal",
  );
  // The socket is the neighbour's behaviour, and a row that let a reader think this
  // knob suppresses the bind would make the two promises unverifiable.
  assert(
    doc.includes("socket still binds"),
    "and that row says the socket still binds, so a reader does not expect the tool to vanish",
  );
}

await withEnv({ PI_ENSEMBLE_FORGE_READ_OFF_GUARD: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_FORGE_READ_OFF_GUARD: value }, async () => {
      assert(
        forgeReadOffGuardEnabled() === want,
        `PI_ENSEMBLE_FORGE_READ_OFF_GUARD=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
  // The call-time read, pinned in one process: two arms measured back to back
  // with no re-import between them. A module-load read would report the first
  // value for both and the suite would agree with itself.
  await withEnv({ PI_ENSEMBLE_FORGE_READ_OFF_GUARD: "0" }, async () => {
    const off = forgeReadOffGuardEnabled();
    await withEnv({ PI_ENSEMBLE_FORGE_READ_OFF_GUARD: undefined }, async () => {
      const on = forgeReadOffGuardEnabled();
      assert(
        off === false && on === true,
        `the guard is read at CALL time, not at module load (off arm ${String(off)}, on arm ${String(on)})`,
      );
    });
  });
});

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
