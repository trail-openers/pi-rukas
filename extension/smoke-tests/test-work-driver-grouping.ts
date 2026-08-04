#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: PR16: groupIssues() deterministic multi-issue grouping (R1-R5 rules).
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import path from "node:path";
import { MAX_ISSUES_PER_GROUP, groupIssues } from "../src/work-driver-grouping.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// PR16 — groupIssues() deterministic multi-issue grouping.
//
// These tests exercise R1-R5 rules + guardrails against fabricated issue
// bodies. Pure function → no filesystem, no dispatch, no state; the
// tests just call groupIssues() with body maps and assert shape.
{
  // R5 — Default: two unrelated issues get separate groups.
  const r5 = groupIssues([100, 200], {
    100: "title:\t[100] frontend bug\n\nSomething in the UI",
    200: "title:\t[200] backend fix\n\nSomething in the API",
  });
  assert(Object.keys(r5.groups).length === 2, "R5 default: two unrelated issues → two groups");
  assert(
    Object.values(r5.groups).every((g) => g.issues.length === 1),
    "R5 default: each group contains exactly one issue",
  );

  // R1 — Explicit link markers merge issues.
  const r1 = groupIssues([301, 302], {
    301: "title:\tsomething\n\nDepends-on: #302 — needs the API change first",
    302: "title:\tapi change\n\nStandalone body",
  });
  assert(
    Object.keys(r1.groups).length === 1,
    "R1 link: depends-on marker merges the two issues into one group",
  );
  assert(
    r1.notes.some((n) => n.startsWith("R1 link:")),
    "R1 link: notes surfaces the rule that fired",
  );
  const r1Group = Object.values(r1.groups)[0];
  assert(
    r1Group?.issues.length === 2 && r1Group.issues.includes(301) && r1Group.issues.includes(302),
    "R1 link: group carries both issues",
  );

  // R1 variant — "Blocked-by" also merges.
  const r1b = groupIssues([400, 401], {
    400: "Blocked-by: #401\n\nWaiting on the other one",
    401: "Standalone",
  });
  assert(Object.keys(r1b.groups).length === 1, "R1 link: blocked-by marker also merges");

  // R2 — Path overlap ≥ 50% merges.
  //
  // Bodies each list 2 file paths; both share 1 → Jaccard = 1/3 ≈ 0.33
  // (does NOT merge). Bumping to 2/2 shared → Jaccard = 1.0 (merges).
  const r2Merge = groupIssues([500, 501], {
    500: "Fix in src/foo/bar.ts and src/foo/baz.ts",
    501: "Fix in src/foo/bar.ts and src/foo/baz.ts (parallel bug)",
  });
  assert(
    Object.keys(r2Merge.groups).length === 1,
    "R2 path-overlap: identical path sets merge (jaccard=1.0)",
  );
  assert(
    r2Merge.notes.some((n) => n.startsWith("R2 path-overlap:")),
    "R2 path-overlap: notes surfaces the rule",
  );

  const r2NoMerge = groupIssues([600, 601], {
    600: "Fix in src/foo/bar.ts and src/foo/baz.ts and src/foo/qux.ts",
    601: "Fix in src/foo/bar.ts alone",
  });
  assert(
    Object.keys(r2NoMerge.groups).length === 2,
    "R2 path-overlap: below-threshold overlap does NOT merge (jaccard=1/3)",
  );

  // R3 — Explicit Split: marker overrides R1/R2.
  //
  // Both issues have a Depends-on link (would merge under R1), but #700
  // has "Split: true" → R3 forces it into its own group.
  const r3 = groupIssues([700, 701], {
    700: "Depends-on: #701\n\nSplit: true\n\nMust ship separately from the API change",
    701: "Standalone",
  });
  assert(
    Object.keys(r3.groups).length === 2,
    "R3 SPLIT: 'Split: true' marker overrides R1 link — two groups",
  );
  assert(
    r3.notes.some((n) => n.startsWith("R3 split:")),
    "R3 SPLIT: notes surfaces the rule",
  );
  assert(
    r3.notes.some((n) => n.includes('"Split: true"')),
    "R3 SPLIT: notes include the matching text for diagnostics",
  );

  // #312 — Regression: "provider-independent" in body does NOT trigger split.
  const r3NoProvider = groupIssues([710, 711], {
    710: "Depends-on: #711\n\nThis signature was reproduced against Anthropic as well as the self-hosted endpoint, so it is provider-independent.",
    711: "The API change for the counterpart fix",
  });
  assert(
    Object.keys(r3NoProvider.groups).length === 1,
    "#312: 'provider-independent' does NOT trigger R3 split",
  );
  assert(
    !r3NoProvider.notes.some((n) => n.startsWith("R3")),
    "#312: no R3 note for 'provider-independent'",
  );

  // #312 — Regression: "Independent investigation" in body does NOT trigger split.
  const r3NoInvestigation = groupIssues([720, 721], {
    720: "Depends-on: #721\n\nIndependent investigation found the opposite error one step away. A second team independently confirmed the mechanism.",
    721: "The counterpart fix",
  });
  assert(
    Object.keys(r3NoInvestigation.groups).length === 1,
    "#312: 'Independent investigation' does NOT trigger R3 split",
  );

  // R3 — Split: yes also works as explicit marker.
  const r3Yes = groupIssues([730, 731], {
    730: "Split: yes\n\nThis needs its own PR",
    731: "Another issue",
  });
  assert(
    Object.keys(r3Yes.groups).length === 2,
    "R3: 'Split: yes' forces singleton group",
  );

  // R3 — Split: separate also works.
  const r3Separate = groupIssues([740, 741], {
    740: "Split: separate\n\nShips on its own",
    741: "Another issue",
  });
  assert(
    Object.keys(r3Separate.groups).length === 2,
    "R3: 'Split: separate' forces singleton group",
  );

  // R3 — "This work must ship separately" also triggers.
  const r3Full = groupIssues([750, 751], {
    750: "Depends-on: #751\n\nThis work must ship separately",
    751: "The other part",
  });
  assert(
    Object.keys(r3Full.groups).length === 2,
    "R3: 'This work must ship separately' forces singleton group",
  );

  // R3 — "split" mid-prose (e.g. "we split the function") does NOT trigger.
  const r3MidProse = groupIssues([760, 761], {
    760: "We split the function into two parts and fixed the bug",
    761: "Another issue",
  });
  assert(
    Object.keys(r3MidProse.groups).length === 2,
    "R3: 'split' mid-prose does NOT trigger (no explicit marker)",
  );

  // R4 — Subsystem tag prefix in title merges.
  const r4 = groupIssues([800, 801, 802], {
    800: "[frontend] fix broken button\n\nBody",
    801: "[frontend] fix another button\n\nBody",
    802: "[docs] typo fix\n\nBody",
  });
  assert(
    Object.keys(r4.groups).length === 2,
    "R4 subsystem: [frontend] merges, [docs] stays separate → 2 groups",
  );
  const r4Front = Object.values(r4.groups).find((g) => g.issues.length === 2);
  assert(
    r4Front?.issues.includes(800) && r4Front?.issues.includes(801),
    "R4 subsystem: frontend group carries both 800 and 801",
  );

  // #282 — R4 anchor + trailing-space guard.
  // Mid-line bracketed tokens (like #[ignore] in a Rust title) must NOT
  // be promoted to subsystem tags.
  const r4MidLine = groupIssues([810, 811], {
    810: "fix #[ignore] ratchet skipping tests\n\nBody with #[ignore] references",
    811: "re-enable #[ignore] tests that were falsely passing\n\nAlso mentions #[ignore]",
  });
  assert(
    Object.keys(r4MidLine.groups).length === 2,
    "R4 anchor: mid-line #[ignore] does NOT union (2 separate groups)",
  );
  assert(
    !r4MidLine.notes.some((n) => n.startsWith("R4")),
    "R4 anchor: no R4 note emitted for mid-line brackets",
  );

  // #282 — leading bracketed token with no trailing space does NOT match.
  const r4NoSpace = groupIssues([820, 821], {
    820: "[ignore]text without space\n\nBody",
    821: "[ignore]more text\n\nBody",
  });
  assert(
    Object.keys(r4NoSpace.groups).length === 2,
    "R4 trailing-space: [ignore]text (no space after ]) does NOT union",
  );

  // #282 — "title:" header prefix from plain `gh issue view` is tolerated.
  const r4TitlePrefix = groupIssues([830, 831], {
    830: "title:\t[backend] add auth middleware\n\nBody",
    831: "title:    [backend] add rate limiter\n\nBody",
  });
  assert(
    Object.keys(r4TitlePrefix.groups).length === 1,
    "R4 title-prefix: 'title:' header is stripped before tag match → 1 group",
  );
  assert(
    r4TitlePrefix.notes.some((n) => n.startsWith("R4 subsystem:")),
    "R4 title-prefix: notes confirm the R4 rule fired",
  );

  // #282 — regression: [frontend] at line start still unions (no regression).
  const r4Regression = groupIssues([840, 841], {
    840: "[frontend] fix button click\n\nBody",
    841: "[frontend] fix button hover\n\nBody",
  });
  assert(
    Object.keys(r4Regression.groups).length === 1,
    "R4 regression: [frontend] at line start still unions → 1 group",
  );

  // Guardrail — MAX_ISSUES_PER_GROUP splits oversized components.
  //
  // Four issues all linked pairwise via depends-on → one component.
  // MAX_ISSUES_PER_GROUP = 3, so the group of 4 splits into singletons.
  const oversized = groupIssues([900, 901, 902, 903], {
    900: "Depends-on: #901 Depends-on: #902 Depends-on: #903",
    901: "",
    902: "",
    903: "",
  });
  assert(
    Object.keys(oversized.groups).length === 4,
    `guardrail: component > ${MAX_ISSUES_PER_GROUP} splits into singletons`,
  );
  assert(
    oversized.notes.some((n) => n.includes("guardrail split")),
    "guardrail: notes explains the split",
  );

  // Deterministic ordering — same input → same output, group ids in
  // stable order.
  const runA = groupIssues([10, 20, 30], { 10: "", 20: "", 30: "" });
  const runB = groupIssues([10, 20, 30], { 10: "", 20: "", 30: "" });
  assert(
    JSON.stringify(runA) === JSON.stringify(runB),
    "deterministic: same input → identical output",
  );

  // K=1 short-circuit — returns one "default" group.
  const k1 = groupIssues([42], { 42: "body" });
  assert(
    Object.keys(k1.groups).length === 1 && k1.groups.default?.issues[0] === 42,
    "K=1: short-circuits to a single default group",
  );

  // K=0 — empty active list.
  const k0 = groupIssues([], {});
  assert(Object.keys(k0.groups).length === 0, "K=0: empty active list yields empty groups");

  // Missing body — grouping falls back to R5 (separate groups).
  const noBody = groupIssues([1, 2], { 1: "", 2: "" });
  assert(
    Object.keys(noBody.groups).length === 2,
    "missing bodies: fall back to R5 (separate groups)",
  );

  // Fanout mode — K ≤ 2 = parallel; K > 2 = sequential batches.
  const fanoutSmall = groupIssues([1, 2], { 1: "body A", 2: "body B" });
  assert(
    fanoutSmall.fanout.mode === "parallel" && fanoutSmall.fanout.concurrencyCap >= 1,
    "fanout: K=2 → parallel mode",
  );
  const fanoutBig = groupIssues([1, 2, 3, 4, 5], { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" });
  assert(fanoutBig.fanout.mode === "sequential", "fanout: K > cap (2) → sequential mode");

  // Group id convention — group-a, group-b, ... in order.
  const twoGroups = groupIssues([1000, 2000], { 1000: "unrelated", 2000: "also unrelated" });
  assert(
    Object.keys(twoGroups.groups).sort().join(",") === "group-a,group-b",
    "group id convention: group-a, group-b",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
