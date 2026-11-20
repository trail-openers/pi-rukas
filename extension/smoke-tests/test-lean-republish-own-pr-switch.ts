#!/usr/bin/env bun
/**
 * The `PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR` switch: what it reaches, and that `0` is
 * today's behaviour.
 *
 * Three things an operator and a later edit both need, asserted here and nowhere else:
 *
 *   (docs) the knob is discoverable where an operator looks — a `docs/configuration.md`
 *       row and a sentence on `docs/lean.md`'s `publish` row. `test-headless-inputs.ts`
 *       pins that `HEADLESS_INPUTS` LISTS the name and that its default agrees with the
 *       live reader, and never opens `docs/` at all, so a roster row with no prose
 *       anywhere is a knob nobody can find — the state this section refuses to ship;
 *   (truth table) on for unset, `"1"`, `""` and `"false"`; off for the literal `"0"` —
 *       read at CALL time, so a pin leaked from another file in this process cannot
 *       make an ON case measure the off arm;
 *   (the exemption's own shape) the row that says what the knob actually reaches: it
 *       admits a push over the run's OWN PR, and the fail-closed reading of PR STATE is
 *       not the knob's to loosen.
 *
 * The call shape each arm produces is not checked here —
 * `test-lean-republish-own-pr-off-arm.ts` pins it against a literal transcription of
 * the pre-fix check, which is the only way the off arm can be caught drifting rather
 * than agreeing with itself.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { leanRepublishOwnPrEnabled } from "../src/lean/republish-own-pr-switch.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const SELF = "test-lean-republish-own-pr-switch.ts";
const check = (cond: boolean, msg: string): void => assert(cond, `${SELF}: ${msg}`);

const docs = (file: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", "..", "docs", file), "utf8");

{
  const doc = docs("configuration.md");
  check(
    doc.includes("`PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR`"),
    "docs/configuration.md carries a row for PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR",
  );
  // The row has to name the three reads the exemption compares, or an operator cannot
  // tell from the docs what they are switching off.
  check(
    doc.includes("publishedHead") && doc.includes("prUrl"),
    "and that row names the two record fields the own-PR check compares",
  );
  check(
    doc.includes("force-with-lease"),
    "and that row says the push stays leased to the sha it read",
  );
  // The fail-closed reading of PR state is a neighbour's rule, and a row that let a
  // reader think this knob loosens it would misstate the safety property.
  check(
    (doc.split("PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR")[1] ?? "").includes("fail-closed"),
    "and that row states the fail-closed reading of PR state is untouched by this knob",
  );

  const lean = docs("lean.md");
  check(
    lean.includes("PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR"),
    "docs/lean.md names the switch on the publish step it governs",
  );
}

await withEnv({ PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR: undefined }, async () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, true],
    ["1", true],
    ["", true],
    ["false", true],
    ["0", false],
  ];
  for (const [value, want] of cases) {
    await withEnv({ PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR: value }, async () => {
      check(
        leanRepublishOwnPrEnabled() === want,
        `PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR=${JSON.stringify(value)} reads ${String(want)}`,
      );
    });
  }
});

// Read at CALL time, not at module load: a second read after the pin is lifted must
// report the default again, which is what makes the two arms pinnable in one process.
await withEnv({ PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR: "0" }, async () => {
  check(leanRepublishOwnPrEnabled() === false, "off while pinned");
});
check(leanRepublishOwnPrEnabled() === true, "back on once the pin is lifted (a call-time read)");

console.log(
  `\n${failures() === 0 ? "switch green" : "switch RED"} (${String(failures())} failing)`,
);
process.exit(failures());
