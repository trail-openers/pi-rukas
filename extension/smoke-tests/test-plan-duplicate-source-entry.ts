#!/usr/bin/env bun
/**
 * #1856 review round 4 (lens HIGH) — the post-filter's ENTRY is what decides
 * whether a plan has a subject at all.
 *
 * `downgradeSelfDuplicate` used to test only `sourceIssue === undefined`, and
 * `sourceIssue` reaches it through the investigation cache and session replay,
 * where a JSON `null` is not `undefined`. A `null` source compares unequal to
 * every named issue, so rule 1 attributed nothing to a subject and a HIGH that
 * halts on main became a filed medium on a plan with no ticket. The entry now
 * requires a positive safe integer, so every other shape downgrades NOTHING.
 *
 * Driven directly against `downgradeSelfDuplicate` rather than through the
 * barrier, which types `sourceIssue` as `number | undefined` and cannot carry a
 * `null` — the exact shape the cache read produces.
 */

import type { DuplicateRisk } from "../src/plan-investigate.ts";
import type { KnownIssue } from "../src/plan-duplicate-self.ts";
import { downgradeSelfDuplicate } from "../src/plan-duplicate-self.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_FORGE = "none";

const known = new Map<number, KnownIssue>([
  [1856, { state: "OPEN", title: "duplicate check names its own issue" }],
  [103, { state: "CLOSED", title: "landed hybrid default" }],
]);

/** A HIGH that rules 1 and 5 would downgrade if a source issue were believed. */
/**
 * A HIGH that rule 1 WOULD downgrade once a subject is believed: every issue it
 * names is the subject's own split child. Round 5 deleted the CLOSED-prior-art
 * rule, so a reply naming #103 — however the child described it — is no longer a
 * downgradeable verdict, and the control has to be a shape the surviving subject
 * rule still suppresses. Otherwise the control is indistinguishable from the
 * rows above it and the entry guard would pass having tested nothing.
 */
const high: DuplicateRisk = {
  level: "high",
  rationale: "DUPLICATE_RISK: high — duplicates the plan's own split child #1856-2 verbatim",
};

for (const bad of [null, 0, -3, 1.5, Number.NaN, 2 ** 53]) {
  const out = downgradeSelfDuplicate(high, {
    sourceIssue: bad as unknown as number,
    known,
    fullText: high.rationale,
  });
  assert(
    out.level === "high" && out.downgradedFrom === undefined && out.excludedIssues === undefined,
    `a sourceIssue of ${JSON.stringify(bad)} downgrades nothing — the HIGH stands (${out.level})`,
  );
}

{
  // The control: the same verdict with a real source issue does downgrade, so the
  // rows above fail on the entry guard and not on some unrelated property of the
  // input (a filter that never downgraded anything would pass every row above).
  const ok = downgradeSelfDuplicate(high, { sourceIssue: 1856, known, fullText: high.rationale });
  assert(
    ok.level === "medium" &&
      (ok.excludedIssues ?? []).map((e) => e.number).join(",") === "1856",
    `control: the same verdict with a positive safe-integer sourceIssue downgrades (${ok.level})`,
  );
}

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-duplicate-source-entry`);
process.exit(exit);
