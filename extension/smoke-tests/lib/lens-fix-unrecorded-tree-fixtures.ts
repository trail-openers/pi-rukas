/**
 * BASE variant of the #1852 round 3 item 1 fixture — run against a checkout of
 * `a9758573`, the last commit before #1852 added the lens-fix fence gate.
 *
 * It imports ONLY modules that exist on base (`work-driver-adversarial.ts`,
 * `work-driver-lens-fix.ts`, `workflow-state.ts`, the shared git fixtures) and
 * records the push through the context's `verifyExecFn`, because the landing arm
 * pushes with `runNetGit(ctx.verifyExecFn ?? execp, …)` — no stub-only seam, so
 * the identical fixture loads on both sides.
 *
 * The point of this file is the non-vacuity of the HEAD-side assertions: on base
 * the driver has NO lens-fix scope fence, so the same fixture that parks must
 * instead commit the fixer's stray and attempt the push. If that did not happen
 * there, "nothing was pushed" on HEAD would prove nothing.
 */

import { execSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import type { DispatchResult } from "../../src/types.ts";
import { defaultExec } from "../../src/work-driver-adversarial-fix-git.ts";
import type { CycleContext } from "../../src/work-driver-context.ts";
import { runAdversarial } from "../../src/work-driver-adversarial.ts";
import { runLensFix } from "../../src/work-driver-lens-fix.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import { initialState } from "../../src/workflow-state.ts";
import { git, repoWithFile, silentSink } from "./adversarial-fix-fixtures.ts";

const FINDINGS = '[{"path":"a.txt","severity":"MEDIUM","title":"t","suggestion":"s"}]';
const STRAY = "fixer-stray.md";

export interface UnrecordedFixture {
  repoRoot: string;
  tree: string;
  branch: string;
  strayPath: string;
}

export function unrecordedRepo(
  label: string,
  opts: { treePath: "repoRoot" | "worktree"; stray: boolean },
): UnrecordedFixture {
  const repoRoot = repoWithFile(label);
  const branch = "feature/issue-1852";
  const remote = `${repoRoot}-origin`;
  execSync(`git init -q --bare ${remote}`, { cwd: repoRoot, stdio: "pipe" });
  git(repoRoot, `remote add origin ${remote}`);
  git(repoRoot, "config user.email t@t");
  git(repoRoot, "config user.name t");
  git(repoRoot, "push -q -u origin main");
  git(repoRoot, `checkout -q -b ${branch}`);
  const tree = opts.treePath === "repoRoot" ? repoRoot : `${repoRoot}/.worktrees/issue-1852`;
  if (opts.treePath === "worktree") {
    git(repoRoot, "worktree add -q --detach .worktrees/issue-1852 main");
  }
  writeFileSync(`${tree}/a.txt`, "two — the finding is addressed\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "fix(lens): the round 1 finding"');
  git(repoRoot, `push -q -u origin ${branch}`);
  const strayPath = `${tree}/${STRAY}`;
  if (opts.stray) writeFileSync(strayPath, "written past the fence, never staged\n");
  return { repoRoot, tree, branch, strayPath };
}

export function lensFixState(f: UnrecordedFixture, recordTree: boolean): WorkState {
  const s = initialState(1852, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "lens-fix",
      lastCompletedStep: "lens-fix",
      reviewRound: 1,
      baseSha: git(f.repoRoot, "rev-parse main").trim(),
      branchName: f.branch,
      ...(recordTree ? { worktrees: { default: f.tree } } : {}),
      workstreams: {
        default: { id: "default", scope: "fix a.txt", paths: ["a.txt"], outOfScope: ["b.txt"] },
      },
    },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 1_100_000,
        jobId: "j-1",
        round: 1,
        findings: FINDINGS,
        verdict: "ISSUES_FOUND",
      },
    ],
  };
}

export function unrecordedCtx(f: UnrecordedFixture, pushes: string[]): CycleContext {
  const record = async (cmd: string, opts?: { argv?: string[]; cwd?: string }) => {
    const full = (opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd).trim();
    if (/\bgit\b.*\bpush\b/.test(full)) pushes.push(full);
    return defaultExec(cmd, opts as never);
  };
  return {
    host: { sendUserMessage: () => {}, emit: () => {} } as never,
    repoRoot: f.repoRoot,
    issue: 1852,
    emitSink: silentSink,
    verifyExecFn: record,
    dispatchFn: async () =>
      ({
        role: "developer",
        ok: true,
        text: "fixed",
        toolUses: [],
        ms: 5,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
        stopReason: "endTurn",
        killCause: undefined,
      }) as unknown as DispatchResult,
    adversarialLoopFn: async () =>
      ({
        role: "adversarial-developer",
        ok: true,
        text: "VERDICT: APPROVED",
        toolUses: [],
        ms: 5,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
        stopReason: "endTurn",
        killCause: undefined,
        adversarialRounds: [
          {
            round: 1,
            status: "APPROVED",
            verdictParsed: true,
            text: "VERDICT: APPROVED",
            ms: 5,
            exitCode: 0,
            transcriptPath: "/tmp/stub.json",
          },
        ],
      }) as unknown as DispatchResult,
  } as unknown as CycleContext;
}

export async function driveLensFixAndAdversarial(
  f: UnrecordedFixture,
  recordTree: boolean,
  pushes: string[],
): Promise<{ caps: string[]; before: string; after: string; state: WorkState }> {
  const before = git(f.repoRoot, `rev-list --count origin/${f.branch}`).trim();
  const c = unrecordedCtx(f, pushes);
  const afterLensFix = await runLensFix(c, lensFixState(f, recordTree), 1_500_000);
  const state = await runAdversarial(c, afterLensFix, 2_000_000);
  const after = git(f.repoRoot, `rev-list --count origin/${f.branch}`).trim();
  return {
    caps: state.eventLog
      .filter((e) => e.kind === "cap-hit")
      .map((e) => (e as { cap: string }).cap),
    before,
    after,
    state,
  };
}

export function cleanupRepo(repoRoot: string): void {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(`${repoRoot}-origin`, { recursive: true, force: true });
}
