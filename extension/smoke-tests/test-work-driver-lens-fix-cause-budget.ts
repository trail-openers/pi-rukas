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
 * The guarantee is asserted against the REAL builders, not a restatement of
 * them: `lensFixConflictCause` (exported from work-driver-conflict-evidence)
 * is called with each restore shape the REAL producers emit — `restoreClaim`
 * over `VerifiedRestoreResult` values built by `verifiedRestoreRoot` against
 * real git, by `saveFailedRestore` (the #1258 shape: a 160-char git error
 * plus a long repoRoot), and by the hand-built widest lists. So a widened
 * clause, a reordering that puts the long tail first, or a budget that stops
 * covering the sum of its parts all fail here.
 *
 *   - CAUSE_BUDGET is a derived sum (see work-driver-conflict-evidence.ts);
 *     this asserts every shape fits inside it, and that the restore claim and
 *     the FIRST conflicting path are both present after the slice;
 *   - the two short SHAs ride the returned message (they used to be only in
 *     the debug-gated trace line);
 *   - against REAL git (a genuine cherry-pick conflict), the returned error
 *     carries the verified restore claim and both conflicting filenames.
 *
 * Offline: temp directories and real git; no Pi spawn.
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import {
  CAUSE_BUDGET,
  MANUAL_REPAIR_HINT,
  RESTORE_CLAIM_BUDGET,
  collectConflictEvidence,
  conflictPathsClause,
  lensFixConflictCause,
} from "../src/work-driver-conflict-evidence.ts";
import { landCommittedFix } from "../src/work-driver-lens-fix-commit.ts";
import { restoreClaimCeiling } from "../src/work-driver-restore-claim-budget.ts";
import {
  type VerifiedRestoreResult,
  restoreClaim,
  verifiedRestoreRoot,
} from "../src/work-driver-restore.ts";
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

/** A path list long enough to exercise both bounds (per-entry and per-list). */
const MANY_PATHS = Array.from({ length: 24 }, (_, i) => `src/module-${i}/nested/file-${i}.ts`);
/** A single path well past the per-entry cap, to prove the ellipsis fires. */
const LONG_PATH = `deep/${"x".repeat(300)}/leaf.ts`;
/** A git stderr well past the apply-reason cap. */
const LONG_APPLY_REASON = `error: patch failed: src/a.ts:12\n${"hunk-".repeat(2000)}`;
/** A worktree path well past the tree-path cap. */
const LONG_TREE = `${"/".repeat(1)}${"very-long-directory-name-".repeat(20)}repo/.worktrees/issue-981-default`;

/**
 * The #1258 shape, obtained from the REAL producer: `verifiedRestoreRoot`
 * against a repo whose save step fails, at a long repoRoot with a 160-char
 * git error. `saveFailedRestore` is module-private on purpose (an unexported
 * producer keeps the seams-wired gate honest — see test-seams-wired.ts), so
 * the test reaches it through `verifiedRestoreRoot` by injecting a failure
 * into the save's `git diff`, which is the real condition that produces it.
 */
async function saveFailedFromRealProducer(): Promise<VerifiedRestoreResult> {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-save-failed-"));
  try {
    const deep = path.join(dir, "a-really-long-checkout-directory-name-".repeat(4), "repo");
    mkdirSync(deep, { recursive: true });
    await execFileP("git", ["init", "-q", "--initial-branch=main", deep]);
    await execFileP("git", ["-C", deep, "config", "user.email", "t@e.com"]);
    await execFileP("git", ["-C", deep, "config", "user.name", "T"]);
    writeFileSync(path.join(deep, "tracked.txt"), "base\n");
    await execFileP("git", ["-C", deep, "add", "."]);
    await execFileP("git", ["-C", deep, "commit", "-q", "-m", "base"]);
    const failing: ExecFn = async (cmd, o) => {
      if (o?.argv?.length === 1 && o.argv[0] === "diff") {
        throw Object.assign(new Error("Command failed: git diff"), {
          stderr: `fatal: unable to read index object ${"0123456789abcdef".repeat(20)}`,
        });
      }
      if (o?.argv) {
        const { stdout } = await execFileP(cmd, o.argv, { cwd: o.cwd, maxBuffer: 8 * 1024 * 1024 });
        return { stdout };
      }
      const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
        cwd: o.cwd,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { stdout };
    };
    return await verifiedRestoreRoot(failing, {
      repoRoot: deep,
      originalRef: "main",
      scratchDir: path.join(dir, "scratch"),
      label: "cause-budget",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
      untracked: Array.from({ length: 24 }, (_, i) => `operator-notes-${i}.md`),
    },
    expect: "repoRoot checkout was restored, but 24 untracked file(s) remain",
  },
  {
    name: "NOT restored",
    restore: {
      restored: false,
      detail: `repoRoot was NOT restored — still dirty after reset + checkout: ${Array.from(
        { length: 10 },
        (_, i) => `src/mod-${i}/deeply/nested/f-${i}.ts`,
      ).join(", ")}`,
      preservedAt: "/tmp/pi-rukas/scratch/lens-fix-integration-1700000000000.diff",
    },
    expect: "repoRoot was NOT restored",
  },
  {
    name: "#1258 save-failed",
    // Filled from the real producer below (see saveFailedFromRealProducer);
    // the placeholder is replaced before any assertion reads it.
    restore: { restored: false, detail: "" },
    expect: "the discarded state could not be saved",
  },
];

// The #1258 shape comes from the REAL producer, asynchronously — an
// unexported producer reached the way production reaches it.
SHAPES[3].restore = await saveFailedFromRealProducer();
assert(
  SHAPES[3].restore.detail !== undefined &&
    SHAPES[3].restore.detail.includes("the discarded state could not be saved"),
  "the #1258 shape really came from verifiedRestoreRoot's failed-save branch",
);

assert(CAUSE_BUDGET > 300, `the catch's slice budget is raised past 300 (got ${CAUSE_BUDGET})`);
assert(
  MANUAL_REPAIR_HINT.length > 0 && MANUAL_REPAIR_HINT.includes("git reset --hard"),
  "the repair hint is exported from the module under test (no source scraping)",
);
// The canary: the fit assertion must be able to fail. At the pre-#981
// 300-char budget the not-restored claim alone filled the slice, so the
// longest shape is measured here and asserted NOT to fit inside 300.
assert(
  restoreClaim(SHAPES[2].restore, { trailing: MANUAL_REPAIR_HINT }).length > 300,
  "canary: the not-restored claim alone exceeds the old 300-char slice — the fit check can fail",
);
// The budget's restore reservation must cover every claim the real producers
// emit, otherwise the derived sum below silently under-reserves.
const widestClaim = Math.max(
  ...SHAPES.map((s) => restoreClaim(s.restore, { trailing: MANUAL_REPAIR_HINT }).length),
);
assert(
  widestClaim <= RESTORE_CLAIM_BUDGET,
  `the widest real restore claim (${widestClaim} chars) fits inside the derived ${RESTORE_CLAIM_BUDGET}-char reservation`,
);
assert(
  restoreClaimCeiling(MANUAL_REPAIR_HINT.length) === RESTORE_CLAIM_BUDGET,
  "the budget's reservation is the derived ceiling, not a literal",
);

for (const kind of ["conflict", "apply"] as const) {
  for (const s of SHAPES) {
    const cause = lensFixConflictCause({
      kind,
      restore: s.restore,
      evidence: { paths: MANY_PATHS, pathsRead: "paths" },
      tree: LONG_TREE,
      applyReason: LONG_APPLY_REASON,
      fixParent: "01234567",
      branchTip: "89abcdef",
    });
    assert(
      cause.length <= CAUSE_BUDGET,
      `${kind}/${s.name}: the whole cause (${cause.length} chars, ${MANY_PATHS.length} conflicting paths) fits inside the ${CAUSE_BUDGET}-char budget`,
    );
    const sliced = cause.slice(0, CAUSE_BUDGET);
    assert(
      sliced.includes(s.expect) &&
        sliced.includes("`src/module-0/nested/file-0.ts`") &&
        sliced.includes("(+14 more)"),
      `${kind}/${s.name}: after the slice the restore claim AND the first conflicting path survive, with the (+K more) count`,
    );
    assert(
      sliced.includes("Fix commit's parent: 01234567") && sliced.includes("Branch tip: 89abcdef"),
      `${kind}/${s.name}: the two short SHAs ride the returned message, not just the trace`,
    );
    // The clause must precede the long tail in BOTH arms — the patch-apply
    // arm used to end with it, which is exactly where a budget cut lands.
    assert(
      sliced.indexOf("Conflicting paths:") < sliced.indexOf("The fix's commits remain"),
      `${kind}/${s.name}: the conflicting-paths clause comes before the long tail`,
    );
  }
}

// The per-entry bound: a pathological path is cut, not pasted whole.
{
  const clause = conflictPathsClause({ paths: [LONG_PATH], pathsRead: "paths" });
  assert(
    clause.length < 200 && clause.includes("…"),
    `a 300-char path is cut by the per-entry cap (clause ${clause.length} chars, ellipsis present)`,
  );
}
// The untrusted-stderr bound: a wall of git apply output cannot push anything out.
{
  const cause = lensFixConflictCause({
    kind: "apply",
    restore: { restored: true },
    evidence: { paths: ["a.ts"], pathsRead: "paths" },
    tree: "/tmp/wt",
    applyReason: LONG_APPLY_REASON,
  });
  // The bound is 160 chars, so the reason alone cannot exceed it — and no
  // amount of git stderr pushes the clauses after it past the budget.
  const reasonPart = cause.slice("patch-apply failed for the lens-fix worktree: ".length);
  assert(
    cause.includes("…") &&
      reasonPart.startsWith("error: patch failed: src/a.ts:12\nhunk") &&
      reasonPart.indexOf(". repoRoot was") < 200 &&
      cause.includes("repoRoot was verified restored") &&
      cause.includes("Conflicting paths: `a.ts`.") &&
      cause.includes("Branch tip:"),
    "a wall of git apply stderr is bounded, and the clauses after it survive",
  );
}
// The typed discriminator drives the clause — no note-prefix matching.
{
  const unreadable = conflictPathsClause({ paths: [], pathsRead: "unreadable" });
  const empty = conflictPathsClause({ paths: [], pathsRead: "empty" });
  assert(
    unreadable.includes("git ls-files -u failed") &&
      empty.includes("no unmerged paths") &&
      unreadable !== empty,
    "the clause branches on pathsRead: unreadable and empty render distinctly",
  );
}

// ── Real git: the restore shapes come from the real producer, and the
//    returned error carries the claim AND both filenames.
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

/**
 * Build a commit that replaces `files` on top of `parent`, WITHOUT touching
 * the worktree's own index or moving its detached HEAD: blob-hash each file,
 * read the parent into a throw-away index, update the entries, `write-tree`,
 * `commit-tree`.
 */
async function commitEditingFiles(
  cwd: string,
  parent: string,
  files: Record<string, string>,
): Promise<string> {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, `idx-${Date.now()}`) };
  const g = async (args: string[]) => (await execFileP("git", args, { cwd, env })).stdout.trim();
  await g(["read-tree", parent]);
  for (const [name, body] of Object.entries(files)) {
    const tmp = path.join(root, `blob-${name.replace(/\W/g, "_")}-${Date.now()}`);
    writeFileSync(tmp, body);
    const sha = await g(["hash-object", "-w", tmp]);
    await g(["update-index", "--add", "--cacheinfo", `100644,${sha},${name}`]);
  }
  return g(["commit-tree", await g(["write-tree"]), "-p", parent, "-m", "lens fix"]);
}

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
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "branch-side change"]);

  // The restore shape taken from the REAL producer against a dirty root:
  // dirt, untracked names and the preserved-diff path all come from git.
  writeFileSync(path.join(repo, "operator-keep.txt"), "untracked\n");
  const realRestore = await verifiedRestoreRoot(realExec, {
    repoRoot: repo,
    originalRef: branch,
    scratchDir: path.join(root, "scratch"),
    label: "cause-budget",
  });
  const realCause = lensFixConflictCause({
    kind: "conflict",
    restore: realRestore,
    evidence: { paths: ["conflict.txt", "also-conflict.txt"], pathsRead: "paths" },
    tree: wt,
    fixParent: "01234567",
    branchTip: "89abcdef",
  });
  assert(
    realCause.length <= CAUSE_BUDGET,
    `real producer's restore: the cause fits inside the budget (${realCause.length}/${CAUSE_BUDGET})`,
  );
  assert(
    realCause.includes("Conflicting paths: `conflict.txt`, `also-conflict.txt`.") &&
      (realCause.includes("repoRoot was verified restored") ||
        realCause.includes("repoRoot was NOT restored") ||
        realCause.includes("repoRoot checkout was restored")),
    "real producer's restore: the claim and both conflicting paths are both present",
  );
  // The untracked file must not leak into the restore we just measured.
  rmSync(path.join(repo, "operator-keep.txt"), { force: true });

  // A deterministic two-file conflict, measured mid-cherry-pick. The driver
  // picks with `--no-commit`, which auto-stages every clean file and leaves
  // unmerged entries ONLY for the clashing ones — and whether a whole-file
  // rewrite conflicts at all depends on git's similarity heuristics, so the
  // fixture edits the SAME line of a multi-line file on both sides. The fix
  // commit is built as a commit object so the worktree's own detached HEAD
  // stays where the driver left it.
  const base1 = await git(repo, ["rev-parse", "HEAD~1"]);
  await git(repo, ["checkout", "-q", "-B", "conflict-probe", base1]);
  writeFileSync(path.join(repo, "conflict.txt"), "one\nBRANCH SIDE\nthree\n");
  writeFileSync(path.join(repo, "also-conflict.txt"), "BRANCH SIDE\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "branch-side single-line edits"]);
  const fixSha = await commitEditingFiles(wt, base1, {
    "conflict.txt": "one\nFIXED BY THE REVIEW\nthree\n",
    "also-conflict.txt": "ALSO FIXED\n",
  });
  const conflict = await git(repo, ["cherry-pick", "--no-commit", fixSha]).catch(() => "conflict");
  const unmerged = await git(repo, ["ls-files", "-u"]);
  const evidencePaths = [
    ...new Set(
      unmerged
        .split("\n")
        .map((l) => l.trim().split("\t").pop() ?? l.trim())
        .filter(Boolean),
    ),
  ];
  assert(
    conflict === "conflict" && evidencePaths.length === 2,
    `the fixture really conflicts and git reports both unmerged paths (got ${evidencePaths.join(", ") || "none"})`,
  );
  const midConflict = await collectConflictEvidence(realExec, repo, wt, true);
  await git(repo, ["cherry-pick", "--abort"]).catch(() => undefined);
  assert(
    midConflict.pathsRead === "paths" &&
      midConflict.paths.length === evidencePaths.length &&
      evidencePaths.every((p) => midConflict.paths.includes(p)),
    `collectConflictEvidence reads EVERY unmerged path from the real index (${midConflict.paths.join(", ")})`,
  );
  const midCause = lensFixConflictCause({
    kind: "conflict",
    restore: { restored: true },
    evidence: midConflict,
    tree: wt,
    fixParent: midConflict.fixParent,
    branchTip: midConflict.branchTip,
  });
  assert(
    evidencePaths.every((p) => midCause.includes(`\`${p}\``)) && midCause.length <= CAUSE_BUDGET,
    `the cause names every real conflicting path and fits the budget (${midCause.length}/${CAUSE_BUDGET})`,
  );
  // Back to the shape landCommittedFix runs against: the branch commit and
  // the fixer's commit both edit the same lines of the same two files.
  await git(repo, ["reset", "--hard", "HEAD~1"]);
  await git(repo, ["checkout", "-q", "-B", branch]);
  await git(wt, ["checkout", "-q", "--detach", setup.baseSha as string]);
  writeFileSync(path.join(repo, "conflict.txt"), "one\nBRANCH SIDE\nthree\n");
  writeFileSync(path.join(repo, "also-conflict.txt"), "BRANCH SIDE\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "branch-side change"]);
  writeFileSync(path.join(wt, "conflict.txt"), "one\nFIXED BY THE REVIEW\nthree\n");
  writeFileSync(path.join(wt, "also-conflict.txt"), "ALSO FIXED\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "lens fix"]);

  const ps = {
    branchName: branch,
    baseSha: setup.baseSha,
    reviewRound: 1,
  } as PipelineState;
  const r = await landCommittedFix(realExec, { repoRoot: repo, issue: 981 }, ps, wt);
  assert(r.ok === false, `the conflicting pick fails (${r.ok ? "ok" : "failed"})`);
  const err = r.ok ? "" : r.error;
  // The full message for the diagnosis — printed, not buried in a bool.
  console.log(`  · real conflict error: ${err}`);
  assert(
    err.includes("repoRoot was verified restored") || err.includes("repoRoot was NOT restored"),
    "real conflict: the error carries the verified restore claim",
  );
  assert(
    err.includes("Conflicting paths:") && err.includes("The fix's commits remain in the worktree"),
    "real conflict: the error keeps the path clause and the worktree pointer",
  );
  assert(
    err.includes("Fix commit's parent:") && err.includes("Branch tip:"),
    "real conflict: the error carries the fix parent and branch tip SHAs",
  );
  assert(
    err.length <= CAUSE_BUDGET,
    `real conflict: the error fits inside the budget (${err.length})`,
  );
  // The paths themselves come from the real index read — the same evidence
  // `landCommittedFix` collects at the moment of the conflict — asserted
  // directly so the clause content is checked against real `ls-files -u`
  // output rather than a fixture list.
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
