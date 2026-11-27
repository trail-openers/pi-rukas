#!/usr/bin/env bun
/**
 * The OFF arm of `PI_ENSEMBLE_LEAN_REQUEST_STALL` against bytes captured before the switch existed.
 *
 * `test-lean-request-stall-off-arm.ts` compares two runs of this tree, which proves the switch takes
 * the lever out but not that what remains is the pre-change tree. This suite is that evidence: the
 * drive in `lib/lean-request-stall-golden.ts` ran once inside a worktree of the base commit the
 * capture names, and here, and the three surfaces of each cell — the step's whole outcome record (key
 * order included), the handback cause line and the headless `failure` — must match byte for byte.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { STALL_GOLDEN, type StallGoldenCell, driveStallOffArm } from "./lib/lean-request-stall-golden.ts";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    failed = 1;
  }
}

const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, STALL_GOLDEN), "utf8")) as {
  capturedFrom: string;
  cells: Record<string, StallGoldenCell>;
};
assert(
  /^[0-9a-f]{40}$/.test(golden.capturedFrom),
  `(fixture) the capture names the commit it was taken from (${golden.capturedFrom})`,
);
assert(
  golden.cells.turns?.failure !== null && golden.cells.quiet?.failure === null,
  "(fixture) the capture holds a budget-stopped cell with a failure and a clean cell without one",
);

const live = await driveStallOffArm();
for (const name of Object.keys(golden.cells)) {
  for (const surface of ["outcome", "needed", "failure"] as const) {
    const want = JSON.stringify(golden.cells[name]?.[surface]);
    const got = JSON.stringify(live[name]?.[surface]);
    assert(
      got === want,
      `(${name}) with the switch at 0 the ${surface} matches the pre-change capture byte for byte${got === want ? "" : ` — want ${want}, got ${got}`}`,
    );
  }
}

process.exit(failed);
