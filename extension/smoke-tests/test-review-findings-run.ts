#!/usr/bin/env bun
/**
 * #1105 — the findings memory through `runLensReview`, end to end (offline).
 *
 * Lens children are injected (`lensChildFn`), so no Pi child is spawned. A
 * temp clone carries three rounds on one branch:
 *   1. first review — a MEDIUM finding is reported; the verdict is
 *      ISSUES_FOUND and the row is recorded beside the ledger;
 *   2. a follow-up round — the lenses receive the prior finding as a fenced
 *      DATA block, and a delta review after lines were inserted above the
 *      cited code suppresses it (suppressed-unchanged, same row), so the
 *      verdict is APPROVED and the finding is listed as suppressed;
 *   3. an operator acceptance by row id, then a full review — the finding is
 *      suppressed-accepted and the verdict stays APPROVED.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptRow } from "../scripts/review-accept-row.ts";
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

const root = mkdtempSync(path.join(os.tmpdir(), "findings-run-"));
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
// Point the ledger (and so the findings file beside it) at a private dir.
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(ledgerDir, "review-ledger.json");
process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

const sh = (cmd: string) =>
  execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
sh("git init -q -b feat/x");
sh("git config user.email dev@example.com");
sh("git config user.name dev");
const SRC = [
  "// header",
  "export function alpha(x: number) {",
  "  const a = x + 1;",
  "  return a * 2;",
  "}",
];
mkdirSync(path.join(repo, "src"));
writeFileSync(path.join(repo, "src", "a.ts"), `${SRC.join("\n")}\n`);
sh("git add -A");
sh("git commit -qm one");
const c1 = sh("git rev-parse HEAD");

// Stub lens children: every lens answers with evidence; the first lens
// reports the same finding each round, and the prompt it received is recorded.
const seenPrior: string[] = [];
let reportLine = 4;
const stubLens = async (args: {
  lens: { name: string };
  opts: { priorFindings?: string };
}): Promise<LensRunResult> => {
  seenPrior.push(args.opts.priorFindings ?? "");
  const first = args.lens.name === LENS_ROSTER[0]?.name;
  return {
    lens: args.lens.name,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    summary: "reviewed the diff",
    findings: first
      ? [
          {
            lens: args.lens.name,
            severity: "MEDIUM",
            path: "src/a.ts",
            line: reportLine,
            title: "Division by zero possible",
          },
        ]
      : [],
  } as unknown as LensRunResult;
};

const common = { cwd: repo, branch: "feat/x", lensChildFn: stubLens as never };
// A pasted diff satisfies the full-review path (the stubs never read it).
const FULL_DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export function alpha(x: number) {";

try {
  // Round 1 — a first review.
  const r1 = await runLensReview({ ...common, diff: FULL_DIFF });
  assert(
    r1.verdict === "ISSUES_FOUND",
    `round 1: the MEDIUM finding blocks (verdict ${r1.verdict})`,
  );
  const rows1 = await readBranchRows(repo, "feat/x");
  assert(
    rows1.length === 1 && rows1[0]?.status === "open",
    "round 1: one open row is recorded for the branch",
  );
  const rowId = rows1[0]?.id ?? "";
  assert(seenPrior[0] === "", "round 1: the first review's lenses see no prior block");

  // Round 2 — a delta review after two lines were inserted above the code.
  writeFileSync(path.join(repo, "src", "a.ts"), `// new 1\n// new 2\n${SRC.join("\n")}\n`);
  sh("git add -A");
  sh("git commit -qm two");
  const c2 = sh("git rev-parse HEAD");
  reportLine = 6;
  seenPrior.length = 0;
  const r2 = await runLensReview({ ...common, since: c1, head: c2 });
  assert(
    seenPrior.some(
      (p) => p.includes("<<<prior-findings") && p.includes("Division by zero possible"),
    ),
    "round 2: every lens receives the prior finding in a fenced DATA block",
  );
  assert(
    r2.verdict === "APPROVED" && r2.findings.length === 0,
    `round 2: the delta suppresses the known finding on untouched code (verdict ${r2.verdict})`,
  );
  assert(
    r2.suppressed?.[0]?.reason.includes("outside") === true && r2.suppressed?.[0]?.rowId === rowId,
    "round 2: the suppressed finding names the same row and the delta reason",
  );
  assert(
    (await readBranchRows(repo, "feat/x")).length === 1,
    "round 2: the same row is updated, not duplicated",
  );

  // Round 3 — the operator accepts it; a full review keeps it suppressed.
  const acc = await acceptRow({
    cwd: repo,
    branch: "feat/x",
    rowId,
    reason: "known; tracked for the next release",
    by: "op@example.com",
  });
  assert(acc.ok, "round 3: the operator accepts the row by id");
  const r3 = await runLensReview({ ...common, diff: FULL_DIFF, full: true, head: c2 });
  assert(
    r3.verdict === "APPROVED" && r3.suppressed?.[0]?.reason.includes("op@example.com") === true,
    "round 3: the accepted finding is suppressed on a full review and the verdict is APPROVED",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
