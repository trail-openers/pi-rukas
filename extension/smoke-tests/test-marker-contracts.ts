#!/usr/bin/env bun
/**
 * MARKER_CONTRACTS — the declared prose-marker registry stays true.
 *
 * Every marker bug in this repo's history (#397 dual verdicts, #404
 * heading forms, #408's four fixed sites, the DUPLICATE_RISK template
 * echo, the gap-gate fail-open) lived on the same axis: a consumer's
 * behavior on absence/malformed drifting silently. The registry
 * (reply-markers.ts) declares token → values → consumer → on-absence;
 * this gate enforces the registry against the source:
 *
 *   1. every row's consumer file exists and contains the token,
 *   2. every enum value appears in the consumer's source (the table
 *      cannot drift from the code),
 *   3. every known marker-consuming module appears in the registry (a
 *      new hand-rolled parser fails here),
 *   4. the intent gate's weaker private `readToken` duplicate stays dead —
 *      the shared reader (last-match, colon-optional, bold-tolerant,
 *      heading-form) is the only prose-marker parser.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { MARKER_CONTRACTS } from "../src/reply-markers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "..", "src");
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

// 1 + 2 — each row's consumer exists, names the token, and carries every value.
for (const c of MARKER_CONTRACTS) {
  let source = "";
  try {
    source = read(c.consumer);
  } catch {
    assert(false, `contract ${c.token}: consumer ${c.consumer} does not exist`);
    continue;
  }
  assert(source.includes(c.token), `contract ${c.token}: token appears in ${c.consumer}`);
  if (Array.isArray(c.values)) {
    const missing = c.values.filter((v) => !source.toLowerCase().includes(v.toLowerCase()));
    assert(
      missing.length === 0,
      `contract ${c.token}: every declared value appears in ${c.consumer}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
    );
  }
  assert(c.onAbsence.length > 10, `contract ${c.token}: on-absence policy is stated`);
}

// 3 — the known marker-consuming modules all appear as consumers. Adding a
// prose-marker parser to a NEW module requires registering it here and in
// MARKER_CONTRACTS — that is the point.
{
  const KNOWN_CONSUMERS = [
    "adversarial-verdict.ts",
    "work-driver-stepback-ci.ts",
    "work-driver-intent.ts",
    "plan-investigate.ts",
    "plan-gaps.ts",
    "research-verify.ts",
    "work-driver-lens.ts",
  ];
  const registered = new Set(MARKER_CONTRACTS.map((c) => c.consumer));
  for (const f of KNOWN_CONSUMERS) {
    assert(registered.has(f), `known marker consumer ${f} is registered in MARKER_CONTRACTS`);
  }
}

// 4 — the intent gate uses the SHARED reader; its weaker duplicate is dead.
{
  const intent = read("work-driver-intent.ts");
  assert(
    !/function readToken\(/.test(intent),
    "the private readToken duplicate stays deleted from work-driver-intent.ts",
  );
  assert(
    /readMarker\(text, "INTENT-VERDICT"/.test(intent) &&
      /readMarker\(text, "PARK-REASON"/.test(intent),
    "INTENT-VERDICT and PARK-REASON parse through reply-markers.readMarker (last-match, colon-optional, bold-tolerant)",
  );
}

// The shared reader semantics the migration relies on (last match wins) —
// pinned here against the LIVE reader so the migration's premise cannot rot.
{
  const { readMarker } = await import("../src/reply-markers.ts");
  const musing =
    "If the code contradicts the issue I will answer INTENT-VERDICT: park.\n\nINTENT-VERDICT: proceed";
  assert(
    readMarker(musing, "INTENT-VERDICT", /(proceed-with-assumptions|proceed|park)/) === "proceed",
    "last-match wins: a resolver's musing about a verdict is not its verdict (the exact defect the old first-match readToken had)",
  );
  assert(
    readMarker("INTENT-VERDICT **park**", "INTENT-VERDICT", /(proceed|park)/) === "park",
    "colon-optional + bold-tolerant (wider than the deleted duplicate on every axis)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
