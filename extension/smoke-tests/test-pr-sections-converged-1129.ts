#!/usr/bin/env bun
/**
 * #1129 review — the lens-findings PR section names CONVERGED when the
 * approving event carries that verdict, and still says APPROVED otherwise.
 */

import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const { renderLensFindingsSection } = await import("../src/work-driver-pr-sections.ts");
const findings = JSON.stringify([
  {
    lens: "SECURITY",
    severity: "LOW",
    path: "a.txt",
    line: 2,
    title: "two is unchecked",
    downgrade: { from: "MEDIUM", reason: "no trigger" },
  },
]);
const approved = [
  { kind: "lens-approved", at: 1, jobId: "j", round: 2, findings },
] as unknown as Parameters<typeof renderLensFindingsSection>[0];
const converged = [
  { kind: "lens-approved", at: 1, jobId: "j", round: 2, findings, verdict: "CONVERGED" },
] as unknown as Parameters<typeof renderLensFindingsSection>[0];

const plain = renderLensFindingsSection(approved);
const conv = renderLensFindingsSection(converged);
assert(plain.includes("passed (APPROVED)"), "an APPROVED event renders as APPROVED");
assert(!plain.includes("CONVERGED"), "an APPROVED event never mentions CONVERGED");
assert(conv.includes("converged (CONVERGED)"), "a CONVERGED event renders as CONVERGED");
assert(!conv.includes("(APPROVED)"), "a CONVERGED event never renders as APPROVED");

process.exit(exit);
