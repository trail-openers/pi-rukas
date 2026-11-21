#!/usr/bin/env bun
/**
 * lean/specify — the runner probe's containment switch as a truth table (#2202).
 *
 * It defaults ON, which means a mistake in it is a mistake every lean run pays for,
 * and the behaviour cases in the sibling files are green in
 * exactly one of the four cells. So the switch is read across the whole table —
 * unset, `''`, `'0'`, `'1'`, `'false'`, `'NO'`, `' 0 '` — through the production
 * reader and nothing else: `'0'` must be the ONLY value that turns it off, since
 * `"0"` is what an operator reaches for, and everything else must leave the shipped
 * behaviour in place, including values a shell mangled on the way in.
 *
 * The `specify`-level consequences of the same table — what a run DOES differently
 * when the switch is off — are pinned in `test-lean-specify-preflight-py.ts` (the
 * probe name, the exit-4 disclosure) and `test-lean-specify-preflight-contain.ts`
 * (the off arm writing through the link, which is what makes the on arm's refusal
 * evidence rather than a stub that never writes).
 */

import { CELLS, CONTAIN_KEY, READERS, checkSwitch } from "./lib/lean-preflight-switch-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The table itself is part of what is pinned: a cell quietly dropped from the
// shared fixture would turn every switch file green again.
assert(
  CELLS.length === 7 && CELLS.some((c) => c[1] === "0" && c[2] === false),
  "(t) the shared table covers seven values and exactly one of them is the off value",
);

for (const [key, read] of Object.entries(READERS)) {
  const { ok } = checkSwitch({ name: key, read, key, assert });
  if (!ok) exit = 1;
}

process.exit(exit);
