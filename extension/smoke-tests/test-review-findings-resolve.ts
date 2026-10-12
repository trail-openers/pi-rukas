#!/usr/bin/env bun
/**
 * #1105 — an open row is RESOLVED (not carried into the verdict) by a complete
 * full review when its path is gone at head, or when it has no line and this
 * review did not re-report it (offline, through `runLensReview`).
 *
 * Each scenario runs on its own branch, with a complete full review each round:
 *   A. the PR deletes the file an open row cites → the row resolves and the
 *      verdict is APPROVED (the row does not block it);
 *   B. a no-line open row the next complete review does not re-report → resolved;
 *   C. a no-line open row the next complete review DOES re-report → stays open.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { runLensReview } from "../src/lens-review.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { readBranchRows } from "../src/review-findings-store.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "findings-resolve-"));
const repo = path.join(root, "repo");
const skills = path.join(root, "skills");
const ledgerDir = path.join(root, "ledger");
mkdirSync(repo);
mkdirSync(ledgerDir);
let prec = 10;
for (const l of LENS_ROSTER) {
  mkdirSync(path.join(skills, l.skill), { recursive: true });
  writeFileSync(
    path.join(skills, l.skill, "SKILL.md"),
    `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
  );
  prec += 10;
}
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(ledgerDir, "review-ledger.json");
process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

const sh = (cmd: string) =>
  execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
sh("git init -q -b main");
sh("git config user.email dev@example.com");
sh("git config user.name dev");
mkdirSync(path.join(repo, "src"));
writeFileSync(path.join(repo, "src", "a.ts"), "// header\nexport const a = 1;\nexport const b = 2;\n");
writeFileSync(path.join(repo, "src", "keep.ts"), "export const k = 1;\n");
sh("git add -A");
sh("git commit -qm base");

// The first lens reports `reportNow`; the others report nothing. Every lens
// answers with a summary, so each round is a complete review.
let reportNow: Array<Record<string, unknown>> = [];
const stubLens = async (args: { lens: { name: string } }): Promise<LensRunResult> => {
  const first = args.lens.name === LENS_ROSTER[0]?.name;
  return {
    lens: args.lens.name,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    summary: "reviewed the diff",
    findings: first ? reportNow.map((f) => ({ lens: args.lens.name, ...f })) : [],
  } as unknown as LensRunResult;
};

const FULL_DIFF = "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export const a = 1;";
const runRound = (branch: string, head: string, findings: Array<Record<string, unknown>>) => {
  reportNow = findings;
  return runLensReview({
    cwd: repo,
    branch,
    diff: FULL_DIFF,
    head,
    full: true,
    lensChildFn: stubLens as never,
  });
};
const head = () => sh("git rev-parse HEAD");

try {
  // A — the PR deletes the file an open row cites.
  sh("git checkout -q -b feat/gone");
  const a1 = await runRound("feat/gone", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 2, title: "Shadowed export" },
  ]);
  assert(
    a1.verdict === "ISSUES_FOUND",
    `A round 1: the finding is reported (verdict ${a1.verdict})`,
  );
  sh("git rm -q src/a.ts");
  sh("git commit -qm delete-a");
  const a2 = await runRound("feat/gone", head(), []);
  const aRows = await readBranchRows(repo, "feat/gone");
  assert(
    aRows.length === 1 && aRows[0]?.status === "resolved",
    "A round 2: the open row whose path is gone at head resolves",
  );
  assert(
    a2.verdict === "APPROVED" && a2.findings.length === 0,
    `A round 2: the resolved row does not block the verdict (verdict ${a2.verdict})`,
  );

  // B — a no-line open row the next complete review does not re-report.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/noline");
  const b1 = await runRound("feat/noline", head(), [
    { severity: "MEDIUM", path: "src/keep.ts", title: "Unclear naming" },
  ]);
  assert(b1.verdict === "ISSUES_FOUND", `B round 1: the no-line finding is reported`);
  writeFileSync(path.join(repo, "src", "keep.ts"), "export const k = 2;\n");
  sh("git commit -qam keep-changed");
  const b2 = await runRound("feat/noline", head(), []);
  const bRows = await readBranchRows(repo, "feat/noline");
  assert(
    bRows.length === 1 && bRows[0]?.status === "resolved",
    "B round 2: the no-line row not re-reported by a complete review resolves",
  );
  assert(b2.verdict === "APPROVED", `B round 2: the verdict is not blocked (${b2.verdict})`);

  // C — a no-line open row the next complete review re-reports stays open.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/reported");
  const finding = { severity: "MEDIUM", path: "src/keep.ts", title: "Unclear naming" };
  await runRound("feat/reported", head(), [finding]);
  writeFileSync(path.join(repo, "src", "keep.ts"), "export const k = 3;\n");
  sh("git commit -qam keep-changed-again");
  const c2 = await runRound("feat/reported", head(), [finding]);
  const cRows = await readBranchRows(repo, "feat/reported");
  assert(
    cRows.length === 1 && cRows[0]?.status === "open",
    "C round 2: a no-line row the review re-reports stays open",
  );
  assert(c2.verdict === "ISSUES_FOUND", `C round 2: the re-reported finding blocks (${c2.verdict})`);
  // D — the file is truncated so the cited line no longer exists: resolved.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/trunc");
  await runRound("feat/trunc", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\n");
  sh("git commit -qam truncate");
  const d2 = await runRound("feat/trunc", head(), []);
  const dRows = await readBranchRows(repo, "feat/trunc");
  assert(
    dRows.length === 1 && dRows[0]?.status === "resolved",
    "D round 2: an open row whose cited line is past the end of the file resolves",
  );
  assert(d2.verdict === "APPROVED", `D round 2: the verdict is not blocked (${d2.verdict})`);

  // E: a neighbour edit changes the snippet of a line-bearing row on a
  // present file. A complete review that does not re-report it carries it forward.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/neighbour");
  await runRound("feat/neighbour", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\nexport const a = 9;\nexport const b = 2;\n");
  sh("git commit -qam neighbour");
  const e2 = await runRound("feat/neighbour", head(), []);
  assert(
    (await readBranchRows(repo, "feat/neighbour"))[0]?.status === "open" &&
      e2.verdict === "ISSUES_FOUND",
    `E round 2: a neighbour edit does not resolve a line-bearing finding (verdict ${e2.verdict})`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
