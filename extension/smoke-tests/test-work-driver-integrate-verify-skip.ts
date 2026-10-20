#!/usr/bin/env bun
/**
 * #1240 — the commit-pr seam of the duplicate-run elimination.
 *
 * `integrate()` step 4 runs the project's verify command against the
 * consolidated tree before pushing the branch. For one shape that tree is
 * content the develop step already verified green: one workstream, create
 * mode, work that arrived as a cherry-picked commit. Running the command
 * there is the same duplicate the develop step eliminates
 * (`test-work-driver-consolidated-verify-skip.ts` covers that half), on the
 * seam that decides what gets pushed.
 *
 * Four cases, and the two that matter are the RED-when-broken ones:
 *
 *   k0. the full caller path at N=1 → skipped, no command run at all;
 *   k4. N>1 → runs even when the caller names a `verifiedWorktree` (pins the
 *       `ids.length === 1` half of the eligibility rule, which a caller's
 *       grant cannot override);
 *   k1. an unreadable identity → runs;
 *   k3. residue left in repoRoot's index after the commit → runs, because
 *       the index no longer describes the commit and the tree under test is
 *       therefore not the tree that passed.
 *
 * k2 additionally checks the seam's own API contract directly
 * (`runCommitPrConsolidatedVerify` with a supplied identity), which is the
 * only way to observe the skip on a tree `integrate()` already committed
 * without re-running the whole integration.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runCommitPrConsolidatedVerify } from "../src/work-driver-integrate-verify.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1240-pr-"));

type Runs = Array<{ cwd: string }>;

async function fixture(name: string, ids: string[]) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  mkdirSync(dir, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    await git(wt, ["config", "user.email", "t@example.com"]);
    await git(wt, ["config", "user.name", "T"]);
    worktrees[id] = wt;
  }
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  return { dir, repo, baseSha, worktrees };
}

function installVerifyCmd(repo: string, markerFile: string) {
  const cmd = `sh -c 'echo run >> ${markerFile}'`;
  writeFileSync(path.join(repo, ".pi", "verify-cmd"), `${cmd}\n`);
  return cmd;
}

/** Real git; verify-command runs are counted and stubbed to a pass. */
function makeExec(counts: { runs: Runs; repoRoot: string }): ExecFn {
  return async (cmd, o) => {
    if (cmd.startsWith("sh -c 'echo run >>")) {
      counts.runs.push({ cwd: o?.cwd ?? "?" });
      return { stdout: "" };
    }
    try {
      const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
      const { stdout } = o?.argv
        ? await execFileP(cmd, o.argv, opts)
        : await execFileP("/bin/sh", ["-c", cmd], opts);
      return { stdout };
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      e.stdout = e.stdout ?? "";
      e.stderr = e.stderr ?? (err as unknown as { stderr?: string }).stderr ?? "";
      throw e;
    }
  };
}

const ranAtRoot = (runs: Runs, repo: string) =>
  runs.some((r) => path.resolve(r.cwd) === path.resolve(repo));

/** Commit `file` with `body` in a worktree, as a developer would leave it. */
async function commitIn(wt: string, file: string, body: string) {
  writeFileSync(path.join(wt, file), body);
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", `task: add ${file}`]);
}

try {
  // ------------------------------------------------------------------ case k
  // The commit-pr seam (`integrate()` step 4). Same rule, same shape:
  // N=1, create mode, one cherry-picked commit → the committed integration
  // tree IS the tree the develop gate judged, so the run is skipped. And two
  // anti-vacuity halves: a non-matching identity runs it, and residue left
  // in the index at repoRoot (so the index no longer describes the commit)
  // runs it.
  {
    const f = await fixture("commit-pr-skip", ["default"]);
    const verifyCmd = installVerifyCmd(f.repo, "never-written.txt");
    writeFileSync(path.join(f.worktrees.default as string, "a.txt"), "a\n");
    await git(f.worktrees.default as string, ["add", "."]);
    await git(f.worktrees.default as string, ["commit", "-q", "-m", "task: add a"]);
    const wt = f.worktrees.default as string;

    const baseOpts = {
      repoRoot: f.repo,
      branchName: "feature/commit-pr-skip",
      baseSha: f.baseSha,
      worktrees: { default: wt },
      scratchDir: path.join(f.dir, "scratch"),
      commitTitle: "feat: commit-pr skip",
      commitBody: "b",
      mode: "create" as const,
      requireAllNonEmpty: true,
      verifyCmd,
    };

    // (k0) The full caller path, identity included: one workstream, committed
    // work, create mode → `integrate()` establishes the worktree's identity
    // and the seam skips its run. This is the break-proof target at this seam:
    // forcing the comparison to "equal" keeps it green, and forcing "unequal"
    // (or removing the read) makes it RED — see the test's own notes.
    const h = await fixture("commit-pr-skip-0", ["default"]);
    const cmd0 = installVerifyCmd(h.repo, "never-written.txt");
    const wt0 = h.worktrees.default as string;
    writeFileSync(path.join(wt0, "a.txt"), "a\n");
    await git(wt0, ["add", "."]);
    await git(wt0, ["commit", "-q", "-m", "task: add a"]);
    const runs0: Runs = [];
    const r0 = await integrate(makeExec({ runs: runs0, repoRoot: h.repo }), {
      repoRoot: h.repo,
      branchName: "feature/commit-pr-skip-0",
      baseSha: h.baseSha,
      worktrees: { default: wt0 },
      scratchDir: path.join(h.dir, "scratch"),
      commitTitle: "feat: commit-pr skip 0",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd: cmd0,
      // The caller's N=1 grant: this is the worktree the develop gate verified.
      verifiedWorktree: wt0,
    });
    assert(
      r0.ok && runs0.length === 0,
      `case k0: the commit-pr verify is skipped end-to-end when the single workstream's tree is what landed (ok: ${r0.ok}, runs: ${JSON.stringify(runs0)})`,
    );

    // (k1) The identity cannot be established (the worktree was wiped, so no
    // tree read succeeds) → the run happens and the branch is pushed. This is
    // the assertion that goes RED when the comparison is forced to "equal".
    const runs1: Runs = [];
    const r1 = await integrate(makeExec({ runs: runs1, repoRoot: f.repo }), {
      ...baseOpts,
      // A worktree that no longer exists yields no identity, which never
      // equals anything — so the seam must run the command.
      verifiedWorktree: path.join(f.dir, "worktree-that-is-gone"),
    });
    const mismatchRuns = runs1.filter((r) => path.resolve(r.cwd) === path.resolve(f.repo));
    assert(
      r1.ok && mismatchRuns.length === 1,
      `case k1: an unestablished identity runs the commit-pr verify (ok: ${r1.ok}, runs: ${JSON.stringify(runs1)})`,
    );

    // (k2) The identity matches → skipped. Fresh fixture so the branch is
    // created clean (k1 already advanced this one).
    const g = await fixture("commit-pr-skip-2", ["default"]);
    const cmd2 = installVerifyCmd(g.repo, "never-written.txt");
    const wt2 = g.worktrees.default as string;
    writeFileSync(path.join(wt2, "a.txt"), "a\n");
    await git(wt2, ["add", "."]);
    await git(wt2, ["commit", "-q", "-m", "task: add a"]);
    const runs2: Runs = [];
    const r2 = await integrate(makeExec({ runs: runs2, repoRoot: g.repo }), {
      repoRoot: g.repo,
      branchName: "feature/commit-pr-skip-2",
      baseSha: g.baseSha,
      worktrees: { default: wt2 },
      scratchDir: path.join(g.dir, "scratch"),
      commitTitle: "feat: commit-pr skip 2",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd: cmd2,
      // No `verifiedWorktree`: integrate() computes the identity itself, and
      // this fixture's develop gate never ran a green verify, so the seam
      // runs. (The real caller supplies the worktree only for the N=1
      // create-mode shape.)
    });
    assert(
      r2.ok && ranAtRoot(runs2, g.repo),
      `case k2 (setup): integrate() succeeded and ran the verify seam (ok: ${r2.ok}, runs: ${JSON.stringify(runs2)})`,
    );
    // Now drive the seam directly with the identity the caller would pass,
    // on the tree integrate() just committed — the only way to observe the
    // skip without re-running the whole integration.
    const committed = (await git(g.repo, ["rev-parse", "HEAD"])).stdout.trim();
    const treeOfCommitted = (await git(g.repo, ["rev-parse", `${committed}^{tree}`])).stdout.trim();
    const runs3: Runs = [];
    const vr = await runCommitPrConsolidatedVerify(makeExec({ runs: runs3, repoRoot: g.repo }), {
      verifyCmd: cmd2,
      repoRoot: g.repo,
      workstreamCount: 1,
      workstreamIds: ["default"],
      timeoutMs: 60_000,
      alreadyVerifiedTree: { treeHash: treeOfCommitted, worktree: wt2 },
    });
    assert(
      vr.ok === true && vr.skipped !== undefined && runs3.length === 0,
      `case k2: the commit-pr verify is skipped when HEAD's tree is the tree that passed (ok: ${vr.ok}, skipped: ${JSON.stringify((vr as { skipped?: unknown }).skipped)}, runs: ${JSON.stringify(runs3)})`,
    );

    // (k3) Residue in the index: the commit is right but `write-tree` would
    // disagree, so the identity is unestablished and the run happens.
    writeFileSync(path.join(g.repo, "index-residue.txt"), "staged after the commit\n");
    await git(g.repo, ["add", "index-residue.txt"]);
    const runs4: Runs = [];
    const vr2 = await runCommitPrConsolidatedVerify(makeExec({ runs: runs4, repoRoot: g.repo }), {
      verifyCmd: cmd2,
      repoRoot: g.repo,
      workstreamCount: 1,
      workstreamIds: ["default"],
      timeoutMs: 60_000,
      alreadyVerifiedTree: { treeHash: treeOfCommitted, worktree: wt2 },
    });
    assert(
      vr2.ok === true && vr2.skipped === undefined && runs4.length === 1,
      `case k3: index residue at repoRoot is never read as 'the tree that passed' (skipped: ${JSON.stringify((vr2 as { skipped?: unknown }).skipped)}, runs: ${JSON.stringify(runs4)})`,
    );
    await git(g.repo, ["reset", "-q", "--mixed", "HEAD"]);
    rmSync(path.join(g.repo, "index-residue.txt"), { force: true });
    // (k4) N>1 at this seam: two workstreams combine into a tree no worktree
    // held, so even a caller that names a `verifiedWorktree` must NOT get a
    // skip. Pins the `ids.length === 1` half of the eligibility rule — the
    // caller's grant is a worktree, not a proof, and the proof is here.
    const m = await fixture("commit-pr-two-workstreams", ["a", "b"]);
    const cmd4 = installVerifyCmd(m.repo, "never-written.txt");
    for (const [id, body] of [
      ["a", "a\n"],
      ["b", "b\n"],
    ] as const) {
      const p = path.join(m.worktrees[id] as string, `${id}.txt`);
      writeFileSync(p, body);
      await git(m.worktrees[id] as string, ["add", "."]);
      await git(m.worktrees[id] as string, ["commit", "-q", "-m", `task-${id}`]);
    }
    const runs5: Runs = [];
    const r5 = await integrate(makeExec({ runs: runs5, repoRoot: m.repo }), {
      repoRoot: m.repo,
      branchName: "feature/commit-pr-two",
      baseSha: m.baseSha,
      worktrees: m.worktrees,
      scratchDir: path.join(m.dir, "scratch"),
      commitTitle: "feat: two workstreams",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd: cmd4,
      // The caller would never do this at N>1; the seam must refuse anyway.
      verifiedWorktree: m.worktrees.a as string,
    });
    assert(
      r5.ok && ranAtRoot(runs5, m.repo),
      `case k4: at N>1 the commit-pr verify runs even when a worktree is named (ok: ${r5.ok}, runs: ${JSON.stringify(runs5)})`,
    );
  }

  // #1702 — `logPaths` on the terminal commit-pr cap was a field NO production path ever
  // filled. The develop gate writes its consolidated run log and reports the path through
  // `onConsolidatedLogPath` (#841); the commit-pr seam documented the same contract while
  // writing nothing, so every `integration-verify-failed` park carried an absent pointer.
  // This drives the real `integrate()` with a red verify command and a scratch dir, and
  // asserts the park now names a log that exists on disk.
  {
    const g = await fixture("commit-pr-run-log", ["default"]);
    const cmd = `sh -c 'echo "FAILED: 1 test(s) — driver::red"; exit 1'`;
    const wt = path.join(g.dir, "wt-log");
    await git(g.repo, ["worktree", "add", "-q", "--detach", wt, g.baseSha]);
    await git(wt, ["config", "user.email", "t@example.com"]);
    await git(wt, ["config", "user.name", "T"]);
    writeFileSync(path.join(wt, "feature.rs"), "fn a() {}\n");
    await git(wt, ["add", "."]);
    await git(wt, ["commit", "-q", "-m", "task: feature"]);
    const scratch = path.join(g.dir, "scratch-log");
    const runsLog: Runs = [];
    const res = await integrate(makeExec({ runs: runsLog, repoRoot: g.repo }), {
      repoRoot: g.repo,
      branchName: "feature/commit-pr-log",
      baseSha: g.baseSha,
      worktrees: { default: wt },
      scratchDir: scratch,
      commitTitle: "feat: logged",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd: cmd,
    });
    assert(res.ok === false, "#1702: a red consolidated verify fails the integration");
    const logs = (res as { logPaths?: string[] }).logPaths ?? [];
    assert(
      logs.length === 1 && logs[0] !== undefined && existsSync(logs[0]),
      `#1702: the failure carries a logPath that EXISTS on disk (got ${JSON.stringify(logs)})`,
    );
    assert(
      logs[0] !== undefined && logs[0].startsWith(scratch),
      `#1702: the log lands in the cycle's scratch dir, not somewhere ad hoc (${logs[0]})`,
    );
    assert(
      logs[0] !== undefined && readFileSync(logs[0], "utf8").includes("driver::red"),
      "#1702: the persisted log holds the raw stream, so the operator can read what failed",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
