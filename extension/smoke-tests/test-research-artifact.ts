#!/usr/bin/env bun
/**
 * research-artifact — slugging, collision handling, the info/exclude
 * mechanism, and the rendered artifact/provenance shapes.
 *
 * The artifact is /research's single biggest gap fix vs the surveyed
 * landscape (a durable dated report instead of one undated vipune line);
 * the info/exclude write is what keeps an untracked artifact from dirtying
 * a later /work cycle's clean-tree check.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ArtifactArgs,
  ensureOutputsExcluded,
  renderArtifact,
  renderProvenance,
  resolveArtifactPaths,
  slugify,
  writeArtifact,
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

// ------------------------------------------------------------------- slug

{
  assert(
    slugify("How does Vipune RRF scoring work?") === "how-does-vipune-rrf-scoring-work",
    "slug: kebab, punctuation stripped",
  );
  assert(slugify("!!!") === "research", "slug: degenerate topic falls back");
  assert(slugify("x".repeat(100)).length <= 60, "slug: bounded length");
}

const claims: ResearchClaim[] = [
  {
    kind: "finding",
    text: "vipune hybrid scores are RRF reciprocals",
    source: "https://example.com/doc",
    sourceKind: "url",
    sourceDate: "2026-01-02",
    confidence: "high",
    staleness: "stable",
    angle: "web-current",
    verification: { check: "url-liveness", status: "live" },
  },
  {
    kind: "contradiction",
    text: "source A says 25, source B says 60",
    source: "https://example.com/a",
    sourceKind: "url",
    confidence: "medium",
    staleness: "fast-moving",
    angle: "web-current",
    verification: { check: "url-liveness", status: "unreachable" },
  },
  {
    kind: "gap",
    text: "no benchmark data found",
    source: "none",
    sourceKind: "none",
    confidence: "low",
    staleness: "fast-moving",
    angle: "docs-depth",
    verification: { check: "none", status: "unchecked" },
  },
];

const args: ArtifactArgs = {
  topic: "vipune scoring",
  tier: "standard",
  date: "2026-09-09",
  pinnedCommit: "abc1234def",
  angles: [
    { name: "web-current", ok: true, summary: "confirmed the scoring shape", claims: [] },
    { name: "docs-depth", ok: false, summary: "", claims: [] },
  ],
  claims,
  abstained: false,
  provenanceBasename: "research-vipune-scoring.provenance.md",
};

// ------------------------------------------------------------- rendering

{
  const a = renderArtifact(args);
  assert(a.startsWith("# Research: vipune scoring"), "artifact: titled by topic");
  assert(
    a.includes("**Date:** 2026-09-09") && a.includes("**Pinned commit:** abc1234def"),
    "artifact: dated + commit-pinned header",
  );
  assert(a.includes("vipune hybrid scores are RRF reciprocals"), "artifact: finding text present");
  assert(
    a.includes(
      "source: https://example.com/doc · 2026-01-02 · confidence: high · staleness: stable · verification: url live",
    ),
    "artifact: per-claim source/date/confidence/staleness/verification row",
  );
  assert(
    a.includes("## Contradictions") && a.includes("source A says 25"),
    "artifact: contradictions section",
  );
  assert(
    a.includes("## Gaps / unanswered") && a.includes("no benchmark data found"),
    "artifact: gaps section",
  );
  assert(
    a.includes("**web-current** (ok): confirmed the scoring shape"),
    "artifact: angle summaries",
  );
  assert(
    !a.includes("No reliably verified findings"),
    "artifact: no abstention banner when findings verified",
  );

  const abst = renderArtifact({ ...args, abstained: true });
  assert(
    abst.includes("No reliably verified findings"),
    "artifact: abstention banner when abstained",
  );

  const p = renderProvenance(args);
  assert(
    p.includes("https://example.com/doc · kind: url · url live"),
    "provenance: source row with verification",
  );
  assert(
    p.includes("grounded/ungrounded` = path and symbol checked at the pinned commit's tree"),
    "provenance: verification legend",
  );
  assert(
    p.includes("skipped-cap` = the liveness pass was capped"),
    "provenance: legend defines skipped-cap",
  );
  assert(
    p.includes("local-present/local-missing` = local path stat-checked"),
    "provenance: legend defines local-present/local-missing",
  );
  assert(
    p.includes("skipped-cap` = the liveness pass was capped"),
    "provenance: legend defines skipped-cap",
  );

  // New statuses render in the claim rows (rows match the legend).
  const localClaims: ResearchClaim[] = [
    {
      kind: "finding",
      text: "a local file is present",
      source: "/Users/janni/x.md",
      sourceKind: "doc",
      confidence: "high",
      staleness: "stable",
      angle: "docs-depth",
      verification: { check: "local-file", status: "local-present" },
    },
    {
      kind: "finding",
      text: "a local file is missing",
      source: "/Users/janni/y.md",
      sourceKind: "doc",
      confidence: "high",
      staleness: "stable",
      angle: "docs-depth",
      verification: { check: "local-file", status: "local-missing" },
    },
    {
      kind: "finding",
      text: "the 61st URL was skipped",
      source: "https://example.com/many",
      sourceKind: "url",
      confidence: "low",
      staleness: "stable",
      angle: "web-current",
      verification: { check: "none", status: "skipped-cap" },
    },
  ];
  const la = renderArtifact({ ...args, claims: [...claims, ...localClaims] });
  assert(la.includes("verification: local-present"), "artifact row: local-present renders");
  assert(la.includes("verification: local-missing"), "artifact row: local-missing renders");
  assert(la.includes("verification: skipped-cap"), "artifact row: skipped-cap renders");

  // renderProvenance prints `parts` for ANY check kind that carries parts,
  // not only url-liveness.
  const partsClaims: ResearchClaim[] = [
    {
      kind: "finding",
      text: "mixed local + code compound",
      source: "/Users/janni/present.txt + src/x.ts",
      sourceKind: "url",
      confidence: "medium",
      staleness: "stable",
      angle: "codebase",
      verification: {
        check: "code-grounding",
        status: "grounded",
        parts: [
          { source: "/Users/janni/present.txt", kind: "local", status: "local-present" },
          { source: "src/x.ts", kind: "code", status: "grounded" },
        ],
      },
    },
  ];
  const pp = renderProvenance({ ...args, claims: partsClaims });
  assert(
    pp.includes("- part: /Users/janni/present.txt · kind: local · local-present"),
    "provenance: parts printed for a code-grounding claim (not only url-liveness)",
  );
  assert(
    pp.includes("- part: src/x.ts · kind: code · grounded"),
    "provenance: second part printed",
  );
}

// ---------------------------------------------- paths, exclude, fs write

{
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "research-artifact-"));
  await fs.mkdir(path.join(tmp, ".git"), { recursive: true });

  const p1 = await resolveArtifactPaths(tmp, "vipune-scoring");
  assert(
    p1.artifactPath.endsWith(path.join("outputs", "research-vipune-scoring.md")),
    "paths: outputs/research-<slug>.md",
  );
  const written = await writeArtifact(tmp, args, p1);
  assert(
    (await fs.readFile(written.artifactPath, "utf8")).includes("# Research: vipune scoring"),
    "write: artifact file on disk",
  );
  assert(
    (await fs.readFile(written.provenancePath, "utf8")).includes("# Provenance:"),
    "write: provenance sidecar on disk",
  );

  // Collision: same slug → -2 suffix, never a silent overwrite.
  const p2 = await resolveArtifactPaths(tmp, "vipune-scoring");
  assert(
    p2.artifactPath.endsWith("research-vipune-scoring-2.md"),
    `collision: second run gets -2 suffix (got ${path.basename(p2.artifactPath)})`,
  );

  // info/exclude: written once, idempotent on the second call.
  await ensureOutputsExcluded(tmp);
  const exclude = await fs.readFile(path.join(tmp, ".git", "info", "exclude"), "utf8");
  const lines = exclude.split("\n").filter((l) => l.trim() === "outputs/");
  assert(
    lines.length === 1,
    `exclude: exactly one outputs/ line after repeat calls (got ${lines.length})`,
  );

  // A worktree-style .git FILE is skipped, and never throws.
  const wt = await fs.mkdtemp(path.join(os.tmpdir(), "research-wt-"));
  await fs.writeFile(path.join(wt, ".git"), "gitdir: elsewhere\n");
  await ensureOutputsExcluded(wt);
  assert(true, "exclude: .git-as-file (worktree) is skipped without throwing");

  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(wt, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
