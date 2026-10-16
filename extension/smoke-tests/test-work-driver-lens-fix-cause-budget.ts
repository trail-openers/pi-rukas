#!/usr/bin/env bun
/**
 * #981 — the lens-fix integration failure keeps BOTH halves of its evidence.
 *
 * `landCommittedFix` throws a conflict / patch-apply message that the catch
 * slices to `CAUSE_BUDGET` before returning it (the throw carries a
 * restoreClaim, so the catch takes the single-slice return rather than
 * re-restoring). At the old 300-char budget the NOT-restored claim plus
 * MANUAL_REPAIR_HINT filled the slice on its own and every conflicting
 * filename dropped out — the operator was told whether repoRoot needed repair
 * and never which file conflicted.
 *
 * Three assertions, one per `restoreClaim` shape (restored / restored with
 * untracked files / NOT restored):
 *   - the CAUSE_BUDGET constant in source is at least as long as the real
 *     `causeMsg` the source composes for that shape — the guarantee that
 *     nothing downstream can cut the path list off;
 *   - `restoreClaim` at that shape really contains its claim AND the
 *     `Conflicting paths:` text, composed the way the source composes it;
 *   - against REAL git (a genuine cherry-pick conflict), the returned error
 *     carries the verified restore claim and both conflicting filenames.
 *
 * Offline: temp directories and real git; no Pi spawn.
 */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { renderConflictPath } from "../src/work-driver-conflict-evidence.ts";
import { landCommittedFix } from "../src/work-driver-lens-fix-commit.ts";
import { type VerifiedRestoreResult, restoreClaim } from "../src/work-driver-restore.ts";
import type { PipelineState } from "../src/workflow-state-schema.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const SRC = path.resolve(import.meta.dirname, "../src/work-driver-lens-fix-commit.ts");

/** The slice budget the catch uses, read from source so the test cannot drift. */
function causeBudget(): number {
  const m = readFileSync(SRC, "utf8").match(/const CAUSE_BUDGET = (\d+);/);
  return m ? Number(m[1]) : 0;
}

/** The repair hint, read from source for the same reason. */
function manualRepairHint(): string {
  const m = readFileSync(SRC, "utf8").match(/const MANUAL_REPAIR_HINT =\s*\n?\s*"([^"]+)"/);
  return m?.[1] ?? "";
}

const CONFLICT_PATHS = ["conflict.txt", "also-conflict.txt"];
/** The clause `conflictPathsClause` renders for a real two-path conflict. */
const pathsClause = `Conflicting paths: ${CONFLICT_PATHS.map(renderConflictPath).join(", ")}.`;

// The worst case the message composes: the not-restored claim carries up to
// ten dirty paths (`verifiedRestoreRoot` caps its dirt list at ten) and a
// preserved-diff path, and the path clause names up to ten conflicting files
// (`collectConflictEvidence` reads the whole index) — measured here so the
// budget is not guessed.
const MANY_PATHS = Array.from({ length: 10 }, (_, i) => `src/module-${i}/nested/file-${i}.ts`);
const MANY_DIRTY = Array.from(
  { length: 10 },
  (_, i) => `src/mod-${i}/deeply/nested/f-${i}.ts`,
).join(", ");

const SHAPES: Array<{ name: string; restore: VerifiedRestoreResult; expect: string }> = [
  {
    name: "restored",
    restore: { restored: true },
    expect: "repoRoot was verified restored",
  },
  {
    name: "restored-with-untracked",
    restore: {
      restored: true,
      untracked: Array.from({ length: 12 }, (_, i) => `operator-notes-${i}.md`),
    },
    expect: "repoRoot checkout was restored, but 12 untracked file(s) remain",
  },
  {
    name: "NOT restored",
    restore: {
      restored: false,
      detail: `repoRoot was NOT restored — still dirty after reset + checkout: ${MANY_DIRTY}`,
      preservedAt: "/tmp/pi-rukas/scratch/lens-fix-integration-1700000000000.diff",
    },
    expect: "repoRoot was NOT restored",
  },
];

const BUDGET = causeBudget();
const HINT = manualRepairHint();
assert(BUDGET > 300, `the catch's slice budget is raised past 300 (got ${BUDGET})`);
assert(HINT.length > 0, "the repair hint was read from source (test cannot silently pass)");
// The canary: the budget check above must be able to fail. At the pre-#981
// 300-char budget the not-restored claim alone filled the slice, so the
// longest shape is measured here and asserted NOT to fit inside 300 — if the
// shape ever shrinks below that, the fit assertion is vacuous and this fires.
assert(
  restoreClaim(SHAPES[2].restore, { trailing: HINT }).length > 300,
  "canary: the not-restored claim alone exceeds the old 300-char slice — the fit check can fail",
);
for (const s of SHAPES) {
  const claim = restoreClaim(s.restore, { trailing: HINT });
  // The longest causeMsg this shape can compose: the cherry-pick-conflict
  // wording, the tree path interpolated, and a path clause at its worst.
  const clause = `Conflicting paths: ${MANY_PATHS.map(renderConflictPath).join(", ")}.`;
  const causeMsg = `cherry-pick conflict — the batch was aborted. ${claim} ${clause} The fix's commits remain in the worktree ${"/tmp/pi-lens-fix-cause-budget-XXXXXXXXXX/repo/.worktrees/issue-981-default"}.`;
  assert(
    causeMsg.length <= BUDGET,
    `${s.name}: the whole causeMsg (${causeMsg.length} chars, ${MANY_PATHS.length} conflicting paths) fits inside the ${BUDGET}-char budget`,
  );
  assert(
    claim.includes(s.expect) && clause.includes("`src/module-0/nested/file-0.ts`"),
    `${s.name}: the claim and the path clause are both present when composed`,
  );
}

// ── Real git: the returned error carries the claim AND both filenames.
const realExec: ExecFn = async (cmd, o) => {
  if (o?.argv) {
    const { stdout } = await execFileP(cmd, o.argv, {
      cwd: o.cwd,
      maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  }
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};
const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", args, { cwd })).stdout.trim();

const root = mkdtempSync(path.join(tmpdir(), "pi-lens-fix-cause-budget-"));
try {
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "conflict.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "also-conflict.txt"), "one\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  appendFileSync(path.join(repo, ".git", "info", "exclude"), "tmp/\n");
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  const setup = await mechanizedBranchSetup(realExec, repo, 981, [981], [], "cause-budget");
  const wt = setup.worktrees.default ?? "";
  const branch = setup.branchName;

  // The fixer's commit and a later branch-side commit edit the SAME lines of
  // two files, so the cherry-pick conflicts and the evidence names both.
  writeFileSync(path.join(wt, "conflict.txt"), "one\nFIXED BY THE REVIEW\nthree\n");
  writeFileSync(path.join(wt, "also-conflict.txt"), "ALSO FIXED\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "lens fix"]);
  await git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(path.join(repo, "conflict.txt"), "one\nBRANCH SIDE\nthree\n");
  writeFileSync(path.join(repo, "also-conflict.txt"), "BRANCH SIDE\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "branch-side change"]);

  const ps = {
    branchName: branch,
    baseSha: setup.baseSha,
    reviewRound: 1,
  } as PipelineState;
  const r = await landCommittedFix(realExec, { repoRoot: repo, issue: 981 }, ps, wt);
  assert(r.ok === false, `the conflicting pick fails (${r.ok ? "ok" : "failed"})`);
  const err = r.ok ? "" : r.error;
  assert(
    err.includes("repoRoot was verified restored") || err.includes("repoRoot was NOT restored"),
    `real conflict: the error carries the verified restore claim (${err.slice(0, 90)}…)`,
  );
  assert(
    err.includes("Conflicting paths:") &&
      err.includes("`conflict.txt`") &&
      err.includes("`also-conflict.txt`"),
    "real conflict: the error names BOTH conflicting files, not just the restore state",
  );
  assert(
    err.includes("The fix's commits remain in the worktree"),
    "real conflict: the error keeps the worktree pointer",
  );
  await git(repo, ["cherry-pick", "--abort"]).catch(() => undefined);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
