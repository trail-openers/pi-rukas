#!/usr/bin/env bun
/**
 * #1300 round 2 — the head probe decides "absent" from git's output, not its
 * error wording; the store judges each path by one tagged head state; and an
 * accepted row carrying a stray resolvedReason is set aside on its own (the
 * valid rows, including the operator's acceptance of other rows, survive).
 *
 * Offline, against a real throwaway repo:
 *   1. readHeadLines: a blob → lines; an absent path → missing; a glob-looking
 *      path → missing (literal pathspec); a directory → invalid; a bad commit → error.
 *   2. recordFindingRunOutcome: a finding on an absent path is recorded as a
 *      no-line row and the round is NOT refused; a later full review with no
 *      findings resolves that row `path-gone`; a finding on a directory is
 *      carried on the same full review (invalid has no automatic exit).
 *   3. An accepted row with a stray resolvedReason is set aside individually.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFindingsFile } from "../src/review-findings-file.ts";
import { readHeadLines } from "../src/review-findings-head.ts";
import { readBranchRows, recordFindingRunOutcome } from "../src/review-findings-store.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "findings-head-state-"));
const repo = path.join(root, "repo");
const ledgerDir = path.join(root, "ledger");
mkdirSync(repo);
mkdirSync(ledgerDir);
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(ledgerDir, "review-ledger.json");
const FINDINGS = path.join(ledgerDir, "review-findings.json");
const BRANCH = "feat/x";

const sh = (cmd: string) =>
  execSync(cmd, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
sh("git init -q -b feat/x");
sh("git config user.email dev@example.com");
sh("git config user.name dev");
mkdirSync(path.join(repo, "src"));
writeFileSync(
  path.join(repo, "src", "a.ts"),
  "// header\nexport function alpha(x: number) {\n  const a = x + 1;\n  return a * 2;\n}\n",
);
sh("git add -A");
sh("git commit -qm one");
const head = sh("git rev-parse HEAD");

const finding = (p: string, title: string) => ({
  lens: "architecture",
  severity: "MEDIUM" as const,
  path: p,
  line: 3,
  title,
});

try {
  // 1. The probe.
  const blob = await readHeadLines(repo, head, "src/a.ts");
  assert(blob.kind === "lines" && blob.lines[1]?.includes("alpha"), "probe: a blob reads as lines");
  const gone = await readHeadLines(repo, head, "src/gone.ts");
  assert(gone.kind === "missing", "probe: an absent path is missing (not an error)");
  const glob = await readHeadLines(repo, head, "src/*.ts");
  assert(glob.kind === "missing", "probe: a glob-looking path is missing (literal pathspec)");
  const dir = await readHeadLines(repo, head, "src");
  assert(dir.kind === "invalid", "probe: a directory at head is invalid");
  const badSha = await readHeadLines(repo, "0".repeat(40), "src/a.ts");
  assert(badSha.kind === "error", "probe: an unreadable commit is an error (round refused)");

  // 2. The recorder. A wrong path and a directory are recorded as no-line rows
  // without refusing the round.
  const r1 = await recordFindingRunOutcome({
    cwd: repo,
    branch: BRANCH,
    headSha: head,
    findings: [finding("src/gone.ts", "Missing null check"), finding("src", "Dir cited")],
    review: "full",
  });
  assert(r1.ok, "record: a finding on an absent path does not refuse the round");
  const rows = await readBranchRows(repo, BRANCH);
  assert(
    rows.length === 2 && rows.every((r) => r.line === undefined),
    "record: both no-file findings are recorded as no-line rows",
  );
  // A full review with nothing reported: the absent path resolves path-gone; the
  // directory row is carried (no evidence the code is gone).
  const r2 = await recordFindingRunOutcome({
    cwd: repo,
    branch: BRANCH,
    headSha: head,
    findings: [],
    review: "full",
  });
  assert(
    r2.ok &&
      r2.resolved.length === 1 &&
      r2.resolved[0]?.reason === "path-gone" &&
      r2.carried.length === 1 &&
      r2.carried[0]?.path === "src",
    "record: full review resolves the absent-path row (path-gone) and carries the directory row",
  );

  // 3. A legacy accepted row with a stray resolvedReason is set aside on its own.
  const accepted = {
    id: "aaaaaaaa",
    branch: BRANCH,
    path: "src/a.ts",
    anchor: "alpha",
    titleClass: "division",
    title: "Division by zero possible",
    severity: "MEDIUM",
    lens: "architecture",
    line: 4,
    snippetHash: "0".repeat(16),
    firstSeen: 1,
    lastSeen: 1,
    status: "accepted",
    acceptance: {
      by: "op@example.com",
      reason: "tracked elsewhere, fine",
      at: 1,
      snippetHash: "0".repeat(16),
    },
  };
  const stray = { ...accepted, id: "bbbbbbbb", resolvedReason: "code-gone" };
  writeFileSync(FINDINGS, JSON.stringify({ rows: [accepted, stray] }));
  const parsed = parseFindingsFile(FINDINGS);
  assert(
    parsed.ok && parsed.rows.length === 1 && parsed.malformed.length === 1,
    "file: the stray-resolvedReason row is malformed on its own; the file still parses",
  );
  await recordFindingRunOutcome({
    cwd: repo,
    branch: BRANCH,
    headSha: head,
    findings: [],
    review: "full",
  });
  const kept = await readBranchRows(repo, BRANCH);
  assert(
    kept.some((r) => r.id === "aaaaaaaa" && r.status === "accepted"),
    "file: the operator's valid acceptance survives the write-back",
  );
  assert(
    readdirSync(ledgerDir).some((f) => f.startsWith("review-findings.json.corrupt-")),
    "file: the malformed row is set aside to a .corrupt- copy",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
