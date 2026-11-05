#!/usr/bin/env bun
/**
 * #2040 — the unproven-HIGH cap, half 2 of 4: the child plumbing, the stored
 * row, and the round summary.
 *
 * Half 1 (`test-lens-unproven-high.ts`) asserts the rule where it is written.
 * This file asserts the two things that file cannot:
 *   (c) the child really RECORDS the calls the parent reads. Without this the
 *       parent-side matcher could read a field the child never produced and
 *       every assertion in half 1 would still pass — the classic
 *       "green tests, dead feature" shape AGENTS.md §7 warns about;
 *   (d) the row that reaches `review-findings.json` is the capped row, and the
 *       operator-facing summary names the cap — a cap that only fired in memory
 *       would be invisible where the decision is actually made.
 *
 * The renderers that carry the row onward are half 4
 * (`test-lens-unproven-high-render.ts`); the builders every half uses are shared
 * in `lib/unproven-high-harness.ts`, where `spawn.ts` is mocked before the lens
 * modules load, in the `test-lens-kill-child.ts` shape.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLensReview } from "../src/lens-review.ts";
import { renderSummary } from "../src/lens-review-render.ts";
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
  createAssert,
  findingCall,
  makeChildHarness,
  provenCall,
  recordedCalls,
  recordedResults,
  repro,
  toolResult,
} from "./lib/unproven-high-harness.ts";

// #1069 / test-ledger-isolation.ts: any file that can reach runLensReview must
// isolate the ledger before the src modules load.
isolateLedger();

const { assert, failures } = createAssert();
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
    toolUses: [bash(PROOF_COMMAND, "c1")],
    toolResults: [toolResult("c1", false)],
    ms: 10,
    exitCode: 0,
  }));
  const r = await runOneChild();
  assert(
    JSON.stringify(recordedCalls(r)).includes(PROOF_COMMAND),
    "(c) runLensChild attaches the child's recorded toolUses",
  );
  // #2040 review (adversarial ISSUE 2): the RESULTS ride along too, or the
  // parent cannot tell a call that ran from one Pi refused. Without this the
  // per-child matcher could read a field the child never produced and every
  // parent-side assertion would still pass.
  assert(
    JSON.stringify(recordedResults(r)).includes('"isError":false'),
    "(c) runLensChild attaches the child's recorded toolResults",
  );
}

{
  harness.setSpawn(() => ({
    role: "code-review-specialist",
    ok: false,
    text: "",
    toolUses: [bash("echo before the failure", "c1")],
    toolResults: [toolResult("c1", true, "schema refused")],
    ms: 10,
    exitCode: 1,
  }));
  const r = await runOneChild();
  assert(r.ok === false, "(c) the failed child is still reported as failed");
  assert(
    JSON.stringify(recordedCalls(r)).includes("echo before the failure"),
    "(c) a failed child's recorded calls ride along too — a child that died is not a child that ran nothing",
  );
  assert(
    JSON.stringify(recordedResults(r)).includes('"isError":true'),
    "(c) a failed child's recorded results ride along too — the parent must see what it refused",
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
    toolResults: [],
    ms: 10,
    exitCode: 0,
  }));
  const r = await runOneChild();
  assert(
    Array.isArray(recordedCalls(r)) && recordedCalls(r).length === 0,
    "(c) a child that recorded nothing yields an empty list, not undefined",
  );
  assert(
    Array.isArray(recordedResults(r)) && recordedResults(r).length === 0,
    "(c) a child that recorded no results yields an empty list, not undefined",
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
    toolUses: () => [bash(PROOF_COMMAND, "c1")],
    // The result is what records that the call RAN (#2040): a call alone is a
    // request, and a round whose child recorded no successful result for the
    // command is a round in which nothing was reproduced.
    toolResults: () => [toolResult("c1", false)],
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

{
  // #2040 review (adversarial ISSUE 1) — EVIDENCE IS NOT POOLED ACROSS LENSES.
  // The parent used to concatenate every child's `toolUses` and match each row
  // against the whole round, so a command one lens ran proved a HIGH another
  // lens had reported. The proof must come from the child that made the claim:
  // lens A reports the HIGH and never runs anything, lens B runs the exact
  // command. Round-wide pooling keeps it HIGH; per-child matching caps it.
  let reportNow: StubFinding[] = [];
  const fixture = setupReviewFixture({
    prefix: "lens-unproven-per-child",
    files: { "src/a.ts": "// header\nexport const a = 1;\n" },
    report: () => reportNow,
    toolUses: () => [],
    toolUsesOther: () => [bash(PROOF_COMMAND, "other"), toolResult("other", false)],
  });
  try {
    reportNow = [
      {
        severity: "HIGH",
        path: "src/a.ts",
        line: 2,
        title: "HIGH whose command only another lens ran",
        reproduction: repro(PROOF_COMMAND, "assertion failed"),
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
      summary.findings.some((f) => f.title === "HIGH whose command only another lens ran") &&
        summary.findings.every((f) => f.severity === "MEDIUM"),
      "(d) a HIGH is judged against its own child's calls, not another lens's",
    );
    assert(
      summary.findings.every((f) => f.severityCapped === "unproven"),
      "(d) the borrowed-proof row carries the unproven marker",
    );
    assert(
      summary.verdict !== "ISSUES_FOUND" && summary.verdict !== "CRITICAL_ISSUES_FOUND",
      `(d) a HIGH another lens ran does not block the round (verdict ${summary.verdict})`,
    );
  } finally {
    fixture.cleanup();
  }
}

{
  // #2040 review (adversarial ISSUE 2) — A REQUEST IS NOT A RUN. The same
  // fixture with the SAME command recorded, but whose Pi result is an error:
  // `toolUses` is what the child asked for, `toolResults` is what it accepted
  // (types.ts), so a refused call proves nothing and the HIGH caps.
  let reportNow: StubFinding[] = [];
  const fixture = setupReviewFixture({
    prefix: "lens-unproven-refused",
    files: { "src/a.ts": "// header\nexport const a = 1;\n" },
    report: () => reportNow,
    toolUses: () => [bash(PROOF_COMMAND, "c1")],
    toolResults: () => [toolResult("c1", true, "bun: command not found")],
  });
  try {
    reportNow = [
      {
        severity: "HIGH",
        path: "src/a.ts",
        line: 2,
        title: "HIGH whose reproduction failed to run",
        reproduction: repro(PROOF_COMMAND, "assertion failed"),
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
      summary.findings.every(
        (f) => f.severity === "MEDIUM" && f.severityCapped === "unproven",
      ),
      "(d) a bash call whose result is an error does not prove the HIGH that cited it",
    );
  } finally {
    fixture.cleanup();
  }
}

{
  // #2040 review (lens HIGH) — A CARRIED HIGH IS JUDGED AGAINST THIS ROUND.
  // A row an earlier round recorded, held at HIGH by a cap marker, used to skip
  // the check entirely (`severityCapped !== undefined` returned the row), so a
  // stale reproduction kept blocking rounds forever whatever this round's
  // children ran. Two rounds on one clone: round 1 reports the HIGH and its
  // child DOES run the command (so the row is legitimately HIGH and is filed at
  // HIGH with a marker claiming otherwise — the shape a stored or corrupted row
  // presents); round 2 is silent about the row and its children run nothing, so
  // the carried row must be capped, not carried at HIGH again.
  let reportNow: StubFinding[] = [];
  let callsNow: unknown[] = [bash(PROOF_COMMAND, "c1"), toolResult("c1", false)];
  const fixture = setupReviewFixture({
    prefix: "lens-unproven-carried",
    files: { "src/a.ts": "// header\nexport const a = 1;\n" },
    report: () => reportNow,
    toolUses: () => callsNow,
  });
  try {
    reportNow = [
      {
        severity: "HIGH",
        path: "src/a.ts",
        line: 2,
        title: "Carried HIGH with a stale reproduction",
        // A HIGH that arrives HIGH while already claiming a cap marker: the
        // shape a stored/corrupted row can present, and the one the old
        // skip-on-any-marker rule let through unjudged.
        reproduction: repro(PROOF_COMMAND, "nothing happened"),
      },
    ];
    const first = await runLensReview({
      cwd: fixture.repo,
      branch: "main",
      diff: FULL_DIFF,
      head: fixture.sh("git rev-parse HEAD"),
      full: true,
      lensChildFn: fixture.stubLens,
    });
    const stored = (await readBranchRows(fixture.repo, "main")).find(
      (r) => r.title === "Carried HIGH with a stale reproduction",
    );
    assert(stored !== undefined, "(d) the round filed the row");
    assert(
      stored?.severity === "HIGH",
      `(d) round 1's own child ran the claimed command, so the row is filed at HIGH (got ${stored?.severity})`,
    );
    // Round 2: the lens is silent, so the row is CARRIED — and this round's
    // children ran no command matching the row's stale claim.
    reportNow = [];
    callsNow = [];
    const second = await runLensReview({
      cwd: fixture.repo,
      branch: "main",
      diff: FULL_DIFF,
      head: fixture.sh("git rev-parse HEAD"),
      full: true,
      lensChildFn: fixture.stubLens,
    });
    const carried = second.findings.find(
      (f) => f.title === "Carried HIGH with a stale reproduction",
    );
    assert(
      first.verdict === "ISSUES_FOUND",
      `(d) round 1 blocked on the HIGH (verdict ${first.verdict})`,
    );
    assert(
      carried !== undefined,
      "(d) the row is carried into round 2 rather than resolved (its cited code is unchanged)",
    );
    assert(
      carried?.severity === "MEDIUM",
      `(d) a carried HIGH whose reproduction no child ran THIS round is capped, not carried at HIGH (got ${carried?.severity})`,
    );
    assert(
      carried?.severityCapped === "unproven",
      "(d) the carried row says the harness moved it this round",
    );
    assert(
      second.verdict !== "ISSUES_FOUND" && second.verdict !== "CRITICAL_ISSUES_FOUND",
      `(d) an unproven carried HIGH does not block the round (verdict ${second.verdict})`,
    );
    const storedAfter = (await readBranchRows(fixture.repo, "main")).find(
      (r) => r.title === "Carried HIGH with a stale reproduction",
    );
    assert(
      storedAfter?.severity === "MEDIUM",
      `(d) the stored row is the capped severity, so round 3 cannot carry it at HIGH again (got ${storedAfter?.severity})`,
    );
  } finally {
    fixture.cleanup();
  }
}


console.log(`\nexit 0`, failures());
process.exit(failures());
