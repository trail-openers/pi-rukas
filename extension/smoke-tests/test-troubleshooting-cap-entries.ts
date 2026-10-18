#!/usr/bin/env bun
/**
 * #1384 — every cap id has one troubleshooting entry, and no cap id names a
 * clock it is not.
 *
 * The lens-review fix loop's 90-minute budget used to be recorded as
 * `wall-clock`. A host that ends cycles on its own time limit documents a
 * `wall-clock` cap too, so an operator reading `Cap: wall-clock` went to the
 * host's entry, concluded the cycle ran out of the host's budget, and raised a
 * number that was not the problem. The cap is now `lens-review-timeout`, and
 * its reason rides on the cap-hit's `evidence` (so the headless
 * `failure.message`) instead of only in the handoff's prose.
 *
 * The table under "Cap-hit shapes and what to do about each" in
 * docs/troubleshooting.md is the one index: each published cap — every fixed
 * literal and every template family — has exactly one row. A cap added to the
 * vocabulary without a row fails here, which is what keeps later caps (a new
 * `*-timeout`) from landing undocumented.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { CAP_TEMPLATES, FIXED_CAPS } from "../src/headless/caps.ts";
import { failureOf } from "../src/headless/failure.ts";
import { reviewWallClockMs } from "../src/review-budget.ts";
import { appendReviewCapHit } from "../src/work-driver-lens-cap.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { isKnownCap } from "../src/workflow-state-validate-caps.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------------- one row per cap id

const doc = readFileSync(
  path.join(import.meta.dirname, "..", "..", "docs", "troubleshooting.md"),
  "utf8",
);
const start = doc.indexOf("### Cap-hit shapes and what to do about each");
assert(start >= 0, "troubleshooting.md has the cap-hit table section");
const rest = doc.slice(start);
const next = rest.indexOf("\n### ", 4);
const section = next >= 0 ? rest.slice(0, next) : rest;
const rows = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] ?? "");

const params: Record<string, string> = { step: "<step>", count: "<count>" };
const ids = [
  ...FIXED_CAPS,
  ...Object.entries(CAP_TEMPLATES).map(([name, p]) => `${name}:${params[p] ?? `<${p}>`}`),
];
for (const id of ids) {
  const n = rows.filter((r) => r === id).length;
  assert(n === 1, `cap \`${id}\` has exactly one troubleshooting row (found ${n})`);
}
const unknown = rows.filter((r) => !ids.includes(r));
assert(
  unknown.length === 0,
  `every row names a published cap id (stray: ${unknown.join(", ") || "none"})`,
);

// ------------------------------------- the review budget is not `wall-clock`

assert(
  !(FIXED_CAPS as readonly string[]).includes("wall-clock"),
  "canary: pi-rukas publishes no `wall-clock` cap — a host reads that id as its own cycle clock",
);
assert(!isKnownCap("wall-clock"), "...and the state validator no longer accepts it");
assert(isKnownCap("lens-review-timeout"), "`lens-review-timeout` is a known cap");

// -------------------------------- the reason travels with the cap-hit itself

{
  const startedAt = Date.now() - reviewWallClockMs() - 5 * 60_000;
  const state = {
    schemaVersion: 1,
    issue: 7,
    pipelineState: {
      currentStep: "lens-review",
      status: "running",
      reviewRound: 1,
      reviewCapStartedAt: startedAt,
    },
    eventLog: [],
  } as unknown as WorkState;
  const after = await appendReviewCapHit({} as CycleContext, state, 1, "ISSUES_FOUND", "");
  const hit = after.eventLog.at(-1);
  assert(
    hit?.kind === "cap-hit" && hit.cap === "lens-review-timeout" && hit.nextStep === "handoff",
    "over the review budget at the verdict: a `lens-review-timeout` cap-hit routed to handoff",
  );
  const evidence = hit?.kind === "cap-hit" ? (hit.evidence ?? "") : "";
  assert(
    /lens-review fix loop/.test(evidence) &&
      /PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS/.test(evidence) &&
      evidence.includes(`${reviewWallClockMs() / 60_000}-minute`),
    `canary: the verdict-time cap-hit carries its reason as evidence (got ${JSON.stringify(evidence)}) — it had none, so a host's capReason was null`,
  );
  const handed = {
    ...after,
    pipelineState: { ...after.pipelineState, status: "handoff" },
  } as WorkState;
  const failure = failureOf(handed, "lens-review-timeout", "lens-review");
  assert(
    failure?.kind === "timeout" && /lens-review fix loop/.test(failure.message),
    `the headless failure is a timeout whose message is the reason, not the cap name (got ${JSON.stringify(failure?.message)})`,
  );
}

process.exit(exit);
