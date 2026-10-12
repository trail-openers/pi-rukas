#!/usr/bin/env bun
/**
 * #1105 — a finding citing a path that is missing at the head commit does not
 * disable the findings memory for the run (offline, through `runLensReview`).
 *
 * Lens children are injected (`lensChildFn`). One lens reports two findings on
 * one round: one on `src/gone.ts` (a wrong path a lens cited — absent at head)
 * and one on the real `src/a.ts`. Then:
 *   1. the run records: no memoryNote, both rows exist, the real-file row keeps
 *      its normal identity (anchor + cited line + snippet), and the missing-path
 *      row is a no-line row (anchor `file`, no line);
 *   2. both findings are reported and the verdict is ISSUES_FOUND;
 *   3. the operator accepts the missing-path row by id — a later full review
 *      still reports it, because a missing path is never suppressed.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptRow } from "../scripts/review-accept-row.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { runLensReview } from "../src/lens-review.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { snippetHashAt } from "../src/review-findings-match.ts";
import { readBranchRows } from "../src/review-findings-store.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "findings-missing-"));
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
// The lines the store reads at head: git shows the file with its trailing newline.
const HEAD = `${SRC.join("\n")}\n`.split("\n");
mkdirSync(path.join(repo, "src"));
writeFileSync(path.join(repo, "src", "a.ts"), HEAD.join("\n"));
sh("git add -A");
sh("git commit -qm one");
const c1 = sh("git rev-parse HEAD");

// The first lens reports a finding on a path that does not exist at head, and
// one on the real file. Every lens answers with evidence, so the round is complete.
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
    findings: first
      ? [
          {
            lens: args.lens.name,
            severity: "MEDIUM",
            path: "src/gone.ts",
            line: 3,
            title: "Missing null check",
          },
          {
            lens: args.lens.name,
            severity: "MEDIUM",
            path: "src/a.ts",
            line: 4,
            title: "Division by zero possible",
          },
        ]
      : [],
  } as unknown as LensRunResult;
};

const common = { cwd: repo, branch: "feat/x", lensChildFn: stubLens as never };
const FULL_DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export function alpha(x: number) {";

try {
  // Round 1 — the run records despite the missing path.
  const r1 = await runLensReview({ ...common, diff: FULL_DIFF, head: c1 });
  assert(r1.memoryNote === undefined, "round 1: the run records (memoryNote is unset)");
  assert(
    r1.findings.length === 2 && r1.verdict === "ISSUES_FOUND",
    `round 1: both findings are reported (verdict ${r1.verdict})`,
  );
  const rows = await readBranchRows(repo, "feat/x");
  const real = rows.find((r) => r.path === "src/a.ts");
  const gone = rows.find((r) => r.path === "src/gone.ts");
  assert(rows.length === 2, "round 1: one row per finding is recorded");
  assert(
    real?.anchor === "alpha" && real.line === 4 && real.snippetHash === snippetHashAt(HEAD, 4),
    "round 1: the real-file finding keeps its normal identity (anchor, line, snippet)",
  );
  assert(
    gone?.anchor === "file" && gone.line === undefined,
    "round 1: the missing-path finding is a no-line row (anchor file, no line)",
  );

  // Round 2 — the operator accepts the missing-path row; a full review still
  // reports it, because a path absent at head is never suppressed.
  const acc = await acceptRow({
    cwd: repo,
    branch: "feat/x",
    rowId: gone?.id ?? "",
    reason: "wrong path cited; tracked elsewhere",
    by: "op@example.com",
  });
  assert(acc.ok, "round 2: the operator accepts the missing-path row by id");
  const r2 = await runLensReview({ ...common, diff: FULL_DIFF, full: true, head: c1 });
  assert(
    r2.findings.some((f) => f.path === "src/gone.ts") &&
      !(r2.suppressed ?? []).some((s) => s.finding.path === "src/gone.ts"),
    "round 2: the accepted missing-path finding is still reported, not suppressed",
  );
  assert(r2.memoryNote === undefined, "round 2: the run still records (memoryNote is unset)");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
