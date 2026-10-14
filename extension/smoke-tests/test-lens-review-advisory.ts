#!/usr/bin/env bun
/**
 * #1140 — carried findings on files outside the PR's diff are advisory.
 *
 * Lens children are injected (`lensChildFn`), so no Pi child is spawned. A
 * temp clone has `main` (src/a.ts, src/other.ts) and `feat/x`, which changes
 * only src/a.ts:
 *   1. round 1 records a HIGH on src/a.ts and a CRITICAL on src/other.ts (the
 *      #1133 phantom-row shape);
 *   2. round 2 reports nothing, so both rows are carried. Against main...feat/x
 *      the CRITICAL on src/other.ts is advisory: the verdict is ISSUES_FOUND
 *      (the in-diff HIGH still blocks), hasCritical is false on the ledger
 *      entry, and the summary lists it under "Advisory (outside this PR's diff)";
 *   3. an unreadable changed-file list keeps every carried row blocking
 *      (CRITICAL_ISSUES_FOUND) and the summary says why;
 *   4. a carried row with no path blocks; the PR residual disclosure lists the
 *      advisory rows; the store rows are unchanged.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADVISORY_HEADING, splitCarried } from "../src/lens-review-advisory.ts";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { renderSummary, runLensReview } from "../src/lens-review.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { readBranchRows } from "../src/review-findings-store.ts";
import { commandOf } from "./lib/argv-shell.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "lens-advisory-"));
const repo = path.join(root, "repo");
const skills = path.join(root, "skills");
const ledgerDir = path.join(root, "ledger");
const ledgerFile = path.join(ledgerDir, "review-ledger.json");
mkdirSync(path.join(repo, "src"), { recursive: true });
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
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
process.env.PI_ENSEMBLE_SKILLS_DIR = skills;

const sh = (cmd: string) =>
  execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
sh("git init -q -b main");
sh("git config user.email dev@example.com");
sh("git config user.name dev");
const lines = (n: number, tag: string) =>
  `${Array.from({ length: n }, (_, i) => `// ${tag} ${i + 1}`).join("\n")}\n`;
writeFileSync(path.join(repo, "src", "a.ts"), lines(10, "a"));
writeFileSync(path.join(repo, "src", "other.ts"), lines(10, "other"));
sh("git add -A");
sh("git commit -qm base");
// A remote mainline, so the ledger writer can compute a patch id.
execSync(`git init -q --bare -b main ${path.join(root, "remote.git")}`);
sh(`git remote add origin ${path.join(root, "remote.git")}`);
sh("git push -q origin main");
sh("git fetch -q origin");
sh("git checkout -q -b feat/x");
writeFileSync(path.join(repo, "src", "a.ts"), `${lines(10, "a")}// changed\n`);
sh("git commit -qam change");

type Raw = { severity: string; path: string; line: number; title: string };
let report: Raw[] = [];
const stubLens = async (args: { lens: { name: string } }): Promise<LensRunResult> =>
  ({
    lens: args.lens.name,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    summary: "reviewed the diff",
    findings:
      args.lens.name === LENS_ROSTER[0]?.name
        ? report.map((f) => ({ lens: args.lens.name, ...f }))
        : [],
  }) as unknown as LensRunResult;

const DIFF = "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+// changed";
const common = {
  cwd: repo,
  branch: "feat/x",
  head: "feat/x",
  diff: DIFF,
  lensChildFn: stubLens as never,
};
const latestLensEntry = (): Record<string, unknown> | undefined => {
  const entries = JSON.parse(readFileSync(ledgerFile, "utf8")).entries as Record<string, unknown>[];
  return entries.filter((e) => e.kind === "lens").at(-1);
};
/** Wait until the branch's lens entry records round `n` (one lens row per branch). */
const waitForRound = async (n: number) => {
  for (let i = 0; i < 250; i++) {
    try {
      if (latestLensEntry()?.round === n) return;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};

try {
  // 1. Round 1 records an in-diff HIGH and a phantom out-of-diff CRITICAL.
  report = [
    { severity: "HIGH", path: "src/a.ts", line: 3, title: "in-diff problem" },
    { severity: "CRITICAL", path: "src/other.ts", line: 5, title: "phantom critical" },
  ];
  const r1 = await runLensReview({ ...common, base: "main" });
  assert(r1.verdict === "CRITICAL_ISSUES_FOUND", "round 1: fresh findings are never advisory");
  const rowsBefore = await readBranchRows(repo, "feat/x");
  assert(rowsBefore.length === 2, "round 1: both rows are recorded open");

  // 2. Round 2 reports nothing: both rows are carried.
  report = [];
  await waitForRound(1);
  const r2 = await runLensReview({ ...common, base: "main" });
  assert(
    r2.verdict === "ISSUES_FOUND",
    `round 2: the out-of-diff CRITICAL does not decide the verdict (got ${r2.verdict})`,
  );
  assert(
    r2.findings.length === 1 && r2.findings[0]?.path === "src/a.ts",
    "round 2: the carried row inside the diff still blocks, as before",
  );
  assert(
    r2.advisory?.length === 1 && r2.advisory[0]?.path === "src/other.ts",
    "round 2: the carried row outside the diff is listed as advisory",
  );
  assert(r2.bySeverity.CRITICAL === 0, "round 2: the advisory CRITICAL is not counted");
  await waitForRound(2);
  assert(
    latestLensEntry()?.hasCritical === false,
    "round 2: the ledger entry records hasCritical: false",
  );
  const text = renderSummary(r2, 4);
  assert(
    text.includes(ADVISORY_HEADING) && text.includes("phantom critical"),
    "round 2: the summary lists the advisory row under its heading",
  );
  const rowsAfter = await readBranchRows(repo, "feat/x");
  assert(
    rowsAfter.length === 2 && rowsAfter.every((r) => r.status === "open"),
    "the store rows are unchanged (no deletion, no status change)",
  );

  // 3. An unreadable changed-file list keeps every carried row blocking.
  const r3 = await runLensReview({ ...common, base: "no-such-ref" });
  assert(
    r3.verdict === "CRITICAL_ISSUES_FOUND" && !r3.advisory,
    "an unreadable changed-file list keeps every carried row blocking (today's behaviour)",
  );
  assert(
    /changed-file list could not be read/.test(r3.memoryNote ?? ""),
    "…and the summary says the list could not be read",
  );

  // 4a. A carried row with no path stays blocking.
  const split = await splitCarried(
    {
      ok: true,
      carried: [{ lens: "SECURITY", severity: "CRITICAL", path: "", title: "no path" } as never],
    },
    repo,
    "main",
    sh("git rev-parse HEAD"),
  );
  assert(split.blocking.length === 1 && !split.fields.advisory, "a row with no path blocks");
  const none = await splitCarried({ ok: false }, repo, "no-such-ref", undefined);
  assert(
    none.blocking.length === 0 && !none.fields.memoryNote,
    "no carried rows → no git read and no note",
  );

  // 4b. The PR residual disclosure lists the advisory rows.
  process.env.PI_ENSEMBLE_FORGE = "github";
  let body = "";
  const execFn = async (cmd0: string, o?: { argv?: string[] }): Promise<{ stdout: string }> => {
    const cmd = commandOf(cmd0, o);
    if (cmd.includes("pr list --state open --head feat/x")) {
      return { stdout: JSON.stringify([{ number: 12 }]) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: "feat/x", baseRefName: "main" }) };
    }
    if (cmd.includes("pr comment")) {
      const file = /--body-file\s+'?([^'\s]+)'?/.exec(cmd)?.[1] ?? "";
      body = readFileSync(file, "utf8");
      return { stdout: "" };
    }
    if (cmd.startsWith("git diff ")) return { stdout: "diff --git a/x b/x\n+x\n" };
    if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
    if (cmd.includes("git remote")) return { stdout: "origin\n" };
    if (cmd.includes("git config --get remote")) return { stdout: "git@github.com:o/r.git\n" };
    return { stdout: "" };
  };
  await postLensResidualDisclosure({ summary: r2, branch: "feat/x", cwd: repo, execFn });
  assert(
    body.includes(ADVISORY_HEADING) && body.includes("src/other.ts:5"),
    "the PR residual disclosure lists the advisory row under its heading",
  );
  assert(body.includes("pi-rukas:lens-residuals"), "the disclosure marker is unchanged");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
