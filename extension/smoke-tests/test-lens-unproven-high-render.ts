#!/usr/bin/env bun
/**
 * #2040 — the unproven-HIGH cap, half 4 of 4: every surface that renders a
 * severity prints the cap marker beside it.
 *
 * The round summary is covered in half 2 (`test-lens-unproven-high-child.ts`).
 * These are the surfaces that carry the row onward — lean's fixer brief
 * (`renderFindings`) and lean's handback line (`renderFinding`) — plus the
 * residual disclosure's line and the prior-findings block, each asserted at its
 * OWN call site, because each is a separate code path and a marker that reaches
 * one does not reach the others. The fixer's brief is what tells the next
 * developer why a HIGH arrived as a MEDIUM, so a marker missing there is a
 * developer told to fix a finding the harness said was unproven.
 *
 * Shared builders and the assert come from `lib/unproven-high-harness.ts`.
 */

import { renderLensFindings } from "../src/lens-findings-render.ts";
import { renderPriorFindingsBlock } from "../src/lens-residuals.ts";
import { renderFinding } from "../src/lean/review-waves.ts";
import { renderFindings } from "../src/lean/review-deps.ts";
import type { Finding } from "../src/lens-review-types.ts";
import { HIGH, PROOF_COMMAND, createAssert, repro } from "./lib/unproven-high-harness.ts";

const { assert, failures } = createAssert();
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
  // Asserted positively: `!out.includes(...) === false` is `out.includes(...)`,
  // which read as "the forged row is NOT dropped" while testing the opposite,
  // and stayed green whatever the renderer did with `src/a.ts`.
  assert(
    out.includes("src/a.ts") && out.includes("src/b.ts"),
    "(e) an unrecognised marker does not drop the row — only its blocking power is at stake, and it is already MEDIUM",
  );
}


console.log(`\nexit 0`, failures());
process.exit(failures());
