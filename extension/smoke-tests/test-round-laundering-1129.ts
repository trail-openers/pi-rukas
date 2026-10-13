#!/usr/bin/env bun
/**
 * #1129 review — a triggered MEDIUM never launders to LOW, and a legacy row
 * keeps its MEDIUM until a lens re-reports it.
 *
 *   - round 1 triggered MEDIUM → round 2 re-report without a trigger (the
 *     pre-pass makes it LOW) → the store keeps MEDIUM and the trigger, the round
 *     reports MEDIUM, and the verdict is ISSUES_FOUND;
 *   - round 1 triggered MEDIUM → round 2 omitted → the carried MEDIUM blocks;
 *   - a legacy row (written before triggers existed) carried into a round-2
 *     review is not downgraded: it stays MEDIUM and blocks.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { recordFindingRunOutcome } = await import("../src/review-findings-store.ts");
const { judgeRound } = await import("../src/lens-review-converge.ts");
const { FINDINGS_FILE } = await import("../src/review-findings-store.ts");

type F = import("../src/lens-review-types.ts").Finding;
const finding = (over: Partial<F> = {}): F =>
  ({
    lens: "SECURITY",
    severity: "MEDIUM",
    path: "a.txt",
    line: 2,
    title: "two is unchecked",
    ...over,
  }) as F;
const record = (branch: string, findings: F[], complete = true) =>
  recordFindingRunOutcome({ cwd: repo, branch, headSha, findings, complete, now: 1 });

// -------- 1. triggered MEDIUM, re-reported without a trigger (round 2 pre-pass → LOW)
const r1 = await record("b-relabel", [finding({ trigger: "call twice" })]);
assert(r1.ok, "round 1 records the triggered MEDIUM");
const downgraded = finding({
  severity: "LOW",
  downgrade: { from: "MEDIUM", reason: "no trigger" },
});
const r2 = await record("b-relabel", [downgraded]);
if (!r2.ok) throw new Error(`round 2 not recorded: ${r2.reason}`);
const eff = r2.effective[0];
assert(
  eff?.severity === "MEDIUM" && eff.trigger === "call twice" && eff.downgrade === undefined,
  "a trigger-less re-report keeps the stored MEDIUM and trigger (no downgrade record)",
);
const j1 = judgeRound([eff as F], r2, [downgraded], [], "MEDIUM", 2);
assert(
  j1.verdict === "ISSUES_FOUND" && j1.reported[0]?.severity === "MEDIUM",
  "round 2 with the re-report is ISSUES_FOUND at MEDIUM (not CONVERGED)",
);

// -------- 2. triggered MEDIUM, omitted in round 2 → the carried MEDIUM blocks
const omitted1 = await record("b-omit", [finding({ trigger: "call twice" })]);
assert(omitted1.ok, "round 1 records a triggered MEDIUM on a second branch");
const omitted2 = await record("b-omit", []);
if (!omitted2.ok) throw new Error(`round 2 (omitted) not recorded: ${omitted2.reason}`);
const j2 = judgeRound([], omitted2, [], [], "MEDIUM", 2);
assert(
  omitted2.carried.length === 1 && j2.verdict === "ISSUES_FOUND",
  "a round-2 omitted triggered MEDIUM is carried and blocks (ISSUES_FOUND)",
);

// -------- 3. a legacy row (no trigger ever recorded) keeps MEDIUM when carried
const legacy = {
  id: "1a2b3c4d",
  branch: "b-legacy",
  path: "a.txt",
  anchor: "x",
  titleClass: "unchecked",
  title: "two is unchecked",
  severity: "MEDIUM",
  lens: "SECURITY",
  line: 2,
  snippetHash: "0".repeat(16),
  status: "open",
  firstSeen: 1,
  lastSeen: 1,
};
writeFileSync(path.join(root, FINDINGS_FILE), JSON.stringify({ rows: [legacy] }));
const l2 = await record("b-legacy", []);
if (!l2.ok) throw new Error(`legacy round not recorded: ${l2.reason}`);
assert(
  l2.legacy.length === 1 && l2.carried.length === 0,
  "a legacy carried row is classed legacy, not downgradable",
);
const j3 = judgeRound([], l2, [], [], "MEDIUM", 2);
assert(
  j3.verdict === "ISSUES_FOUND" && j3.reported[0]?.severity === "MEDIUM",
  "a legacy MEDIUM stays MEDIUM in round 2 and blocks (ISSUES_FOUND)",
);

process.exit(exit);
