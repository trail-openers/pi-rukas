/**
 * Shared fixtures for the #1114 adversarial fix-pass tests (real git repos,
 * a developer stub, and git-error injection). Not a test itself (no `test-`
 * prefix, so the gate glob does not run it).
 */

import { exec, execFile, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../../src/types.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { type WorkState, initialState } from "../../src/workflow-state.ts";
import { gitTestEnv } from "./git-test-env.ts";

const realExec = promisify(exec);
const realExecFile = promisify(execFile);

export function tmpDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `adv-fix-${label}-`));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return dir;
}

/** Run one real git command in `cwd` and return its stdout.
 *
 * #1145 — `env: gitTestEnv()`. `execSync` is the synchronous spawn form, which
 * bun 1.3 does not fix with an ambient `process.env` write, and the repos built
 * through here are the ones the develop/consolidate gates read their dirty
 * state from: a host `~/.config/git/ignore` makes a fixture file vanish from
 * `git status`, which decides the verdict without touching the code. */
export function git(cwd: string, cmd: string): string {
  return execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, {
    cwd,
    stdio: "pipe",
    env: gitTestEnv(),
  }).toString();
}

export function singleState(dir: string, eventLog: WorkState["eventLog"] = []): WorkState {
  const s = initialState(1114, 1_000_000);
  return {
    ...s,
    eventLog,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: { default: dir },
      branchName: "feature/issue-1114",
    },
  };
}

/** A real repo: `a.txt` and `b.txt` committed on main, develop gates on `true`. */
export function repoWithFile(label: string): string {
  const dir = tmpDir(label);
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  writeFileSync(path.join(dir, ".pi", "verify-cmd"), "true\n");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, "b.txt"), "one\n");
  git(dir, "init -q -b main");
  // The driver's own state file lives under .pi/work-state; real cycles exclude it.
  writeFileSync(path.join(dir, ".git", "info", "exclude"), ".pi/work-state/\ntmp/\n");
  git(dir, "add -A");
  git(dir, 'commit -q -m "base"');
  return dir;
}

/** The developer's edit, committed in its worktree as a real developer does. */
export function devCommit(dir: string, file: string, body: string): void {
  writeFileSync(path.join(dir, file), body);
  git(dir, "add -A");
  git(dir, 'commit -q -m "fix"');
}

/** The developer's edit left uncommitted in its worktree. */
export function devWrite(dir: string, file: string, body: string): void {
  writeFileSync(path.join(dir, file), body);
}

/**
 * A single-workstream state routed back to develop: one parsed ISSUES_FOUND
 * round and a fix request naming `findings`. `paths` is the declared fence
 * (empty = N=1 unfenced).
 */
export function fixState(
  dir: string,
  paths: string[],
  findings = "a.txt: change one to two; b.txt: also fix",
): WorkState {
  const base = git(dir, "rev-parse HEAD").trim();
  const s = singleState(dir, [
    { kind: "adversarial-round", at: 1, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
    { kind: "adversarial-fix-requested", at: 2, workstreamId: "default", round: 1, findings },
  ]);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      baseSha: base,
      workstreams: { default: { id: "default", scope: "fix", paths, outOfScope: [] } },
    },
  };
}

/** A successful developer dispatch result. */
export function devOk(role: string): DispatchResult {
  return { role, ok: true, exitCode: 0, text: "done", toolUses: [], ms: 1 } as DispatchResult;
}

/** A driver context whose developer stub is `onDev` and whose git runs for real unless overridden. */
export function fixCtx(
  dir: string,
  onDev: (dir: string) => void,
  verifyExecFn?: DriverContext["verifyExecFn"],
): DriverContext {
  return {
    // A DriverHost is structural (sendUserMessage + emit); a test host records
    // nothing on either, so it satisfies the type as written — no cast needed,
    // and a cast here would hide a real shape change on the host seam.
    host: { sendUserMessage: () => {}, emit: () => {} },
    repoRoot: dir,
    issue: 1114,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
    verifyExecFn,
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "developer") onDev(dir);
      return devOk(spec.role);
    },
  };
}

/**
 * A git executor that fails any command containing `match` (a simulated
 * unreadable tree, base or HEAD) and runs every other command for real. Argv-form
 * calls (`opts.argv`, the develop step's git reads) are matched on the full
 * command line and run without a shell, as the production executor does.
 */
export function execFailing(match: string): NonNullable<DriverContext["verifyExecFn"]> {
  return (cmd, opts) => {
    const full = [cmd, ...(opts?.argv ?? [])].join(" ");
    if (full.includes(match)) return Promise.reject(new Error(`simulated git failure: ${match}`));
    if (opts?.argv) {
      return realExecFile(cmd, opts.argv, { cwd: opts.cwd, maxBuffer: opts.maxBuffer });
    }
    return realExec(cmd, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer });
  };
}

/**
 * #1137 — a two-workstream (docs + code) state with a pending fix for the
 * DOCS workstream. The docs workstream is declared on `b.txt` (a non-source,
 * docs-style path) and the code sibling on `a.txt`; the issue body carries a
 * criterion owned only by the code sibling. Used to assert the per-workstream
 * adversarial prompt scopes the docs review and lists the sibling's criteria
 * as out of scope.
 */
export function twoWorkstreamState(
  dir: string,
  findings = "b.txt: document the change",
): WorkState {
  const base = git(dir, "rev-parse HEAD").trim();
  const s = singleState(dir, [
    { kind: "adversarial-round", at: 1, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
    { kind: "adversarial-fix-requested", at: 2, workstreamId: "docs", round: 1, findings },
  ]);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      baseSha: base,
      worktrees: { docs: dir, code: dir },
      workstreams: {
        docs: {
          id: "docs",
          scope: "document the change in b.txt",
          paths: ["b.txt"],
          outOfScope: ["a.txt"],
        },
        code: {
          id: "code",
          scope: "implement the feature in a.txt",
          paths: ["a.txt"],
          outOfScope: ["b.txt"],
        },
      },
      plumbReports: [],
    },
  };
}
