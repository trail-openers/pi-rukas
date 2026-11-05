#!/usr/bin/env bun
/**
 * #1537 — the round cap's carried-row arm fails closed on a blob it cannot
 * fully read.
 *
 * The cap grants the `ci` route only when no row the findings store carried is
 * still open at HIGH or above. That answer is read off the `lens-issues-found`
 * event's `findings` blob, which the verdict site stores TRUNCATED to
 * `MAX_STORED_FINDINGS` rows — and the cut is by severity, not carried-first,
 * with no truncation marker and no total in the JSON. So a blob that filled the
 * cap is indistinguishable from one that shows the whole round, and it is not
 * evidence that nothing at the bar was carried.
 */

import {
  MAX_STORED_FINDINGS,
  noCarriedFindingAtOrAbove,
  parseFindings,
} from "../src/lens-findings-render.ts";
import { noBlockingCarriedFinding } from "../src/work-driver-lens-cap.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A plain (non-carried) row; `severity` defaults to LOW so it blocks nothing. */
const row = (n: number, over: Record<string, unknown> = {}) => ({
  lens: "SECURITY",
  severity: "LOW",
  path: `a${n}.txt`,
  line: 3,
  title: `finding ${n}`,
  ...over,
});
const blob = (rows: unknown[]) => JSON.stringify(rows);

// ------------------------------------------------------- what it may answer

assert(noBlockingCarriedFinding(undefined) === true, "no blob at all → nothing carried");
assert(noBlockingCarriedFinding("   ") === true, "a blank blob → nothing carried");
assert(
  noBlockingCarriedFinding(blob([])) === true,
  "an empty round → nothing carried (the cap's ordinary shape)",
);
assert(
  noBlockingCarriedFinding(blob([row(1), row(2, { severity: "MEDIUM" })])) === true,
  "sub-bar rows are disclosed, not parked on",
);
assert(
  noBlockingCarriedFinding(blob([row(1, { severity: "HIGH" })])) === true,
  "a HIGH from THIS round is not a carried row — the arm asks about carried rows only",
);
assert(
  noBlockingCarriedFinding(blob([row(1, { severity: "HIGH", carried: true })])) === false,
  "a carried HIGH parks",
);
assert(
  noBlockingCarriedFinding(blob([row(1, { severity: "MEDIUM", carried: true })])) === true,
  "a carried MEDIUM is disclosed like any other sub-blocking row",
);

// #2040 — the cap's effect reaches THIS reader through the row's severity, which
// is the only field it reads. The row the store carries for an unproven HIGH is
// stored at MEDIUM with the marker beside it, so the round-cap `ci` route opens
// for a round whose only carried HIGH the harness had already moved — and the
// marker itself never rescues a row still written at HIGH, because this reader
// judges severity and nothing else. Both directions matter: if the cap wrote the
// marker but left the severity, the second case would be the one that broke.
assert(
  noBlockingCarriedFinding(
    blob([row(1, { severity: "MEDIUM", carried: true, severityCapped: "unproven" })]),
  ) === true,
  "#2040: a carried row the cap stored at MEDIUM does not park the round-cap route",
);
assert(
  noBlockingCarriedFinding(
    blob([row(1, { severity: "HIGH", carried: true, severityCapped: "unproven" })]),
  ) === false,
  "#2040: a carried HIGH still blocks even carrying the cap marker — severity decides, not the marker",
);

// ------------------------------------------- unknown severity fails closed

assert(
  noBlockingCarriedFinding(blob([row(1, { severity: "BLOCKER", carried: true })])) === false,
  "canary: a carried row whose severity the driver cannot rank BLOCKS — an unrankable row is never evidence that nothing blocks",
);
// `carried: true` with no `severity` key is the shape the store's own row type
// allows (`StoredFinding.severity?: string`), so the driver must not read the
// absent field as "below the bar". The row helper always writes a severity, so
// delete it here rather than fake a shape the helper would not build.
{
  const noSeverity = row(1, { carried: true }) as Record<string, unknown>;
  delete noSeverity.severity;
  assert(
    noBlockingCarriedFinding(blob([noSeverity])) === false,
    "…and a carried row with NO severity field blocks the same way",
  );
}
assert(
  noBlockingCarriedFinding(blob([row(1, { severity: "high", carried: true })])) === false,
  "a lowercase severity is not a rank the driver can read → blocks",
);
assert(
  noBlockingCarriedFinding(blob([row(1, { carried: "true" })])) === true,
  "carried: \"true\" (a string) is not the store's marker — no row carried it",
);

// ------------------------------------------------- truncation fails closed

assert(
  MAX_STORED_FINDINGS === 50,
  `the storage cap the reader and the writer share is the documented 50 (got ${MAX_STORED_FINDINGS})`,
);

/** `n` rows, all sub-bar, so only the truncation rule can change the answer. */
const many = (n: number) => blob(Array.from({ length: n }, (_, i) => row(i)));

assert(
  noBlockingCarriedFinding(many(MAX_STORED_FINDINGS - 1)) === true,
  "a readable round just under the cap → nothing carried",
);
assert(
  noBlockingCarriedFinding(many(MAX_STORED_FINDINGS)) === false,
  "canary: a blob that FILLED the cap cannot prove nothing was carried — the rows past the cut are lost, the cut is not carried-first and the JSON records no marker or total",
);

// The finding the canary above rests on: the blob's own shape, not a guess.
{
  const full = JSON.stringify(
    Array.from({ length: MAX_STORED_FINDINGS + 5 }, (_, i) =>
      row(i, { severity: "HIGH", carried: true }),
    ).slice(0, MAX_STORED_FINDINGS),
  );
  assert(
    parseFindings(full).length === MAX_STORED_FINDINGS,
    "parseFindings sees at most the cap's rows, so it cannot tell a full round from a truncated one",
  );
  assert(
    !/"total"|"truncated"/i.test(full),
    "…and the stored JSON carries no truncation marker or total to distinguish them",
  );
}

// A blob the driver cannot parse, or whose elements are not rows, is not a pass.
assert(noBlockingCarriedFinding("{not json") === false, "an unparseable blob → blocks");
assert(noBlockingCarriedFinding("{\"a\":1}") === false, "a blob that is not an array → blocks");
assert(
  noBlockingCarriedFinding(blob([row(1), null, "string", 7])) === false,
  "an element that is not an object is not a row the driver can rank → blocks",
);

// The bar is a parameter: the same carried MEDIUM blocks at a MEDIUM bar.
assert(
  noCarriedFindingAtOrAbove(blob([row(1, { severity: "MEDIUM", carried: true })]), "MEDIUM") ===
    false,
  "the shared reader honours the bar it is handed (MEDIUM)",
);
assert(
  noCarriedFindingAtOrAbove(blob([row(1, { severity: "MEDIUM", carried: true })]), "HIGH") ===
    true,
  "…and the same row is sub-blocking at a HIGH bar",
);
assert(
  noCarriedFindingAtOrAbove(many(MAX_STORED_FINDINGS), "HIGH") === false,
  "the truncation rule is in the shared reader, not only in the cap's wrapper",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
