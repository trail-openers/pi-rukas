/**
 * #1934 — the store-shaped fixture the confirmation tests share: a real clone
 * with a real review identity, an isolated ledger + findings store, and the
 * seeded open CRITICAL row a confirmation retires.
 *
 * Extracted from smoke-tests/test-review-findings-confirmed-retire.ts for the
 * AGENTS.md §12 500-line gate — the #1934 untouched-row cases pushed that file
 * over the cap, and the fixture plus its seeding helpers are the half that is
 * pure plumbing rather than assertion. Both the store-round file and the join
 * file build the SAME fixture, so the split also removes the two hand-copied
 * versions of the clone recipe drifting apart (the isolation contract below is
 * the kind of thing that silently stops isolating when one copy is edited).
 *
 * Isolation contract (load-bearing, copied verbatim from the sibling):
 * `PI_ENSEMBLE_REVIEW_LEDGER_FILE` pins BOTH the ledger and the findings store
 * into the fixture dir, so a round reads and writes only this test's files, and
 * the ledger a confirmation is read from is a file the test wrote. The env is
 * set only AFTER every git call, because a relative
 * `git rev-parse --git-common-dir` answer is resolved against `cwd`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Finding } from "../../src/lens-review-types.ts";
import { readBranchRows, recordFindingRunOutcome } from "../../src/review-findings-store.ts";
export { recordFindingRunOutcome } from "../../src/review-findings-store.ts";
import type { StoredFinding } from "../../src/review-findings-file.ts";
import { resetFindingsStateCache } from "../../src/review-state-path.ts";

/** The head content of `src/a.ts` every case cites line 3 of. */
export const HEAD_LINES = [
  "// header",
  "export function a() {",
  "  return unsafe(raw);", // the cited line — never changed by any case here
  "}",
  "export const b = 2;",
];
export const CITED = 3;

/** The finding round 1 files; identical line/path/title so round 2 re-reports it. */
export const FINDING: Finding = {
  lens: "PERFORMANCE",
  severity: "CRITICAL",
  path: "src/a.ts",
  line: CITED,
  title: "Unvalidated input reaches the executor",
};

export async function rowsOf(dir: string): Promise<StoredFinding[]> {
  return readBranchRows(dir, "feature/work");
}

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

export interface ConfirmationFixture {
  root: string;
  dir: string;
  ledgerFile: string;
  headSha: string;
}

/** Build an isolated clone whose head carries a fix in a DIFFERENT file, so the
 * cited line is byte-unchanged at head for every case built on it. */
export function makeFixture(): ConfirmationFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "conf-store-"));
  const dir = path.join(root, "repo");
  mkdirSync(dir, { recursive: true });
  const ledgerFile = path.join(root, "review-ledger.json");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "a.ts"), `${HEAD_LINES.join("\n")}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  // `workingTreePatchId` resolves the identity against `<remote>/<mainline>`, so
  // the fixture needs the same origin the real clone has — without it there is
  // no patch id, and a round with no identity consults no confirmation (AC2's
  // answer, never AC1's).
  const origin = path.join(root, "origin.git");
  git(root, "init", "--bare", "-q", "--initial-branch=main", origin);
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "checkout", "-q", "-b", "feature/work");
  writeFileSync(path.join(dir, "src", "fix.ts"), "// the fix, in a DIFFERENT file\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fix in another file");
  const headSha = git(dir, "rev-parse", "HEAD");
  // The env is pointed at THIS fixture only after every git call: a relative
  // `git rev-parse --git-common-dir` answer is resolved against `cwd`, so a
  // fixture that set the override first would key its store on a path under a
  // different directory than the one it writes to.
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
  process.env.PI_AGENT_DIR = path.join(root, "agent");
  resetFindingsStateCache();
  return { root, dir, ledgerFile, headSha };
}

/** Drop the fixture's env pins. Call from a `finally`, before `removeFixture`. */
export function releaseFixture(): void {
  delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  delete process.env.PI_AGENT_DIR;
  resetFindingsStateCache();
}

export function removeFixture(f: ConfirmationFixture): void {
  rmSync(f.root, { recursive: true, force: true });
}

export function writeLedger(file: string, entries: Array<Record<string, unknown>>): void {
  writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
}

/** Seed an open CRITICAL row through the real store (real hashes, real ids). */
export async function seed(dir: string, headSha: string): Promise<StoredFinding> {
  const out = await recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
  });
  if (!out.ok) throw new Error(`seed failed: ${out.reason}`);
  const rows = await readBranchRows(dir, "feature/work");
  const row = rows.find((r) => r.severity === "CRITICAL");
  if (!row) throw new Error("seed produced no CRITICAL row");
  return row;
}

/** A round that re-reports the finding, with confirmations consulted. */
export async function reReport(dir: string, headSha: string, patchId: string) {
  return recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [FINDING],
    review: "full",
    confirmFixes: true,
    patchId,
    now: Date.now() + 10_000,
  });
}

/** A round SILENT about the finding (the untouched-row shape), confirmations on. */
export async function silentRound(dir: string, headSha: string, patchId: string, now: number) {
  return recordFindingRunOutcome({
    cwd: dir,
    branch: "feature/work",
    headSha,
    findings: [],
    review: "full",
    confirmFixes: true,
    patchId,
    now,
  });
}
