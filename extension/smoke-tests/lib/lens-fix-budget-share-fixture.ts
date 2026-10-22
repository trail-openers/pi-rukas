/**
 * Shared fixtures for #1742's budget-share tests
 * (`test-lens-fix-budget-share.ts`, split for the AGENTS.md §12 500-line cap).
 *
 * Everything offline: a real git fixture in a tmp dir (so the lens-fix
 * reposition gate reports `already-at-tip`), a scripted dispatch that records
 * the bound it was handed, and a scripted git/gh exec that lets
 * `currentPatchIdentity` resolve and `gh pr comment` be recorded or failed —
 * the same four commands `test-draft-disclosure-carries-marker-1398.ts` pins.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../../src/types.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { createEmitSink } from "../../src/work-state-emit.ts";
import { type WorkEvent, type WorkState, initialState } from "../../src/workflow-state.ts";
import { commandOf } from "./argv-shell.ts";

const execFileP = promisify(execFile);

export const MIN = 60_000;
/** Fixed epoch for the pure-arithmetic block; a live Date.now() drifts across
 *  assertions and turns an exact `=== undefined` into a flake. */
export const NOW = 1_800_000_000_000;

/** The tip `origin/<branch>` resolves to in the scripted git exec — the head a
 *  lens round is said to have reviewed when a test wants the `ci` route (#1742). */
export const HEAD_SHA = "9f3c1e5d7a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d";
/** A DIFFERENT tip: what the branch carries after a lens-fix committed. A
 *  verdict recorded on `HEAD_SHA` must not license a route over this one. */
export const OTHER_HEAD_SHA = "11223344556677889900aabbccddeeff00112233";

const git = (cwd: string, args: string[]) =>
  execFileP("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

/** A repo on a feature branch with one commit (the reposition gate's
 *  `already-at-tip` shape, so runLensFix reaches its dispatch). */
export async function fixture(name: string): Promise<{ repo: string; branch: string }> {
  const repo = mkdtempSync(path.join(tmpdir(), `pi-ens-1742-${name}-`));
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-qm", "base"]);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const branch = "feature/issue-1742";
  await git(repo, ["checkout", "-qb", branch]);
  writeFileSync(path.join(repo, "b.txt"), "feature\n");
  await git(repo, ["add", "b.txt"]);
  await git(repo, ["commit", "-qm", "feature"]);
  await git(repo, ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
  return { repo, branch };
}

export function reviewStateAt(
  reviewCapStartedAt: number,
  lensReviewedHead?: string,
): WorkState {
  const s = initialState(1742);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "lens-fix",
      lastCompletedStep: "lens-review",
      branchName: "feature/issue-1742",
      prNumber: 17420,
      reviewRound: 1,
      reviewCapStartedAt,
      ...(lensReviewedHead ? { lensReviewedHead } : {}),
    },
  };
}

/** The JSON findings blob the lens step persists (renderLensFindings parses
 *  it; a prose blob would render empty and fake a failed disclosure). */
export const FINDINGS = JSON.stringify([
  {
    lens: "SIMPLICITY",
    severity: "MEDIUM",
    path: "src/a.ts",
    line: 12,
    title: "duplicated guard",
  },
]);
export const approvedEv: WorkEvent = {
  kind: "adversarial-approved",
  at: 1_000_002,
  jobId: "adv",
  round: 1,
};
/** The verdict event the lens step persists. `headSha` is the head the round
 *  read (#1742): the owed-round `ci` route may only be taken when it equals
 *  the branch tip, so a test that wants the route passes HEAD_SHA and a test
 *  that wants the park passes a head that is no longer current. */
export const issuesEv = (verdict: string, headSha?: string): WorkEvent => ({
  kind: "lens-issues-found",
  at: 1_000_003,
  jobId: "j",
  round: 1,
  verdict,
  ...(headSha ? { headSha } : {}),
  findings: FINDINGS,
  totalFindings: 1,
});
/** A round that came back clean — it supersedes any earlier round's findings. */
export const lensApprovedEv = (round: number): WorkEvent => ({
  kind: "lens-approved",
  at: 1_000_004,
  jobId: "j2",
  round,
});

/** A context whose git/gh are scripted: `currentPatchIdentity` resolves and
 *  `gh pr comment` is recorded (or made to fail). */
export function disclosureCtx(opts: { ghFails?: string; headSha?: string } = {}) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-1742-disc-"));
  const gh: string[] = [];
  const notices: string[] = [];
  const execFn = (async (cmd: string, o?: { argv?: string[] }) => {
    const line = commandOf(cmd, o);
    if (/^gh\b/.test(line)) {
      gh.push(line);
      if (opts.ghFails && /^gh pr comment/.test(line)) throw new Error(opts.ghFails);
      return { stdout: "https://example.test/pull/17420\n" };
    }
    if (cmd.startsWith("git symbolic-ref")) return { stdout: "main\n" };
    if (cmd.startsWith("git config --get remote.origin.url"))
      return { stdout: "https://github.com/o/r\n" };
    if (cmd.startsWith("git remote get-url")) return { stdout: "https://github.com/o/r\n" };
    if (cmd.startsWith("git merge-base")) return { stdout: `${"1".repeat(40)}\n` };
    if (cmd.includes("git patch-id")) return { stdout: `${"3".repeat(40)} (stdin)\n` };
    // #1742 — the branch tip `currentPatchIdentity` now reports beside the
    // patch id; the owed-round route compares it against the recorded head.
    if (line.includes("rev-parse")) return { stdout: `${opts.headSha ?? HEAD_SHA}\n` };
    return { stdout: "" };
  }) as never;
  const ctx = {
    host: { sendUserMessage: (text: unknown) => notices.push(String(text)) } as never,
    repoRoot,
    issue: 1742,
    emitSink: createEmitSink(() => undefined),
    verifyExecFn: execFn,
  } as unknown as DriverContext;
  return { ctx, repoRoot, gh, notices };
}

export function dispatchCtx(
  repo: string,
  onDispatch: (opts?: { timeoutMs?: number }) => void,
): DriverContext {
  return {
    host: { sendUserMessage: () => undefined } as never,
    repoRoot: repo,
    issue: 1742,
    emitSink: createEmitSink(() => undefined),
    dispatchFn: (async (_pi: unknown, _spec: unknown, opts?: { timeoutMs?: number }) => {
      onDispatch(opts);
      return {
        role: "developer",
        ok: true,
        text: "fixed",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as DispatchResult;
    }) as never,
    issueBodyFetcherFn: async () => ({
      stdout: "title:\tmock\nstate:\tOPEN\n\nbody — non-empty so the guard does not fire",
    }),
  } as unknown as DriverContext;
}

/** The ctx the develop fix-pass block drives `runDevelopTopological` with:
 *  dispatches are recorded (label + bound), every git exec answers empty. */
export function developCtx(
  repo: string,
  seen: Array<{ label?: string; timeoutMs?: number }>,
): DriverContext {
  return {
    host: { sendUserMessage: () => undefined } as never,
    repoRoot: repo,
    issue: 1742,
    emitSink: createEmitSink(() => undefined),
    dispatchFn: (async (_pi: unknown, _spec: unknown, o?: { label?: string }) => {
      seen.push({ label: o?.label, timeoutMs: o?.timeoutMs });
      return {
        role: "developer",
        ok: true,
        text: "fixed",
        toolUses: [],
        ms: 1,
        exitCode: 0,
      } as DispatchResult;
    }) as never,
    verifyExecFn: async () => ({ stdout: "", stderr: "" }),
  } as unknown as DriverContext;
}
