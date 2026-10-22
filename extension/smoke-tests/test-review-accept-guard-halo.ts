#!/usr/bin/env bun
/**
 * #1764 — the halo corpus is the guard's regression evidence, so it is asserted.
 *
 * The harvest (see `review-accept-guard-halo-cases.ts`) recorded 6,645 refusals of
 * ordinary agent bash on one live host. The tables were produced by RUNNING every row
 * through the guard at the base commit this issue branched from and through the guard
 * as it stands, so each table is a claim about behaviour, not a list of strings:
 *
 *  - ≥30 rows the base commit refused must be allowed now — that is the over-refusal
 *    the issue was filed for. A narrowing that fixed nothing keeps this red.
 *  - every row allowed at base must still be allowed — the #1665 regression guard, since
 *    a scope fix that quietly re-widens elsewhere shows up here first.
 *  - every KEEP-REFUSED row must still be refused — the row that names the store or the
 *    operator script is the guard's whole reason to exist, and without this assertion
 *    the two tables above could be satisfied by deleting the guard.
 *  - every row that is STILL refused says WHICH scope clause refuses it, and that clause
 *    must be the one recorded — an accepted cost whose reason silently changes is a
 *    different cost, and the corpus is where that would be caught.
 */
import { reviewAcceptVerdict } from "../src/review-accept-guard.ts";
import {
  HALO_RED_TO_GREEN,
  HALO_STILL_REFUSED_BY_CLAUSE,
} from "./review-accept-guard-halo-cases.ts";
import {
  HALO_ALREADY_ALLOWED_AT_BASE,
  HALO_KEEP_REFUSED,
} from "./review-accept-guard-halo-refusals.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

assert(
  HALO_RED_TO_GREEN.length >= 30,
  `corpus: at least 30 harvested rows went refused → allowed (got ${HALO_RED_TO_GREEN.length})`,
);

for (const t of HALO_RED_TO_GREEN) {
  const v = reviewAcceptVerdict(t.c);
  assert(
    v === undefined,
    `harvested over-refusal now allowed (x${t.count}, class ${t.cls}) — ${t.c.slice(0, 72)}${
      v ? ` [refused by clause ${v.clause}: ${v.reason.slice(0, 60)}]` : ""
    }`,
  );
}

for (const t of HALO_ALREADY_ALLOWED_AT_BASE) {
  const v = reviewAcceptVerdict(t.c);
  assert(
    v === undefined,
    `allowed at base and still allowed — ${t.c.slice(0, 72)}${
      v ? ` [refused by clause ${v.clause}]` : ""
    }`,
  );
}

for (const t of HALO_KEEP_REFUSED) {
  const v = reviewAcceptVerdict(t.c);
  assert(
    v !== undefined,
    `KEEP-REFUSED row still refused (class ${t.cls}) — ${t.c.slice(0, 72)}`,
  );
  assert(
    (v?.reason ?? "").includes("review findings store"),
    `KEEP-REFUSED refusal names the store — ${t.c.slice(0, 72)}`,
  );
}

for (const t of HALO_STILL_REFUSED_BY_CLAUSE) {
  const v = reviewAcceptVerdict(t.c);
  assert(
    v?.clause === t.clause,
    `accepted cost still refused by ${t.clause} — ${t.c.slice(0, 72)}${
      v ? ` [got ${v.clause}]` : " [it is now ALLOWED]"
    }`,
  );
}

console.log(
  `halo corpus: ${HALO_RED_TO_GREEN.length} red→green, ${HALO_ALREADY_ALLOWED_AT_BASE.length} already allowed, ${HALO_KEEP_REFUSED.length} kept refused, ${HALO_STILL_REFUSED_BY_CLAUSE.length} accepted costs`,
);
process.exit(exit);
