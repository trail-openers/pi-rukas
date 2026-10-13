#!/usr/bin/env bun
/**
 * #1129 review (round 3) — the findings memory never stores a downgraded
 * severity, and the round-2 downgrade reaches only rows created under #1129
 * that have never had a trigger and are stored at MEDIUM.
 *
 *   - HIGH with no trigger, re-reported at LOW → stored HIGH, ISSUES_FOUND;
 *   - triggered MEDIUM, re-reported trigger-less and then omitted → MEDIUM, ISSUES_FOUND;
 *   - legacy MEDIUM (no `triggerTracked`), re-reported trigger-less at rounds 2 and 3 → MEDIUM, ISSUES_FOUND;
 *   - fresh trigger-less MEDIUM created in round 1 → round 2 → LOW, CONVERGED (the rule still converges);
 *   - CONVERGED with no branch and no PR → a visible note, the verdict kept.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

const root = mkdtempSync(path.join(tmpdir(), "findings-laundering-"));
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(root, "review-ledger.json");
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const repo = path.join(root, "repo");
mkdirSync(repo);
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: "pipe" }).toString();
git("init -q -b feature/x");
git("config user.email t@example.com");
git("config user.name t");
writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
git("add -A");
git('commit -q -m "base"');
const headSha = git("rev-parse HEAD").trim();

const { recordFindingRunOutcome, readBranchRows, FINDINGS_FILE } = await import(
  "../src/review-findings-store.ts"
);
const { judgeRound } = await import("../src/lens-review-converge.ts");
const { finishLensReview } = await import("../src/lens-review-finish.ts");
type F = import("../src/lens-review-types.ts").Finding;
type Recorded = Awaited<ReturnType<typeof recordFindingRunOutcome>>;
type Summary = import("../src/lens-review-format.ts").LensReviewSummary;

const lens: import("../src/lens-review-types.ts").LensRunResult[] = [
  {
    lens: "SECURITY",
    ok: true,
    ms: 1,
    startMs: 0,
    findings: [],
    attempts: 1,
    blocked: false,
    summary: "reviewed",
  },
];
const finding = (over: Partial<F> = {}): F =>
  ({
    lens: "SECURITY",
    severity: "MEDIUM",
    path: "a.txt",
    line: 2,
    title: "two is unchecked",
    ...over,
  }) as F;
const record = (branch: string, findings: F[], complete = true): Promise<Recorded> =>
  recordFindingRunOutcome({ cwd: repo, branch, headSha, findings, complete, now: 1 });
/** The verdict of a recorded round, judged the way lens-review.ts judges it. */
function judge(r: Recorded, round: number) {
  if (!r.ok) throw new Error(`round not recorded: ${r.reason}`);
  return judgeRound(r.effective, r, [], lens, "MEDIUM", round);
}
async function storedRow(branch: string, title: string) {
  return (await readBranchRows(repo, branch)).find((r) => r.title === title);
}

// -------- 1. HIGH, no trigger in round 1; re-reported at LOW in round 2
{
  const r1 = await record("b-high", [finding({ severity: "HIGH", title: "high one" })]);
  assert(r1.ok, "A round 1: the trigger-less HIGH is recorded");
  const r2 = await record("b-high", [finding({ severity: "LOW", title: "high one" })]);
  const j = judge(r2, 2);
  assert(
    (await storedRow("b-high", "high one"))?.severity === "HIGH",
    "A round 2: a LOW re-report never lowers the stored HIGH",
  );
  assert(
    j.reported[0]?.severity === "HIGH" && j.reported[0]?.downgrade === undefined,
    "A round 2: the HIGH is reported at HIGH with no downgrade",
  );
  assert(j.verdict === "ISSUES_FOUND", "A round 2: the HIGH blocks (ISSUES_FOUND)");
}

// -------- 2. triggered MEDIUM; trigger-less re-report at round 2, omitted at round 3
{
  const r1 = await record("b-trig", [finding({ title: "triggered", trigger: "call twice" })]);
  assert(r1.ok, "B round 1: the triggered MEDIUM is recorded");
  const r2 = await record("b-trig", [finding({ title: "triggered" })]);
  const j2 = judge(r2, 2);
  const row2 = await storedRow("b-trig", "triggered");
  assert(
    row2?.severity === "MEDIUM" && row2?.trigger === "call twice",
    "B round 2: the trigger-less re-report keeps the stored MEDIUM and the sticky trigger",
  );
  assert(
    j2.reported[0]?.severity === "MEDIUM" && j2.verdict === "ISSUES_FOUND",
    "B round 2: MEDIUM, ISSUES_FOUND",
  );
  const r3 = await record("b-trig", []);
  const j3 = judge(r3, 3);
  assert(
    j3.reported[0]?.severity === "MEDIUM" && j3.verdict === "ISSUES_FOUND",
    "B round 3: the omitted triggered MEDIUM is carried at MEDIUM, ISSUES_FOUND",
  );
}

// -------- 3. legacy MEDIUM (written before triggers existed) re-reported trigger-less
{
  const seed = await record("b-legacy", [finding({ title: "legacy one" })]);
  assert(seed.ok, "C seed: a trigger-less MEDIUM is recorded");
  // Make the row legacy: strip the creation marker and the trigger, as a pre-#1129 file has it.
  const file = path.join(root, FINDINGS_FILE);
  const stored = JSON.parse(readFileSync(file, "utf8")) as { rows: Array<Record<string, unknown>> };
  for (const r of stored.rows) {
    if (r.branch === "b-legacy") {
      r.triggerTracked = undefined;
      r.trigger = undefined;
    }
  }
  writeFileSync(file, JSON.stringify(stored));
  const r2 = await record("b-legacy", [finding({ title: "legacy one" })]);
  const j2 = judge(r2, 2);
  assert(
    j2.reported[0]?.severity === "MEDIUM" && j2.reported[0]?.downgrade === undefined,
    "C round 2: a legacy MEDIUM re-reported trigger-less stays MEDIUM (no launder)",
  );
  assert(j2.verdict === "ISSUES_FOUND", "C round 2: ISSUES_FOUND");
  assert(
    (await storedRow("b-legacy", "legacy one"))?.triggerTracked === undefined,
    "C round 2: a re-report never sets the creation marker on a legacy row",
  );
  const r3 = await record("b-legacy", [finding({ title: "legacy one" })]);
  const j3 = judge(r3, 3);
  assert(
    j3.reported[0]?.severity === "MEDIUM" && j3.verdict === "ISSUES_FOUND",
    "C round 3: the legacy MEDIUM still blocks at MEDIUM (ISSUES_FOUND)",
  );
}

// -------- 4. fresh trigger-less MEDIUM created in round 1 → round 2 → LOW, CONVERGED
{
  const r1 = await record("b-fresh", [finding({ title: "fresh one" })]);
  assert(r1.ok, "D round 1: a trigger-less MEDIUM is recorded");
  const j1 = judge(r1, 1);
  assert(j1.verdict === "ISSUES_FOUND", "D round 1: no downgrade, ISSUES_FOUND");
  const r2 = await record("b-fresh", [finding({ title: "fresh one" })]);
  const j2 = judge(r2, 2);
  assert(
    j2.reported[0]?.severity === "LOW" && j2.reported[0]?.downgrade?.reason === "no trigger",
    "D round 2: the fresh trigger-less MEDIUM is downgraded to LOW at the verdict",
  );
  assert(j2.verdict === "CONVERGED", "D round 2: CONVERGED (the rule still converges)");
  assert(
    (await storedRow("b-fresh", "fresh one"))?.severity === "MEDIUM",
    "D round 2: the store keeps MEDIUM — the downgrade is never written",
  );
}

// -------- 5. CONVERGED with no branch and no PR says so
{
  const summary = {
    verdict: "CONVERGED",
    totalFindings: 1,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 1 },
    lenses: lens,
    findings: [finding({ severity: "LOW", downgrade: { from: "MEDIUM", reason: "no trigger" } })],
  } as unknown as Summary;
  const out = await finishLensReview(summary, "MEDIUM", repo, undefined, {});
  await out.ledgerWrite;
  assert(out.summary.verdict === "CONVERGED", "E: the verdict is kept");
  assert(
    out.summary.note ===
      "CONVERGED: 1 finding(s) downgraded for lack of a trigger were not posted — no PR resolved",
    "E: a CONVERGED review with no branch and no PR carries the visible note",
  );
}

process.exit(exit);
