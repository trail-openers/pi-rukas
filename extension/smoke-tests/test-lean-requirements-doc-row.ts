#!/usr/bin/env bun
/**
 * The requirement lever's operator-facing surface: one env var, one docs row,
 * one headless input.
 *
 * AC4 of the issue is that `PI_ENSEMBLE_LEAN_REQUIREMENTS` is documented. This
 * checks the three places its name must appear and must agree:
 *
 *   (a) `docs/configuration.md` carries a row naming the variable, saying it is
 *       off by default, and saying what turns it on does — a row that merely
 *       repeats the name is not documentation;
 *   (b) `HEADLESS_INPUTS` lists it, so the headless contract and `--capabilities`
 *       agree with what `requirementsEnabled` actually reads (the companion test
 *       `test-headless-inputs.ts` holds the full roster invariant; this is the
 *       row this feature added);
 *   (c) the switch itself only accepts the exact `"1"` — the convention the other
 *       lean levers in this family follow, and the one a bench script cannot get
 *       wrong by exporting `true`, `yes`, or an empty string.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { requirementsEnabled } from "../src/lean/requirements-switch.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const docs = readFileSync(join(here, "..", "..", "docs", "configuration.md"), "utf8");

// ── (a) the docs row ──────────────────────────────────────────────────────────
const rows = docs
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.includes("PI_ENSEMBLE_LEAN_REQUIREMENTS"));
assert(rows.length > 0, "docs/configuration.md names PI_ENSEMBLE_LEAN_REQUIREMENTS");
// One row, in a table: the pipe-delimited form every other knob in this file uses.
const row = rows.find((line) => line.startsWith("|")) ?? "";
assert(row !== "", "the mention is a table row, like every other knob in the file");
assert(
  row.includes("`PI_ENSEMBLE_LEAN_REQUIREMENTS`"),
  "the row sets the name in code, so a reader can copy it",
);
// The row states its own default and, in its prose, that anything but `1` leaves
// the shipped behaviour in place. Both halves are required: a bare `unset` cell
// without the prose would not tell a reader the off state is the release's.
assert(row.includes("| unset |"), `the row's default column says unset (${row.slice(0, 80)})`);
assert(
  /is off|off is byte-identical/i.test(row),
  "the row states in prose that the unset state is off",
);
assert(
  /requirement/i.test(row) && /(red|coverage|test)/i.test(row),
  `the row says what the lever does, not just its name (${row})`,
);
// The value the switch actually accepts, stated: a row that said "set it" would
// document a lever that never turns on for the operator who follows it.
assert(
  row.includes("=1") || row.includes("`1`"),
  `the row states the value that turns it on (${row})`,
);

// ── (b) the headless roster ───────────────────────────────────────────────────
const listed = HEADLESS_INPUTS.find((i) => i.name === "PI_ENSEMBLE_LEAN_REQUIREMENTS");
assert(listed !== undefined, "HEADLESS_INPUTS lists the variable");
assert(
  listed?.type === "boolean" && listed.default === false,
  `the roster declares it as a boolean that defaults to off (got ${String(listed?.type)}/${String(listed?.default)})`,
);

// ── (c) the switch's own acceptance ───────────────────────────────────────────
assert(requirementsEnabled({ PI_ENSEMBLE_LEAN_REQUIREMENTS: "1" }), "1 turns the lever on");
for (const off of ["", "0", "true", "yes", " on ", "2", undefined]) {
  assert(
    !requirementsEnabled({ PI_ENSEMBLE_LEAN_REQUIREMENTS: off }),
    `${JSON.stringify(off ?? "(unset)")} does NOT turn the lever on`,
  );
}
assert(
  requirementsEnabled() === (process.env.PI_ENSEMBLE_LEAN_REQUIREMENTS === "1"),
  "with no argument the switch reads the process environment it documents",
);

process.exit(exit);
