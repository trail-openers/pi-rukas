#!/usr/bin/env bun
/**
 * /research wigolo fallback (#773) — offline: the classifier, the selector
 * matrix, the angle→surface map, and the dispatch-time line.
 *
 * The driver-level blocks (stubbed dispatch / runResearchPipeline) live in
 * test-research-fallback-driver.ts.
 */

import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  classifyParallelOutcome,
  researchFallbackLine,
  selectFallback,
  surfaceForAngle,
  type FallbackDecision,
  type ParallelOutcome,
  type WigoloSurface,
} from "../src/research-fallback.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- classifier

{
  assert(
    classifyParallelOutcome("Insufficient credit") === "credit-exhausted",
    "classifier: verbatim `Insufficient credit` → credit-exhausted (the anchor)",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: credit-exhausted") === "credit-exhausted",
    "classifier: token via the marker",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: auth-missing") === "auth-missing",
    "classifier: auth-missing",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: network-failed") === "network-failed",
    "classifier: network-failed",
  );
  assert(
    classifyParallelOutcome("blocked_by_challenge") === "network-failed",
    "classifier: wigolo blocked_by_challenge → network-failed, NOT empty",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: empty-result") === "empty-result",
    "classifier: empty-result",
  );
  assert(classifyParallelOutcome("parallel-outcome: success") === "success", "classifier: success");
  assert(
    classifyParallelOutcome("parallel-outcome: success\nthe request got HTTP 401 from upstream") ===
      "success",
    "classifier: `success` marker beats a bare 401 in the prose (marker is authoritative)",
  );
  assert(
    classifyParallelOutcome("parallel-outcome: garbage-token") === "unparseable",
    "classifier: marker outside the six-token set is treated as absent",
  );
  assert(
    classifyParallelOutcome("the network latency was high but the fetch succeeded") ===
      "unparseable",
    "classifier: prose mentioning 'network latency' with no marker → unparseable",
  );
  assert(
    classifyParallelOutcome("the endpoint answered HTTP 401, retrying") === "unparseable",
    "classifier: prose mentioning 'HTTP 401' with no marker → unparseable",
  );
  assert(
    classifyParallelOutcome("a parallel task got cancelled mid-stream") === "unparseable",
    "classifier: prose mentioning the token 'parallel' is not a marker",
  );
  assert(
    classifyParallelOutcome("") === "unparseable",
    "classifier: empty → unparseable (never success)",
  );
  assert(
    classifyParallelOutcome("totally unrelated prose") === "unparseable",
    "classifier: no anchor → unparseable",
  );
  // Last occurrence wins (readMarker doctrine, #408): a musing earlier in
  // the reply must not be read as the outcome.
  const both = "parallel-outcome: success\n...\nparallel-outcome: credit-exhausted";
  assert(
    classifyParallelOutcome(both) === "credit-exhausted",
    "classifier: last parallel-outcome marker wins",
  );
  // An unanchored mention of a class word in prose is NOT a classification.
  assert(
    classifyParallelOutcome("the credit card API is fine") === "unparseable",
    "classifier: unanchored prose mentioning 'credit' → unparseable",
  );
}

// ----------------------------------------------------------------- selector

{
  const on = true;
  assert(
    selectFallback("credit-exhausted", "search", on) === "fall-back-to-wigolo",
    "selector: credit → fall-back",
  );
  assert(
    selectFallback("auth-missing", "fetch", on) === "fall-back-to-wigolo",
    "selector: auth → fall-back",
  );
  assert(
    selectFallback("network-failed", "research", on) === "fall-back-to-wigolo",
    "selector: network → fall-back",
  );
  assert(
    selectFallback("success", "search", on) === "keep-parallel",
    "selector: success → keep (no re-dispatch of a success)",
  );
  assert(
    selectFallback("empty-result", "search", on) === "keep-parallel",
    "selector: empty result is a valid answer → keep, NEVER fall back",
  );
  assert(
    selectFallback("unparseable", "search", on) === "keep-parallel",
    "selector: unparseable → keep (never success, never a trigger)",
  );
  assert(
    selectFallback("credit-exhausted", "search", false) === "keep-parallel",
    "selector: flag 0 → never fall back",
  );
  assert(
    selectFallback("auth-missing", "search", false) === "keep-parallel",
    "selector: flag 0 → never (auth)",
  );
  assert(
    selectFallback("network-failed", "search", false) === "keep-parallel",
    "selector: flag 0 → never (network)",
  );
  // Non-web angles (monitor / findall / enrichment) map to `none` via
  // surfaceForAngle — the selector's surface is WigoloSurface, so they
  // arrive here as "none".
  for (const angle of ["monitor", "findall", "enrichment"] as const) {
    assert(
      surfaceForAngle(angle) === "none",
      `surface: ${angle} angle → none (no wigolo equivalent)`,
    );
  }
  // #896 — custom-N PM angles are web-capable (the dominant recent pattern
  // was custom angles that never got the #773 fallback):
  assert(
    surfaceForAngle("custom-1") === "search",
    "surface: custom-N angle → search (web-capable, #896)",
  );
  assert(
    surfaceForAngle("custom-42") === "search",
    "surface: custom-N (any N) → search",
  );
  assert(
    selectFallback("credit-exhausted", "search", true) === "fall-back-to-wigolo",
    "selector: custom angle credit-exhausted → fall-back-to-wigolo",
  );
  assert(
    selectFallback("network-failed", "search", true) === "fall-back-to-wigolo",
    "selector: custom angle network-failed → fall-back-to-wigolo",
  );
  assert(
    selectFallback("unparseable", "search", true) === "keep-parallel",
    "selector: custom angle unparseable → keep (never a trigger)",
  );
  assert(
    selectFallback("success", "search", true) === "keep-parallel",
    "selector: custom angle success → keep",
  );
  assert(
    selectFallback("credit-exhausted", "none", false) === "keep-parallel",
    "selector: flag 0 beats even no-fallback",
  );
}

// ----------------------------------------------------------- surface map

{
  assert(surfaceForAngle("web-current") === "search", "surface: web-current → search");
  assert(surfaceForAngle("adoption-signals") === "search", "surface: adoption-signals → search");
  assert(surfaceForAngle("adoption-alternatives") === "search", "surface: alternatives → search");
  assert(surfaceForAngle("docs-depth") === "fetch", "surface: docs-depth → fetch");
  assert(surfaceForAngle("deep-dive") === "research", "surface: deep tier → research");
  assert(surfaceForAngle("codebase") === "none", "surface: codebase angle → none (no re-dispatch)");
  // #896 mandated change: custom-N was `none`, now the web (search) surface.
  assert(surfaceForAngle("custom-1") === "search", "surface: custom-N angle → search (was none, #896)");
  assert(surfaceForAngle("mystery-angle") === "none", "surface: unknown angle → none, not search");
  assert(
    selectFallback("credit-exhausted", "none", true) === "no-fallback-available",
    "selector: surface none → no-fallback-available",
  );
  assert(
    selectFallback("network-failed", "none", true) === "no-fallback-available",
    "selector: codebase failure never re-dispatches (no-fallback-available)",
  );
}

// -------------------------------------------------------- dispatch-time line

{
  assert(researchFallbackLine(true) === "research fallback: enabled\n", "line: enabled form");
  assert(researchFallbackLine(false) === "research fallback: disabled\n", "line: disabled form");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
