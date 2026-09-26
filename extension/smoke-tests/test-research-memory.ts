#!/usr/bin/env bun
/**
 * research-memory (#895) — unit tests for the vipune takeaway format, the
 * exact stored-row string (topic + takeaway + artifact pointer + date, with
 * the whole-row cap as the final guard), the unchanged supersession
 * signature, and the Run-metrics rendering shared by the artifact and the
 * adoption memo (including the provenance machine-readable mirror).
 *
 * The pipeline-level wiring (timings reaching the artifact, the stubbed
 * memoryWriteFn receiving the takeaway) is covered by test-research-tool.ts.
 */

import path from "node:path";
import {
  RESEARCH_MEMORY_MAX_CHARS,
  RESEARCH_ROW_PREFIX,
  researchMemoryText,
  researchTakeawayText,
} from "../src/research-memory.ts";
import {
  type ArtifactArgs,
  renderAdoptionMemo,
  renderArtifact,
  renderProvenance,
} from "../src/research-artifact.ts";
import type { ResearchClaim } from "../src/research-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The fixture artifact path goes through path.join (CI is Linux).
const FIXTURE_ARTIFACT = path.join("outputs", "research-vipune-scoring.md");

// ------------------------------------------------------------- takeaway

{
  const short = [
    { text: "finding one holds" },
    { text: "finding two holds" },
    { text: "finding three holds" },
    { text: "finding four (never appears)" },
  ];
  // >3 verified: only the first 3 appear, joined by " | ".
  const t = researchTakeawayText(short, 4, 3);
  assert(
    t ===
      "4 verified of 4 claims across 3 angles — top findings: finding one holds | finding two holds | finding three holds",
    `takeaway: >3 verified → first 3 only (got ${t})`,
  );
  assert(!t.includes("finding four"), "takeaway: the 4th finding is dropped");

  // Zero verified: the count line alone (no "top findings" clause).
  const none = researchTakeawayText([], 5, 2);
  assert(none === "0 verified of 5 claims across 2 angles", `takeaway: zero verified (got ${none})`);

  // 80-char truncation: each entry capped at 80 chars (79 + ellipsis).
  const long81 = `x`.repeat(81);
  const l = researchTakeawayText([{ text: long81 }, { text: "short" }], 2, 1);
  assert(
    l.includes(`${"x".repeat(79)}… | short`),
    "takeaway: >80-char findings truncated to 79 chars + ellipsis",
  );
  assert(!l.includes(`…x`), "takeaway: the truncated text does not leak past the ellipsis");
  assert(l.length <= 400, `takeaway: within the 400-char bound (${l.length})`);

  // The 400-char cap: a long topic-free fixture whose 3 tops overflow.
  const big = Array.from({ length: 5 }, (_, i) => ({ text: `F${i} ${"y".repeat(150)}` }));
  const b = researchTakeawayText(big, 5, 1);
  assert(b.length <= 400, `takeaway: 400-char bound holds under overflow (${b.length})`);
  assert(b.endsWith("…"), "takeaway: truncation marked with an ellipsis");
}

// ------------------------------------------------------- exact stored row

{
  const topic = "vipune scoring";
  const takeaway = "4 verified of 4 claims across 3 angles — top findings: one | two | three";
  const date = "2026-09-26";
  const exact = `Research: ${topic} — ${takeaway}. Artifact: ${FIXTURE_ARTIFACT} (${date})`;
  assert(
    researchMemoryText(topic, takeaway, FIXTURE_ARTIFACT, date) === exact,
    "memory row: exact stored string (takeaway intact, no truncation)",
  );
  assert(exact.length <= RESEARCH_MEMORY_MAX_CHARS, "memory row: fits under the 700-char row cap");

  // The supersession signature is unchanged: the `Research: ` prefix plus
  // the `Artifact: outputs/research-` marker (the marker sits AFTER the
  // takeaway, so the takeaway format cannot break it — asserted here).
  assert(exact.startsWith(RESEARCH_ROW_PREFIX), "supersession: row starts with the `Research: ` prefix");
  assert(
    exact.includes("Artifact: outputs/research-"),
    "supersession: the artifact marker is present and intact",
  );

  // The whole-row cap is still the FINAL guard: a combination over 700
  // chars truncates (last char an ellipsis).
  const over = researchMemoryText("t".repeat(1000), "x", "outputs/research-x.md", "2026-01-01");
  assert(over.length === RESEARCH_MEMORY_MAX_CHARS, `row cap: truncated to exactly ${RESEARCH_MEMORY_MAX_CHARS}`);
  assert(over.endsWith("…"), "row cap: truncation marked with an ellipsis");
}

// ------------------------------------------------------- run metrics

const TIMINGS = [
  { phase: "inventory", ms: 10 },
  { phase: "retrieve", ms: 500 },
  { phase: "verify", ms: 320 },
  { phase: "total", ms: 900 },
];

const mixClaims: ResearchClaim[] = [
  {
    kind: "finding",
    text: "a live url",
    source: "https://a/live",
    sourceKind: "url",
    confidence: "high",
    staleness: "stable",
    angle: "web-current",
    verification: { check: "url-liveness", status: "live" },
  },
  {
    kind: "finding",
    text: "a dead url",
    source: "https://a/dead",
    sourceKind: "url",
    confidence: "low",
    staleness: "stable",
    angle: "web-current",
    verification: { check: "url-liveness", status: "dead" },
  },
  {
    kind: "gap",
    text: "a url skipped by the cap",
    source: "https://a/many",
    sourceKind: "url",
    confidence: "low",
    staleness: "stable",
    angle: "web-current",
    verification: { check: "url-liveness", status: "skipped-cap" },
  },
  {
    kind: "finding",
    text: "a grounded claim",
    source: "src/x.ts#seamFn",
    sourceKind: "code",
    confidence: "high",
    staleness: "stable",
    angle: "codebase",
    verification: { check: "code-grounding", status: "grounded" },
  },
  {
    kind: "finding",
    text: "an ungrounded claim",
    source: "src/y.ts#ghost",
    sourceKind: "code",
    confidence: "low",
    staleness: "stable",
    angle: "codebase",
    verification: { check: "code-grounding", status: "ungrounded" },
  },
  {
    kind: "finding",
    text: "a local claim",
    source: "/Users/x/notes.md",
    sourceKind: "doc",
    confidence: "high",
    staleness: "stable",
    angle: "docs-depth",
    verification: { check: "local-file", status: "local-present" },
  },
  {
    kind: "contradiction",
    text: "an unchecked doc ref",
    source: "doc reference",
    sourceKind: "doc",
    confidence: "medium",
    staleness: "stable",
    angle: "docs-depth",
    verification: { check: "none", status: "unchecked" },
  },
];

const angleRuns = [
  { name: "web-current", ok: true, summary: "s", claims: mixClaims.slice(0, 3), backend: "parallel" as const },
  {
    name: "codebase",
    ok: false,
    summary: "",
    claims: mixClaims.slice(3, 5),
    backend: "wigolo" as const,
    failure: "dispatch failed",
  },
  { name: "docs-depth", ok: true, summary: "s", claims: mixClaims.slice(5), backend: "parallel" as const },
];

function metricsArgs(): ArtifactArgs {
  return {
    topic: "vipune scoring",
    tier: "standard",
    date: "2026-09-26",
    pinnedCommit: "abc1234def",
    angles: angleRuns,
    claims: mixClaims,
    abstained: false,
    provenanceBasename: "research-vipune-scoring.provenance.md",
    timings: TIMINGS,
  };
}

{
  const a = renderArtifact(metricsArgs());
  assert(a.includes("## Run metrics"), "artifact: Run metrics section present");
  // Placed after the header block, BEFORE Findings.
  const iHeader = a.indexOf("**Pinned commit:**");
  const iMetrics = a.indexOf("## Run metrics");
  const iFindings = a.indexOf("## Findings");
  assert(
    iHeader !== -1 && iMetrics !== -1 && iFindings !== -1 && iHeader < iMetrics && iMetrics < iFindings,
    `artifact: metrics sits between the header and Findings (header=${iHeader}, metrics=${iMetrics}, findings=${iFindings})`,
  );
  // Per-phase + total rows.
  assert(a.includes("- **inventory**: 10 ms"), "artifact: per-phase row (inventory)");
  assert(a.includes("- **retrieve**: 500 ms"), "artifact: per-phase row (retrieve)");
  assert(a.includes("- **total**: 900 ms"), "artifact: total row");
  // Per-angle rows: pre-dedup per-angle claim counts, backend, ok/failed.
  assert(
    a.includes("- **web-current**: 3 claims reported · backend: parallel · ok"),
    "artifact: per-angle row (parallel, ok)",
  );
  assert(
    a.includes("- **codebase**: 2 claims reported · backend: wigolo · failed"),
    "artifact: per-angle row (wigolo, failed)",
  );
  // The verification mix (computed from the post-verify claims).
  assert(
    a.includes(
      "verification: 1 url live · 1 dead · 0 unreachable · 1 skipped-cap · 1 grounded · 1 ungrounded · 1 local-present · 0 local-missing · 1 unchecked",
    ),
    "artifact: verification mix row",
  );
  // The blank line inside the section survived the \n{3,} collapse: there is
  // exactly one blank line between the total row and the per-angle rows.
  const between = a.slice(a.indexOf("- **total**"), a.indexOf("- **web-current**"));
  assert(
    /\n\n- \*\*web-current\*\*/.test(a) && !/\n{3,}/.test(a),
    "artifact: blank line inside the metrics section is not collapsed",
  );
  void between;
}

{
  // The provenance mirror: machine-readable key: value lines.
  const p = renderProvenance(metricsArgs());
  assert(p.includes("phase.inventory.ms: 10"), "provenance: phase.inventory.ms line");
  assert(p.includes("phase.retrieve.ms: 500"), "provenance: phase.retrieve.ms line");
  assert(p.includes("total.ms: 900"), "provenance: total.ms line");
  assert(p.includes("angle.web-current: claims=3 backend=parallel ok=true"), "provenance: per-angle line (ok)");
  assert(p.includes("angle.codebase: claims=2 backend=wigolo ok=false"), "provenance: per-angle line (failed)");
  assert(p.includes("verify.url.live: 1"), "provenance: verify.url.live");
  assert(p.includes("verify.url.dead: 1"), "provenance: verify.url.dead");
  assert(p.includes("verify.url.unreachable: 0"), "provenance: verify.url.unreachable");
  assert(p.includes("verify.url.skipped-cap: 1"), "provenance: verify.url.skipped-cap");
  assert(p.includes("verify.grounded: 1"), "provenance: verify.grounded");
  assert(p.includes("verify.ungrounded: 1"), "provenance: verify.ungrounded");
  assert(p.includes("verify.local-present: 1"), "provenance: verify.local-present");
  assert(p.includes("verify.local-missing: 0"), "provenance: verify.local-missing");
  assert(p.includes("verify.unchecked: 1"), "provenance: verify.unchecked");
}

{
  // The adoption memo layout renders the same section (it takes an early
  // return in renderArtifact — a missing metrics section there would slip
  // past the standard-layout test).
  const memoArgs: ArtifactArgs = {
    ...metricsArgs(),
    tier: "adoption",
    claims: [
      {
        kind: "finding",
        text: "alt B trades speed for size",
        source: "https://a/alt",
        sourceKind: "url",
        confidence: "high",
        staleness: "stable",
        angle: "adoption-alternatives",
        verification: { check: "url-liveness", status: "live" },
      },
    ],
    memo: { recommendation: "Adopt with conditions." },
  };
  const m = renderAdoptionMemo(memoArgs);
  assert(m.startsWith("# Adoption memo: vipune scoring"), "memo: adoption layout used");
  assert(m.includes("## Run metrics"), "memo: Run metrics section present in the adoption layout");
  assert(m.includes("- **total**: 900 ms"), "memo: total row present");
  assert(m.includes("- **web-current**: 3 claims reported · backend: parallel · ok"), "memo: per-angle rows present");
  assert(m.includes("verification: "), "memo: verification mix present");
}

{
  // No timings → no metrics section (a bare render call stays unchanged).
  const plain = renderArtifact({ ...metricsArgs(), timings: undefined });
  assert(!plain.includes("## Run metrics"), "artifact: no metrics section when timings absent");
  const plainProv = renderProvenance({ ...metricsArgs(), timings: undefined });
  assert(!plainProv.includes("phase.inventory.ms"), "provenance: no metric lines when timings absent");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
