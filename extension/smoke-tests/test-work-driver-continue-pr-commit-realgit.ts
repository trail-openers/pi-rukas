#!/usr/bin/env bun
/**
 * #1468 — commit-pr in `--continue-pr` mode against REAL git: a bare origin,
 * the driver's clone and a second clone that plays the PR author. Each case
 * runs the continue branch step, a simulated developer, then commit-pr.
 *
 * The refresh is a fast-forward of the PR head to the merge commit [P, M],
 * pushed plainly after a verify run, with no second PR. Markers left behind,
 * a foreign push during verify, a failing fast-forward and a main that is red
 * at M each stop without a push over the PR and without the ops fallback.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runBranch } from "../src/work-driver-branch-develop.ts";
import { mechanizedCommitPr, runCommitPr } from "../src/work-driver-commit.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { execp } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

gitTestEnv();
process.env.PI_ENSEMBLE_FORGE = "github";
const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", args, { cwd })).stdout.trim();

async function identity(dir: string) {
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
}

const HEAD = "feature/issue-5-thing";
const PR = 77;
const LOOP = path.join(import.meta.dirname, "lib", "verify-loop.sh");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "verify-loop");
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1468-commit-"));
let n = 0;

/** The gate files main carries from its first commit: green, or red at every commit. */
function writeGate(dir: string, red: boolean) {
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  if (!red) {
    writeFileSync(path.join(dir, "verify.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(path.join(dir, ".pi", "verify-cmd"), "sh verify.sh\n");
    return;
  }
  mkdirSync(path.join(dir, "tests"), { recursive: true });
  copyFileSync(path.join(FIXTURES, "fixture-1.ts"), path.join(dir, "tests", "test-red.ts"));
  const script = [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    `exec bash ${LOOP} "$DIR/tests/test-red.ts"`,
  ].join("\n");
  writeFileSync(path.join(dir, "verify.sh"), script);
  chmodSync(path.join(dir, "verify.sh"), 0o755);
  writeFileSync(path.join(dir, ".pi", "verify-cmd"), "sh verify.sh\n");
}

/** origin with main at M and HEAD at P (P branches off main's parent). */
async function fixture(opts: { conflict?: boolean; red?: boolean } = {}) {
  const dir = path.join(root, `case-${++n}`);
  const origin = path.join(dir, "origin.git");
  const author = path.join(dir, "author");
  const repo = path.join(dir, "repo");
  await execFileP("git", ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["clone", "-q", origin, author]);
  await identity(author);
  await git(author, ["checkout", "-q", "-b", "main"]);
  writeFileSync(path.join(author, "a.txt"), "base\n");
  writeGate(author, opts.red === true);
  await git(author, ["add", "."]);
  await git(author, ["commit", "-q", "-m", "base"]);
  await git(author, ["push", "-q", "origin", "main"]);
  await execFileP("git", ["clone", "-q", origin, repo]);
  await identity(repo);
  await git(author, ["checkout", "-q", "-b", HEAD]);
  writeFileSync(path.join(author, opts.conflict ? "a.txt" : "b.txt"), "pr side\n");
  await git(author, ["add", "."]);
  await git(author, ["commit", "-q", "-m", "pr work"]);
  await git(author, ["push", "-q", "origin", HEAD]);
  const P = await git(author, ["rev-parse", "HEAD"]);
  await git(author, ["checkout", "-q", "main"]);
  writeFileSync(path.join(author, opts.conflict ? "a.txt" : "c.txt"), "main side\n");
  await git(author, ["add", "."]);
  await git(author, ["commit", "-q", "-m", "main moves"]);
  await git(author, ["push", "-q", "origin", "main"]);
  const M = await git(author, ["rev-parse", "HEAD"]);
  return { repo, author, origin, P, M };
}

type Harness = {
  ctx: CycleContext;
  gh: string[];
  pushes: string[];
  dispatched: string[];
  verifyRuns: () => number;
};

/** The cycle's context; `onVerify` runs before the first verify command. */
function harness(repo: string, P: string, onVerify?: () => Promise<void>): Harness {
  const gh: string[] = [];
  const pushes: string[] = [];
  const dispatched: string[] = [];
  let verifyRuns = 0;
  const row = {
    number: PR,
    headRefName: HEAD,
    headRefOid: P,
    baseRefName: "main",
    isCrossRepository: false,
    headRepository: { name: "repo" },
    body: "Fixes #5",
  };
  const verifyExecFn: VerifyExecFn = async (raw, o) => {
    const cmd = commandOf(raw, o);
    if (cmd.startsWith("gh ")) {
      gh.push(cmd);
      if (cmd.startsWith("gh pr list")) return { stdout: JSON.stringify([row]) };
      return { stdout: "{}" };
    }
    if (/^git (.* )?push( |$)/.test(cmd)) pushes.push(cmd);
    if (cmd.includes("verify.sh")) {
      verifyRuns++;
      if (verifyRuns === 1) await onVerify?.();
    }
    return execp(raw, o);
  };
  const ctx = {
    host: {},
    repoRoot: repo,
    issue: 5,
    continuePr: true,
    verifyExecFn,
    emitSink: () => {},
    dispatchFn: async () => {
      dispatched.push("dispatch");
      throw new Error("continue mode must not dispatch");
    },
  } as unknown as CycleContext;
  return { ctx, gh, pushes, dispatched, verifyRuns: () => verifyRuns };
}

function capOf(state: WorkState): string | undefined {
  const hit = state.eventLog.findLast((e) => e.kind === "cap-hit");
  return hit?.kind === "cap-hit" ? hit.cap : undefined;
}

const remoteHead = async (origin: string) => git(origin, ["rev-parse", `refs/heads/${HEAD}`]);
const forced = (pushes: string[]) =>
  pushes.filter((p) => /--force|(^| )-f( |$)| \+|lease/.test(p));

async function branchStep(h: Harness): Promise<WorkState> {
  const out = await runBranch(h.ctx, initialState(5), 1000);
  if (capOf(out) !== undefined) throw new Error(`fixture: branch step capped ${capOf(out)}`);
  return out;
}

try {
  {
    const { repo, origin, P, M } = await fixture();
    const h = harness(repo, P);
    const st = await branchStep(h);
    const res = await mechanizedCommitPr(h.ctx, st, 2000);
    assert(res.ok === true, `clean: commit-pr succeeds (${res.ok ? "ok" : res.reason})`);
    const R = await remoteHead(origin);
    const parents = (await git(origin, ["rev-list", "--parents", "-n", "1", R])).split(" ");
    assert(parents[1] === P && parents[2] === M, "clean: the remote head's parents are [P, M]");
    assert(
      await execFileP("git", ["merge-base", "--is-ancestor", P, R], { cwd: origin }).then(
        () => true,
        () => false,
      ),
      "clean: P is an ancestor of the new head (a fast-forward)",
    );
    assert(
      (await git(repo, ["rev-parse", `refs/remotes/origin/${HEAD}`])) === R,
      "clean: the origin/<head> tracking ref is updated",
    );
    assert(!h.gh.some((g) => g.startsWith("gh pr create")), "clean: prCreate is not called");
    assert(h.pushes.length > 0 && forced(h.pushes).length === 0, "clean: every push is plain");
    assert(h.verifyRuns() > 0, "clean: verify ran on the first push");
    assert(
      res.ok && !res.state.eventLog.some((e) => e.kind === "consolidated-verify-skipped"),
      "clean: no verifySkipped event",
    );
    assert(h.dispatched.length === 0, "clean: zero dispatches");
  }

  {
    const { repo, origin, P, M } = await fixture({ conflict: true });
    const h = harness(repo, P);
    const st = await branchStep(h);
    const wt = st.pipelineState.worktrees?.default ?? "";
    writeFileSync(path.join(wt, "a.txt"), "resolved\n");
    await git(wt, ["add", "a.txt"]);
    await git(wt, ["commit", "-q", "--no-edit"]);
    const res = await mechanizedCommitPr(h.ctx, st, 2000);
    const R = await remoteHead(origin);
    const parents = (await git(origin, ["rev-list", "--parents", "-n", "1", R])).split(" ");
    assert(
      res.ok === true && parents[1] === P && parents[2] === M,
      "conflict resolved: the finished merge is pushed",
    );
  }

  {
    const { repo, origin, P } = await fixture({ conflict: true });
    const h = harness(repo, P);
    const st = await branchStep(h);
    const wt = st.pipelineState.worktrees?.default ?? "";
    await git(wt, ["add", "a.txt"]);
    await git(wt, ["commit", "-q", "--no-edit"]);
    const out = await runCommitPr(h.ctx, st, 2000);
    assert(capOf(out) === "continue-pr-unresolved", "markers left: continue-pr-unresolved");
    assert(h.pushes.length === 0 && (await remoteHead(origin)) === P, "markers: nothing pushed");
    assert(h.dispatched.length === 0, "markers: zero dispatches");
  }

  {
    const { repo, origin, author, P } = await fixture();
    let foreign = "";
    const h = harness(repo, P, async () => {
      await git(author, ["fetch", "-q", "origin", HEAD]);
      await git(author, ["checkout", "-q", "-B", HEAD, `origin/${HEAD}`]);
      writeFileSync(path.join(author, "f.txt"), "foreign\n");
      await git(author, ["add", "."]);
      await git(author, ["commit", "-q", "-m", "foreign push"]);
      await git(author, ["push", "-q", "origin", HEAD]);
      foreign = await git(author, ["rev-parse", "HEAD"]);
    });
    const st = await branchStep(h);
    const out = await runCommitPr(h.ctx, st, 2000);
    assert(h.pushes.length > 0, "foreign push: our push was attempted");
    assert(capOf(out) === "continue-pr-head-moved", "foreign push: continue-pr-head-moved");
    assert(
      foreign !== "" && (await remoteHead(origin)) === foreign,
      "foreign push: the remote still equals the foreign SHA",
    );
    assert(forced(h.pushes).length === 0, "foreign push: no forced push");
    assert(h.dispatched.length === 0, "foreign push: zero fallback dispatches");
  }

  {
    const { repo, origin, P } = await fixture();
    const h = harness(repo, P);
    const st = await branchStep(h);
    const tree = await git(repo, ["rev-parse", `${P}^{tree}`]);
    const X = await git(repo, ["commit-tree", tree, "-p", P, "-m", "local only"]);
    await git(repo, ["update-ref", `refs/heads/${HEAD}`, X]);
    const out = await runCommitPr(h.ctx, st, 2000);
    assert(capOf(out) === "step-failed:commit-pr", "failing fast-forward: step-failed:commit-pr");
    assert(h.dispatched.length === 0, "failing fast-forward: zero dispatchCommitPrFallback calls");
    assert(
      !out.eventLog.some((e) => e.kind === "dispatch-started"),
      "failing fast-forward: no dispatch event",
    );
    assert((await remoteHead(origin)) === P, "failing fast-forward: remote unchanged");
  }

  {
    const { repo, origin, P } = await fixture({ red: true });
    const h = harness(repo, P);
    const st = await branchStep(h);
    const out = await runCommitPr(h.ctx, st, 2000);
    const report = out.eventLog.findLast((e) => e.kind === "plumb-report");
    assert(
      report?.kind === "plumb-report" && report.body.includes("followup round parks"),
      `main red at M: the followup park reason (${capOf(out)})`,
    );
    assert((await remoteHead(origin)) === P, "main red at M: remote unchanged");
    assert(h.dispatched.length === 0, "main red at M: zero dispatches");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
