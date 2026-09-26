/**
 * helpers-integrate-pin-realgit — shared fixtures + harness for the #861
 * SLICE-1 real-git test (test-work-driver-integrate-pin-realgit.ts), split
 * for the AGENTS.md §12 500-line smoke-test cap.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";

/** The audit's state input: a completed ops:commit-pr dispatch + the branch fields. */
export function auditStateFor(
  issue: number,
  branchName: string,
  baseSha: string,
  summary: string,
  extra: Record<string, unknown> = {},
): WorkState {
  let st = initialState(issue, 1000);
  st = appendEvent(st, {
    kind: "dispatch-completed",
    step: "commit-pr",
    role: "ops",
    label: "ops:commit-pr",
    jobId: "j1",
    summary,
    ms: 100,
    at: 2000,
    ok: true,
  });
  return {
    ...st,
    pipelineState: { ...st.pipelineState, branchName, baseSha, ...extra },
  };
}

/** A driver context for a direct auditCommitPrFallback call (real-exec verify seam). */
export function auditCtx(repo: string, issue: number): DriverContext {
  return {
    pi: {} as unknown as DriverContext["pi"],
    repoRoot: repo,
    issue,
    verifyExecFn: realExec,
  } as unknown as DriverContext;
}

const execFileP = promisify(execFile);

export const realExec = async (cmd: string, o?: { cwd?: string; maxBuffer?: number }) => {
  try {
    const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
      cwd: o?.cwd,
      maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(`${err.message}\n${err.stderr ?? ""}`);
  }
};
export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

export type RealgitRoot = string;

export async function fixture(
  root: RealgitRoot,
  name: string,
): Promise<{ repo: string; baseSha: string }> {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "shared.txt"), "line1\nline2\nline3\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "shared.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return { repo, baseSha: stdout.trim() };
}

/** A local bare "remote" so `git push -u origin <branch>` works offline. */
export async function addLocalRemote(root: RealgitRoot, repo: string): Promise<void> {
  const remote = path.join(root, `${path.basename(repo)}-remote.git`);
  await execFileP("git", ["init", "-q", "--bare", remote]);
  await git(repo, ["remote", "add", "origin", remote]);
}

export const mkResult = (o: Partial<DispatchResult> = {}): DispatchResult => ({
  role: "explore",
  ok: true,
  text: "stub",
  toolUses: [],
  ms: 100,
  exitCode: 0,
  transcriptPath: "/tmp/stub-transcript.json",
  ...o,
});

const PLAN_REPLY = `## Workstreams

### task-a — edit the shared file
- paths: shared.txt
- out-of-scope: docs
`;

export function makeCtx(opts: {
  repo: string;
  issue: number;
  branchName: string;
  baseSha: string;
  worktreePath: string;
  onOpsCommitPr: (cwd: string | undefined, prompt: string) => Promise<DispatchResult | undefined>;
}): DriverContext {
  const { repo, issue, branchName, baseSha, worktreePath } = opts;
  const exec = async (cmd: string, o?: { cwd?: string }) => {
    if (cmd.startsWith("gh ")) return { stdout: "" };
    if (cmd.startsWith("git fetch")) return { stdout: "" };
    return realExec(cmd, o);
  };
  const dispatchFn: NonNullable<DriverContext["dispatchFn"]> = async (_pi, spec, dOpts) => {
    const label = dOpts?.label ?? spec.role;
    if (label === "explore") return mkResult({ text: "VERDICT: NEEDS_WORK" });
    if (label === "plan") return mkResult({ text: PLAN_REPLY });
    if (label === "ops") {
      return mkResult({
        role: "ops",
        text: `branch: ${branchName}\n\n## Worktrees\n\n- task-a: ${worktreePath}`,
      });
    }
    if (label.startsWith("developer"))
      return mkResult({ role: "developer", text: "done — implemented" });
    if (label === "ops:commit-pr") {
      return (
        (await opts.onOpsCommitPr(spec.cwd, spec.prompt)) ??
        mkResult({ role: "ops", text: "stub commit-pr (see onOpsCommitPr)" })
      );
    }
    if (label === "ops:ci") throw new Error("halt at ci: integration assertion boundary");
    if (label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
    throw new Error(`unexpected dispatch: ${label}`);
  };
  return {
    pi: {} as unknown as DriverContext["pi"],
    repoRoot: repo,
    issue,
    issueBodyFetcherFn: async (i: number) => ({
      stdout: `title:\tmock issue #${i}\nstate:\tOPEN\n\nmock body for issue #${i}`,
    }),
    verifyExecFn: exec,
    adversarialLoopFn: async () =>
      mkResult({ role: "adversarial-developer", text: "APPROVED after round 1" }),
    dispatchFn,
  };
}

/** Run the driver, capturing the ops:commit-pr invocation. */
export async function runCycle(opts: {
  repo: string;
  issue: number;
  branchName: string;
  baseSha: string;
  worktreePath: string;
  onOpsCommitPr: (cwd: string | undefined, prompt: string) => Promise<DispatchResult | undefined>;
}) {
  process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
  process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
  process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
  process.env.PI_ENSEMBLE_VERIFY = "0";
  const ctx = makeCtx(opts);
  await runWorkDriver(ctx).catch(() => {});
  const { readState } = await import("../src/workflow-state.ts");
  return readState(opts.repo, opts.issue);
}
