/**
 * The real-git harness the baseline-red suite drives `runVerifyCommandGate`
 * through: one bare-repo builder (base commit, detached change worktree,
 * optional origin advanced past the base) plus the per-directory stub verify
 * command. Split out of `test-verify-baseline-red.ts` for the AGENTS.md §12
 * 500-line cap; the stale-base case (#2341) lives in
 * `test-verify-baseline-stale-base.ts` and drives the SAME builder, because
 * two copies of a git fixture are two fixtures that quietly disagree.
 *
 * Not a test: no assertions here, so the offline loop never runs it alone.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { runVerifyCommandGate } from "../../src/work-driver-verify-verify-cmd.ts";
import { initialState } from "../../src/workflow-state.ts";
import { commandOf } from "./argv-shell.ts";

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const sh = (cwd: string, cmd: string) => execFileP("/bin/sh", ["-c", cmd], { cwd });

/** The verify command the stub answers, chosen per working directory. */
export const CMD = "bash scripts/verify.sh";

export type Outcome = { ok: true } | { ok: false; stdout: string; killed?: boolean };

/**
 * Build `<root>/<name>/repo` on a real git, add the change worktree, and run
 * the gate with a stub verify whose outcome is chosen per working directory
 * (the two `baseline-verify-9-base*` trees are the base, everything else is
 * the change). `originAhead` pushes the base to a real bare origin and
 * advances `main` N commits past it — the #2341 stale-base shape, where the
 * cycle's base is a strict ancestor of the default-branch tip.
 */
export async function runGateFixture(
  root: string,
  name: string,
  outcomeFor: (where: "base" | "change", baseRun?: 1 | 2) => Outcome,
  // The callbacks the gate's tail rule (`reportBaselineLeg`) is asked to fire. A
  // case that never passes them cannot tell a claim from a finding, which is the
  // distinction #1826 turns on for the killed arm: the timeout's sentence still
  // leads the evidence, and neither the cap's claim nor #1349's excuse may follow.
  baselineCallbacks: {
    onBaselineAttributed?: () => void;
    onBaselineRedEstablished?: (established: boolean) => void;
  } = {},
  opts: { originAhead?: number } = {},
) {
  const repo = path.join(root, name, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const wt = path.join(repo, ".worktrees", "issue-9-default");
  await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "change.txt"), "new\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "change"]);
  // The integration root ignores its own worktrees, as the driver arranges.
  writeFileSync(path.join(repo, ".git", "info", "exclude"), ".worktrees/\ntmp/\n");
  if (opts.originAhead !== undefined) {
    // A real bare origin: push the base, then advance main past it. The cycle's
    // baseSha stays the FIRST commit, so `base..origin/main` is exactly the
    // N fix commits the base predates — the nessie 1415 shape where the red
    // was already fixed on the default branch.
    const origin = path.join(root, name, "origin.git");
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
    await git(repo, ["remote", "add", "origin", origin]);
    await git(repo, ["push", "-q", "origin", "main"]);
    await git(repo, ["remote", "set-head", "origin", "main"]);
    for (let n = 1; n <= opts.originAhead; n++) {
      writeFileSync(path.join(repo, `upstream-${n}.txt`), `upstream ${n}\n`);
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-q", "-m", `fix(session): repair fast path bound ${n}`]);
      await git(repo, ["push", "-q", "origin", "main"]);
    }
  }

  const baselineDir = path.join(repo, ".worktrees", "baseline-verify-9-base1");
  const secondBaselineDir = path.join(repo, ".worktrees", "baseline-verify-9-base2");
  const verifyRuns: Array<"base" | "change"> = [];
  let baselineHadChange: boolean | undefined;
  const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
    cmd = commandOf(cmd, o);
    if (cmd.startsWith("git ")) return { stdout: (await sh(o?.cwd ?? "", cmd)).stdout };
    const where = o?.cwd === baselineDir || o?.cwd === secondBaselineDir ? "base" : "change";
    if (where === "base") baselineHadChange = existsSync(path.join(baselineDir, "change.txt"));
    verifyRuns.push(where);
    const r = outcomeFor(where, o?.cwd === secondBaselineDir ? 2 : 1);
    if (r.ok) return { stdout: "" };
    const e = new Error(`Command failed: ${cmd}`) as Error & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    e.stdout = r.stdout;
    e.stderr = "";
    e.killed = r.killed;
    throw e;
  };
  const state = initialState(9);
  state.pipelineState.worktrees = { default: wt };
  state.pipelineState.baseSha = baseSha;
  const failures: string[] = [];
  const notes: string[] = [];
  await runVerifyCommandGate({
    execFn,
    cmd: CMD,
    ctx: {
      host: {} as unknown as DriverContext["host"],
      repoRoot: repo,
      issue: 9,
    } as DriverContext,
    state,
    worktrees: { default: wt },
    baseSha,
    changedWorktrees: [wt],
    workstreamBaseShas: undefined,
    failures,
    notes,
    ...baselineCallbacks,
  });
  const listed = (await git(repo, ["worktree", "list"])).stdout;
  return {
    failures,
    notes,
    verifyRuns,
    baselineHadChange,
    baseSha,
    state,
    listed,
    baselineDir,
    secondBaselineDir,
  };
}
