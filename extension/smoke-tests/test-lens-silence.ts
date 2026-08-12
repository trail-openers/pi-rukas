#!/usr/bin/env bun
/**
 * Silence is not approval — the #328 defect class, at the lens gate.
 *
 * A lens whose spawns all FAIL is correctly `blocked`, and one blocked lens
 * makes the whole review `REVIEW_INCOMPLETE` (`lens-review.ts:133`). That half
 * already worked.
 *
 * The gap is the lens that exits 0 and says nothing. `extractFindings` reads
 * `report_finding` tool calls; the lens prompt is explicit that "only the
 * `report_finding` tool calls count" and asks for a prose summary as the final
 * reply. A child that emitted neither — wrong model, dropped reporter
 * extension, out of context, or simply answered "ok" — produced
 * `{findings: [], blocked: false}`, byte-identical to a careful review that
 * genuinely found nothing.
 *
 * So the six-pass review could be a six-way no-op and still report APPROVED,
 * and no operator could tell from the summary. The fix asks for the positive
 * evidence the prompt already requests: zero findings AND no summary is not
 * clean, it is unreviewed.
 */

import type { Finding } from "../src/lens-review-format.ts";
import { type LensRunResult, computeVerdict, lensProducedEvidence } from "../src/lens-review.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const lens = (over: Partial<LensRunResult>): LensRunResult =>
  ({
    lens: "security",
    ok: true,
    ms: 1000,
    findings: [],
    attempts: 1,
    blocked: false,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
  }) as any as LensRunResult;

const finding = (severity: string): Finding =>
  // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  ({ path: "a.ts", title: "x", severity, lens: "security" }) as any as Finding;

// ------------------------------------------- what counts as having reviewed

{
  assert(
    lensProducedEvidence(
      lens({ summary: "Checked auth paths and input handling; nothing exploitable." }),
    ),
    "a lens that wrote a summary reviewed something",
  );
  assert(
    lensProducedEvidence(lens({ findings: [finding("LOW")] })),
    "a lens that reported a finding reviewed something",
  );
  assert(
    !lensProducedEvidence(lens({})),
    "canary: no findings AND no summary is NOT evidence of a review — it read as clean before",
  );
  assert(!lensProducedEvidence(lens({ summary: "   " })), "...whitespace is not a summary");
  assert(
    !lensProducedEvidence(lens({ summary: "(thinking content only - no text output)" })),
    "canary: the thinking-only placeholder is not a summary — it is spawn-collapse-events describing the ABSENCE of output, and counting it would let this exact silence through wearing the right shape",
  );
}

// ----------------------------------------------- the verdict follows suit

{
  const silent = [lens({ lens: "security" }), lens({ lens: "types", summary: "Types check out." })];
  assert(
    computeVerdict([], silent, "MEDIUM") === "REVIEW_INCOMPLETE",
    "canary: one silent lens makes the review INCOMPLETE — six silent lenses used to read APPROVED",
  );

  const spoke = [
    lens({ lens: "security", summary: "No injection paths in the diff." }),
    lens({ lens: "types", summary: "Types check out." }),
  ];
  assert(
    computeVerdict([], spoke, "MEDIUM") === "APPROVED",
    "a review where every lens genuinely reported back is still APPROVED",
  );
}

{
  // The pre-existing paths must be untouched.
  assert(
    computeVerdict([], [lens({ blocked: true })], "MEDIUM") === "REVIEW_INCOMPLETE",
    "a blocked lens still yields REVIEW_INCOMPLETE",
  );
  assert(
    computeVerdict([finding("CRITICAL")], [lens({ summary: "see finding" })], "MEDIUM") ===
      "CRITICAL_ISSUES_FOUND",
    "a CRITICAL finding still decides the verdict",
  );
  assert(
    computeVerdict([], undefined, "MEDIUM") === "APPROVED",
    "omitting lensResults keeps computeVerdict's documented finding-only contract",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
