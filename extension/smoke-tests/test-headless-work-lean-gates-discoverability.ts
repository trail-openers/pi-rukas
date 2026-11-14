#!/usr/bin/env bun
/**
 * The `gates` switch is discoverable, which is the half of the contract a knob has to
 * keep on its own: a field that appears in no inventory is a field no host can code
 * against, and `--capabilities` is how a host asks what this build reads and writes.
 *
 * Split from `test-headless-work-lean-gates.ts` for the size gate, along the seam the
 * file's own sections drew — the projection's readings there, the switch's discoverability
 * here (G8 + G12).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FEATURES } from "../src/headless/capabilities.ts";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// A knob that appears in no inventory is a knob that does not exist: `--capabilities`
// is how a host asks what this build reads and writes, and a field it does not
// mention is a field no host can code against.
{
  assert(
    HEADLESS_FEATURES.leanGates === true,
    "features.leanGates is true on a build that writes the object",
  );
  const names = HEADLESS_INPUTS.map((i) => i.name);
  assert(
    names.includes("PI_ENSEMBLE_LEAN_RESULT_GATES"),
    "HEADLESS_INPUTS lists PI_ENSEMBLE_LEAN_RESULT_GATES",
  );
  // The list's own order is the collation `test-headless-inputs.ts` enforces (the
  // `__`-to-space localeCompare that mostly ignores the separators), not ASCII order —
  // so the new entry has to sit where THAT rule puts it, and this is the same rule, not
  // a second opinion about it.
  assert(
    JSON.stringify(
      [...names].sort((a, b) => a.replace(/_/g, " ").localeCompare(b.replace(/_/g, " "))),
    ) === JSON.stringify(names),
    "HEADLESS_INPUTS stays sorted after the new entry",
  );
  const entry = HEADLESS_INPUTS.find((i) => i.name === "PI_ENSEMBLE_LEAN_RESULT_GATES");
  assert(
    entry?.type === "boolean" && entry.default === true,
    `the entry is a boolean that defaults to on (${JSON.stringify(entry)})`,
  );
  const docText = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "configuration.md"),
    "utf8",
  );
  assert(
    docText.includes("`PI_ENSEMBLE_LEAN_RESULT_GATES`"),
    "docs/configuration.md carries a row for the switch",
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
