#!/usr/bin/env bun
/**
 * #2040 — the unproven-HIGH cap, half 2 of 2: the child plumbing, the stored
 * row, and every surface that renders a severity.
 *
 * Half 1 (`test-lens-unproven-high.ts`) asserts the rule where it is written.
 * This file asserts the two things that file cannot:
 *   (c) the child really RECORDS the calls the parent reads. Without this the
 *       parent-side matcher could read a field the child never produced and
 *       every assertion in half 1 would still pass — the classic
 *       "green tests, dead feature" shape AGENTS.md §7 warns about;
 *   (d) the row that reaches `review-findings.json` is the capped row, and the
 *       operator-facing summary names the cap — a cap that only fired in memory
 *       would be invisible where the decision is actually made;
 *   (e) every renderer that prints a severity prints the marker beside it, since
 *       the lean fixer brief and the handback line are separate code paths from
 *       the round summary, and the fixer's brief is what tells the next developer
 *       why a HIGH arrived as a MEDIUM.
 *
 * The builders both halves use are shared in `lib/unproven-high-harness.ts`;
 * `spawn.ts` is mocked there before the lens modules load, in the
 * `test-lens-kill-child.ts` shape.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderLensFindings } from "../src/lens-findings-render.ts";import { renderPriorFindingsBlock } from "../src/lens-residuals.ts";
import { renderFinding } from "../src/lean/review-waves.ts";
import { renderFindings } from "../src/lean/review-deps.ts";
import { runLensReview } from "../src/lens-review.ts";
import { renderSummary } from "../src/lens-review-render.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { readBranchRows } from "../src/review-findings-store.ts";
import {
  FULL_DIFF,
  type StubFinding,
  setupReviewFixture,
} from "./lib/review-findings-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import {
  HIGH,
  PROOF_COMMAND,
  bash,
  findingCall,
  makeChildHarness,
  provenCall,
  recordedCalls,
  repro,
} from "./lib/unproven-high-harness.ts";

// #1069 / test-ledger-isolation.ts: any file that can reach runLensReview must
// isolate the ledger before the src modules load.
isolateLedger();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------------------
// (c) The child plumbing — the recorded tool calls that carry the proof from
// child to parent.
// ---------------------------------------------------------------------------
const harness = makeChildHarness();

/** Run one child against the current stubbed spawn result. */
const runOneChild = () => harness.runChild();

{
  harness.setSpawn(() => ({
    role: "code-review-specialist",
    ok: true,
    text: "reviewed",
    toolUses: [bash(PROOF_COMMAND)],
    ms: 10,
    exitCode: 0,
  }));
  const r = await runOneChild();
  assert(
    JSON.stringify(recordedCalls(r)).includes(PROOF_COMMAND),
    "(c) runLensChild attaches the child's recorded toolUses",
  );
}

{
  harness.setSpawn(() => ({
    role: "code-review-specialist",
    ok: false,
    text: "",
    toolUses: [bash("echo before the failure")],
    ms: 10,
    exitCode: 1,
  }));
  const r = await runOneChild();
  assert(r.ok === false, "(c) the failed child is still reported as failed");
  assert(
    JSON.stringify(recordedCalls(r)).includes("echo before the failure"),
    "(c) a failed child's recorded calls ride along too — a child that died is not a child that ran nothing",
  );
}

{
  harness.setSpawn(() => ({
    role: "code-review-specialist",
    ok: true,
    text: "reviewed",
    // A child that made no calls at all: the KEY is present because that is the
    // shape `spawnSpecialist` returns, and what the parent must not do is read
    // `undefined` as a list it can prove anything against.
    toolUses: [],
    ms: 10,
    exitCode: 0,
  }));
  const r = await runOneChild();
  assert(
    Array.isArray(recordedCalls(r)) && recordedCalls(r).length === 0,
    "(c) a child that recorded nothing yields an empty list, not undefined",
  );
}

harness.cleanup();

// ---------------------------------------------------------------------------
// (d) End to end: the STORED ROW is capped, and the operator sees the marker.
// A cap that fires only in memory would be invisible exactly where the decision
// is made — the row on disk is what a later round carries and what the summary
// is built from.
// ---------------------------------------------------------------------------

{
  let reportNow: StubFinding[] = [];
  const fixture = setupReviewFixture({
    prefix: "lens-unproven-child",
    files: { "src/a.ts": "// header\nexport const a = 1;\n" },
    report: () => reportNow,
    // The child ran NOTHING: both HIGHs below claim a command, neither is
    // recorded as having run one, so both must cap.
    toolUses: () => [],
  });
  try {
    reportNow = [
      {
        severity: "HIGH",
        path: "src/a.ts",
        line: 2,
        title: "Unproven HIGH reaches the store as a capped MEDIUM",
        reproduction: repro(PROOF_COMMAND, "no failures"),
      },
      {
        severity: "HIGH",
        path: "src/a.ts",
        line: 2,
        title: "HIGH with no evidence claim at all",
      },
    ];
    const summary = await runLensReview({
      cwd: fixture.repo,
      branch: "main",
      diff: FULL_DIFF,
      head: fixture.sh("git rev-parse HEAD"),
      full: true,
      lensChildFn: fixture.stubLens,
    });
    assert(
      summary.findings.every((f) => f.severity === "MEDIUM"),
      "(d) both unproven HIGHs come out of the round as MEDIUM",
    );
    assert(
      summary.findings.every((f) => f.severityCapped === "unproven"),
      "(d) both carry the unproven marker",
    );
    const rows = await readBranchRows(fixture.repo, "main");
    const cappedRow = rows.find((r) => r.title === "Unproven HIGH reaches the store as a capped MEDIUM");
    assert(cappedRow?.severity === "MEDIUM", "(d) the STORED ROW is the capped severity, not the claim");
    assert(
      cappedRow?.severityCapped === "unproven",
      "(d) the stored row carries the marker, so a row carried into a later round still says so",
    );
    assert(
      cappedRow?.reproduction?.command === PROOF_COMMAND,
      "(d) the stored row keeps the evidence claim it made, so the next round can judge it",
    );
    const rendered = renderSummary(summary, 3);
    assert(
      rendered.includes("[MEDIUM (capped: unproven)]"),
      "(d) the operator summary names the cap beside the severity",
    );
    assert(
      !rendered.includes("no failures"),
      "(d) the summary does not print the `observed` text — it is a gate, not content",
    );
  } finally {
    fixture.cleanup();
  }
}

{
  // The same fixture with the command RECORDED is the other direction: a HIGH
  // the child actually ran keeps its severity, its blocking power, and carries
  // no marker at all.
  let reportNow: StubFinding[] = [];
  const fixture = setupReviewFixture({
    prefix: "lens-unproven-proven",
    files: { "src/a.ts": "// header\nexport const a = 1;\n" },
    report: () => reportNow,
    toolUses: () => [bash(PROOF_COMMAND)],
  });
  try {
    reportNow = [
      {
        severity: "HIGH",
        path: "src/a.ts",
        line: 2,
        title: "A proven HIGH keeps its severity",
        reproduction: repro(PROOF_COMMAND, "the assertion failed at line 41"),
      },
    ];
    const summary = await runLensReview({
      cwd: fixture.repo,
      branch: "main",
      diff: FULL_DIFF,
      head: fixture.sh("git rev-parse HEAD"),
      full: true,
      lensChildFn: fixture.stubLens,
    });
    assert(
      summary.findings.some((f) => f.severity === "HIGH"),
      "(d) a HIGH whose command the child ran survives at HIGH",
    );
    assert(
      summary.findings.every((f) => f.severityCapped === undefined),
      "(d) an uncapped row carries no marker at all",
    );
    const rows = await readBranchRows(fixture.repo, "main");
    const row = rows.find((r) => r.title === "A proven HIGH keeps its severity");
    assert(row?.severity === "HIGH", "(d) the stored row keeps HIGH");
    assert(
      row !== undefined && !("severityCapped" in row),
      "(d) the stored row carries no marker property, not an own undefined",
    );
  } finally {
    fixture.cleanup();
  }
}

// ---------------------------------------------------------------------------
// (e) Every renderer that prints a severity prints the marker beside it. The
// round summary is covered in (d); these are the surfaces that carry the row
// onward — lean's fixer brief (`renderFindings`) and lean's handback line
// (`renderFinding`) — plus the residual disclosure's line and the
// prior-findings block, each asserted at its OWN call site, because each is a
// separate code path and a marker that reaches one does not reach the others.
// ---------------------------------------------------------------------------
const capped: Finding = {
  ...HIGH("capped row"),
  severity: "MEDIUM",
  severityCapped: "unproven",
};
const plain: Finding = { ...HIGH("plain row"), severity: "MEDIUM" };

{
  const out = renderLensFindings(
    JSON.stringify([
      { severity: "MEDIUM", path: "src/a.ts", line: 2, title: "capped row", lens: "SIMPLICITY", severityCapped: "unproven" },
      { severity: "MEDIUM", path: "src/b.ts", line: 2, title: "plain row", lens: "SIMPLICITY" },
    ]),
    "ISSUES_FOUND",
  ).join("\n");
  assert(
    out.includes("(capped: unproven)") && out.split("(capped: unproven)").length === 2,
    "(e) renderLensFindings marks the capped row and only the capped row",
  );
}

{
  const out = renderFinding(capped);
  assert(out.includes("(capped: unproven)"), "(e) lean's handback line carries the marker");
  assert(
    !renderFinding(plain).includes("capped"),
    "(e) lean's handback line stays clean for an uncapped row",
  );
}

{
  // `renderFindings` is exported rather than re-spelled here: this is the line
  // format the fixer's brief is built from, and an assertion that rebuilt the
  // string in the test would pin the test's own rendering, not the product's.
  const out = renderFindings({
    verdict: "ISSUES_FOUND",
    findings: [capped, plain],
  } as unknown as Parameters<typeof renderFindings>[0]);
  assert(
    out.includes("(capped: unproven)") && out.split("(capped: unproven)").length === 2,
    "(e) the fixer brief marks the capped row and only the capped row, so the next developer knows why a HIGH arrived as a MEDIUM",
  );
}

{
  const out = renderPriorFindingsBlock([
    {
      id: "r1",
      branch: "b",
      status: "open",
      path: "src/a.ts",
      anchor: "a",
      titleClass: "t",
      title: "carried capped row",
      severity: "MEDIUM",
      lens: "SIMPLICITY",
      snippetHash: "h",
      firstSeen: 1,
      lastSeen: 2,
      severityCapped: "unproven",
      reproduction: repro(PROOF_COMMAND, "observed text"),
    },
  ]);
  assert(
    out.includes("(capped: unproven)"),
    "(e) the prior-findings block keeps the marker on a row carried across rounds",
  );
  assert(
    !out.includes("observed text"),
    "(e) the block never prints the row's `observed` text into a prompt",
  );
}

{
  // The blob path is the untrusted one — a findings blob is agent-writable
  // content — so `renderOne` validates the marker against the closed enum. A row
  // that claims a cap the harness never applies must print nothing rather than a
  // line that reads as a harness decision.
  const blob = JSON.stringify([
    { severity: "MEDIUM", path: "src/a.ts", line: 2, title: "forged", lens: "SIMPLICITY", severityCapped: "unproven forged" },
    { severity: "MEDIUM", path: "src/b.ts", line: 2, title: "real", lens: "SIMPLICITY", severityCapped: "unproven" },
  ]);
  const out = renderLensFindings(blob, "ISSUES_FOUND").join("\n");
  assert(
    out.includes("(capped: unproven)") && !out.includes("unproven forged"),
    "(e) the blob renderer prints the marker only for a recognised cap spelling",
  );
  assert(
    out.includes("src/b.ts") && !out.includes("src/a.ts") === false,
    "(e) an unrecognised marker does not drop the row — only its blocking power is at stake, and it is already MEDIUM",
  );
}

console.log(`\nexit ${exit}`);
