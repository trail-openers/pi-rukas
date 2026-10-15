#!/usr/bin/env bun
/**
 * #1105 — an open row is RESOLVED (not carried into the verdict) by a complete
 * full review when its path is gone at head, or when it has no line and this
 * review did not re-report it (offline, through `runLensReview`).
 *
 * Each scenario runs on its own branch, with a complete full review each round:
 *   A. the PR deletes the file an open row cites → the row resolves and the
 *      verdict is APPROVED (the row does not block it);
 *   B. a no-line open row the next complete review does not re-report, on a
 *      present file, stays open (its cited code still stands);
 *   C. a no-line open row the next complete review DOES re-report → stays open;
 *   D. the cited line is past the end of the file → resolves;
 *   E. a neighbour edit inside the ±2 window → carried (the cited line stands);
 *   F. the cited line is edited, no re-report, complete full review → resolves
 *      (reason code-gone) and the verdict is APPROVED (#1130);
 *   G. unchanged cited code, no re-report → stays open, carried with its title;
 *   H. an insertion above the cited code → stays open (the window moved);
 *   I. an edit outside the cited window → stays open;
 *   J. a delta review never resolves; K. an incomplete review never resolves.
 *   L. a CRITICAL row whose window is edited (no re-report, complete full review)
 *      is carried — a trivial edit cannot clear a CRITICAL;
 *   M. the cited line is past EOF but its code moved up the file: carried, not
 *      resolved ("found anywhere → carried" wins over "line past EOF");
 *   N. a past-EOF row on a delta review: carried (a delta never resolves);
 *   O. a HIGH row whose window gets a comment, cited line unchanged: carried;
 *   P. a legacy row without lineHash whose window is edited: carried.
 * Every resolution records its reason on the row and in the summary (#1125).
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { runLensReview } from "../src/lens-review.ts";
import { renderSummary } from "../src/lens-review-format.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { FINDINGS_FILE, readBranchRows } from "../src/review-findings-store.ts";

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
// When set, every lens but the first is blocked: the review is incomplete.
let blockNonFirst = false;
const stubLens = async (args: { lens: { name: string } }): Promise<LensRunResult> => {
  const first = args.lens.name === LENS_ROSTER[0]?.name;
  const blocked = !first && blockNonFirst;
  return {
    lens: args.lens.name,
    ok: !blocked,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked,
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
    aRows.length === 1 && aRows[0]?.status === "resolved" && aRows[0]?.resolvedReason === "path-gone",
    "A round 2: the open row whose path is gone at head resolves, reason path-gone",
  );
  assert(
    a2.verdict === "APPROVED" && a2.findings.length === 0,
    `A round 2: the resolved row does not block the verdict (verdict ${a2.verdict})`,
  );

  // B — a no-line open row the next complete review does not re-report stays open.
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
    bRows.length === 1 && bRows[0]?.status === "open",
    "B round 2: the no-line row not re-reported on a present file stays open",
  );
  assert(
    b2.verdict === "ISSUES_FOUND" && b2.findings.some((f) => f.title === "Unclear naming"),
    `B round 2: the carried no-line finding still blocks (${b2.verdict})`,
  );

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
    dRows.length === 1 &&
      dRows[0]?.status === "resolved" &&
      dRows[0]?.resolvedReason === "line-past-eof",
    "D round 2: an open row whose cited line is past the end of the file resolves, reason line-past-eof",
  );
  assert(d2.verdict === "APPROVED", `D round 2: the verdict is not blocked (${d2.verdict})`);

  // E — a neighbour edit changes the ±2-line window hash, but the cited line
  // itself is unchanged (its lineHash is still at head): the row is carried.
  // A window edit alone never resolves a row (#1300).
  sh("git checkout -q main");
  sh("git checkout -q -b feat/neighbour");
  await runRound("feat/neighbour", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  assert(
    typeof (await readBranchRows(repo, "feat/neighbour"))[0]?.lineHash === "string",
    "E round 1: a new row records the hash of its cited line (lineHash)",
  );
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\nexport const a = 9;\nexport const b = 2;\n");
  sh("git commit -qam neighbour");
  const e2 = await runRound("feat/neighbour", head(), []);
  assert(
    (await readBranchRows(repo, "feat/neighbour"))[0]?.status === "open" &&
      e2.verdict === "ISSUES_FOUND",
    `E round 2: a neighbour edit inside the window keeps the row carried (verdict ${e2.verdict})`,
  );

  // F — #1130: the cited line itself is edited and a complete full review does
  // not re-report it. The row resolves and does not block the verdict.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/edited");
  await runRound("feat/edited", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\nexport const a = 1;\nexport const b = 3;\n");
  sh("git commit -qam edit-cited-line");
  const f2 = await runRound("feat/edited", head(), []);
  assert(
    (await readBranchRows(repo, "feat/edited"))[0]?.status === "resolved",
    "F round 2: an edited cited line with no re-report resolves the row (#1130)",
  );
  assert(f2.verdict === "APPROVED", `F round 2: the verdict is APPROVED (${f2.verdict})`);
  assert(
    (await readBranchRows(repo, "feat/edited"))[0]?.resolvedReason === "code-gone" &&
      renderSummary(f2, 1).includes("Resolved since last round") &&
      renderSummary(f2, 1).includes("code-gone"),
    "F round 2: the reason code-gone is on the row and in the rendered summary",
  );

  // G — the cited code is unchanged and no re-report: the row stays open and is
  // carried with its stored, non-empty title.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/unchanged");
  await runRound("feat/unchanged", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  writeFileSync(path.join(repo, "src", "keep.ts"), "export const k = 4;\n");
  sh("git commit -qam unrelated");
  const g2 = await runRound("feat/unchanged", head(), []);
  const gRow = (await readBranchRows(repo, "feat/unchanged"))[0];
  assert(gRow?.status === "open", "G round 2: unchanged cited code stays open");
  assert(
    g2.verdict === "ISSUES_FOUND" &&
      g2.findings.some((f) => f.title === "Unused constant"),
    `G round 2: the carried finding blocks with its stored title (${g2.verdict})`,
  );

  // H — an insertion above the cited code moves the line; the window is still
  // at head, so the row is carried, not resolved.
  const longLines = Array.from({ length: 10 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
  sh("git checkout -q main");
  sh("git checkout -q -b feat/shift");
  writeFileSync(path.join(repo, "src", "long.ts"), `${longLines.join("\n")}\n`);
  sh("git add -A");
  sh("git commit -qm long");
  await runRound("feat/shift", head(), [
    { severity: "MEDIUM", path: "src/long.ts", line: 6, title: "Unused value" },
  ]);
  writeFileSync(path.join(repo, "src", "long.ts"), `// new header\n${longLines.join("\n")}\n`);
  sh("git commit -qam insert-above");
  const h2 = await runRound("feat/shift", head(), []);
  assert(
    (await readBranchRows(repo, "feat/shift"))[0]?.status === "open" &&
      h2.verdict === "ISSUES_FOUND",
    `H round 2: an insertion above the cited code keeps the row carried (${h2.verdict})`,
  );

  // I — an edit outside the ±2 window leaves the window hash findable: carried.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/far");
  writeFileSync(path.join(repo, "src", "long.ts"), `${longLines.join("\n")}\n`);
  sh("git add -A");
  sh("git commit -qm long");
  await runRound("feat/far", head(), [
    { severity: "MEDIUM", path: "src/long.ts", line: 6, title: "Unused value" },
  ]);
  writeFileSync(
    path.join(repo, "src", "long.ts"),
    `${longLines.slice(0, 9).join("\n")}\nexport const v10 = 99;\n`,
  );
  sh("git commit -qam edit-far");
  await runRound("feat/far", head(), []);
  assert(
    (await readBranchRows(repo, "feat/far"))[0]?.status === "open",
    "I round 2: an edit outside the cited window keeps the row carried",
  );

  // J — a delta review never resolves, even when the cited code changed.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/delta");
  await runRound("feat/delta", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  const deltaBase = head();
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\nexport const a = 1;\nexport const b = 3;\n");
  sh("git commit -qam edit-cited-line");
  const j2 = await runLensReview({
    cwd: repo,
    branch: "feat/delta",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+export const b = 3;",
    head: head(),
    since: deltaBase,
    lensChildFn: stubLens as never,
  });
  assert(
    (await readBranchRows(repo, "feat/delta"))[0]?.status === "open",
    `J round 2: a delta review does not resolve a changed-code row (verdict ${j2.verdict})`,
  );

  // K — an incomplete review (a blocked lens) never resolves a row.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/incomplete");
  await runRound("feat/incomplete", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\nexport const a = 1;\nexport const b = 3;\n");
  sh("git commit -qam edit-cited-line");
  blockNonFirst = true;
  const k2 = await runRound("feat/incomplete", head(), []);
  blockNonFirst = false;
  assert(
    (await readBranchRows(repo, "feat/incomplete"))[0]?.status === "open",
    `K round 2: an incomplete review does not resolve a changed-code row (verdict ${k2.verdict})`,
  );

  // L — a CRITICAL row whose ±2 window is edited (a comment on line 1, inside the
  // window of line 3), no re-report, complete full review: carried, still blocks.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/critical-edit");
  await runRound("feat/critical-edit", head(), [
    { severity: "CRITICAL", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  writeFileSync(path.join(repo, "src", "a.ts"), "// header v2\nexport const a = 1;\nexport const b = 2;\n");
  sh("git commit -qam window-edit");
  const l2 = await runRound("feat/critical-edit", head(), []);
  const lRow = (await readBranchRows(repo, "feat/critical-edit"))[0];
  assert(
    lRow?.status === "open" && l2.verdict === "CRITICAL_ISSUES_FOUND",
    `L round 2: a window edit does not clear a CRITICAL row; it stays carried and blocks (${l2.verdict})`,
  );

  // M — the cited line 50 is past EOF after 40 lines are deleted above it, but the
  // window of line 50 is still at head (now line 10): carried, not resolved.
  const fifty = Array.from({ length: 60 }, (_, i) =>
    i + 1 === 50 ? "export const target = 50;" : `export const f${i + 1} = ${i + 1};`,
  );
  sh("git checkout -q main");
  sh("git checkout -q -b feat/moved-up");
  writeFileSync(path.join(repo, "src", "fifty.ts"), `${fifty.join("\n")}\n`);
  sh("git add -A");
  sh("git commit -qm fifty");
  await runRound("feat/moved-up", head(), [
    { severity: "MEDIUM", path: "src/fifty.ts", line: 50, title: "Unused target" },
  ]);
  writeFileSync(path.join(repo, "src", "fifty.ts"), `${fifty.slice(40).join("\n")}\n`);
  sh("git commit -qam delete-above");
  const m2 = await runRound("feat/moved-up", head(), []);
  const mRow = (await readBranchRows(repo, "feat/moved-up"))[0];
  assert(
    mRow?.status === "open" && m2.verdict === "ISSUES_FOUND",
    `M round 2: a cited line past EOF whose code is still in the file stays carried (${m2.verdict})`,
  );
  // N — a delta review carries a past-EOF row: the cited line is gone, but a
  // delta never resolves, so the open finding stays in the verdict.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/eof-delta");
  await runRound("feat/eof-delta", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  const eofBase = head();
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\n");
  sh("git commit -qam truncate-delta");
  const n2 = await runLensReview({
    cwd: repo,
    branch: "feat/eof-delta",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n-export const b = 2;",
    head: head(),
    since: eofBase,
    lensChildFn: stubLens as never,
  });
  assert(
    (await readBranchRows(repo, "feat/eof-delta"))[0]?.status === "open" &&
      n2.verdict === "ISSUES_FOUND",
    `N round 2: a past-EOF row on a delta review is carried, not resolved (${n2.verdict})`,
  );

  // O — a HIGH (security) finding whose ±2 window gets a comment inserted while
  // its cited line is unchanged: a complete full review that does not re-report
  // it keeps the row carried, and the HIGH blocks.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/high-window");
  await runRound("feat/high-window", head(), [
    { lens: "security", severity: "HIGH", path: "src/a.ts", line: 3, title: "Unvalidated export" },
  ]);
  writeFileSync(
    path.join(repo, "src", "a.ts"),
    "// header\n// a reviewer-visible note\nexport const a = 1;\nexport const b = 2;\n",
  );
  sh("git commit -qam insert-comment-in-window");
  const o2 = await runRound("feat/high-window", head(), []);
  assert(
    (await readBranchRows(repo, "feat/high-window"))[0]?.status === "open" &&
      o2.verdict === "ISSUES_FOUND" &&
      o2.findings.some((f) => f.title === "Unvalidated export"),
    `O round 2: a window-only edit keeps a HIGH row carried and blocking (${o2.verdict})`,
  );

  // P — a legacy row (written before lineHash existed) whose window is edited:
  // it cannot prove its cited line changed, so it is carried, not resolved.
  sh("git checkout -q main");
  sh("git checkout -q -b feat/legacy");
  await runRound("feat/legacy", head(), [
    { severity: "MEDIUM", path: "src/a.ts", line: 3, title: "Unused constant" },
  ]);
  const findingsFile = path.join(ledgerDir, FINDINGS_FILE);
  const stored = JSON.parse(readFileSync(findingsFile, "utf8")) as { rows: Array<Record<string, unknown>> };
  for (const r of stored.rows) if (r.branch === "feat/legacy") delete r.lineHash;
  writeFileSync(findingsFile, JSON.stringify(stored));
  writeFileSync(path.join(repo, "src", "a.ts"), "// header\nexport const a = 9;\nexport const b = 2;\n");
  sh("git commit -qam legacy-window");
  const p2 = await runRound("feat/legacy", head(), []);
  assert(
    (await readBranchRows(repo, "feat/legacy"))[0]?.status === "open" &&
      p2.verdict === "ISSUES_FOUND",
    `P round 2: a legacy row without lineHash is carried on a window edit (${p2.verdict})`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
