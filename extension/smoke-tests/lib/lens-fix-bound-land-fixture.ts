/**
 * lens-fix-bound-land-fixture — the shared harness for the two #1779 lens-fix
 * bound-kill smoke tests: a real bare origin, a real cycle worktree, and a
 * scripted fixer that commits into the lens tree and then returns a bound kill.
 *
 * Split out of test-work-driver-lens-fix-bound-landed.ts for the 500-line gate;
 * the scenarios live in that file and its -canaries sibling.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../../src/types.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import { initialState } from "../../src/workflow-state.ts";
import { mkLensSummary, setupSpawnGuard } from "../test-helpers.ts";
import { realExec } from "./exec-fake.ts";

/** The runner's failure counter: `assert` sets it, the test file prints and
 *  exits with it. Shared so a scenario and its canaries report one verdict. */
/**
 * #1789 round 2 — when true, the scripted fixer reports its work as DONE after
 * committing instead of reporting a kill. A real child that has committed is
 * ended as done at its bound (`spawn-child-bound.ts`), so the scenarios that
 * want the *converted* shape set this and let the driver's own bound produce
 * the kill; the scenarios that want a plain kill leave it off.
 */
export const boundLandRun = { failed: false, commitAndKill: false };

export function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    boundLandRun.failed = true;
  }
}

/** Capture `trace` output while running `fn` (trace writes `[pi-rukas] …` to
 *  stderr and consults the env var per call). */
export async function withTrace<T>(fn: () => Promise<T>): Promise<{ result: T; traced: string }> {
  const prior = process.env.PI_ENSEMBLE_DEBUG;
  process.env.PI_ENSEMBLE_DEBUG = "1";
  const write = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), traced: captured };
  } finally {
    process.stderr.write = write;
    process.env.PI_ENSEMBLE_DEBUG = prior ?? "";
  }
}

export function makeFakePi(): ExtensionAPI {
  return {
    sendUserMessage: () => undefined,
    emit: () => undefined,
  } as unknown as ExtensionAPI;
}

export const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
});

export function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

// #1789 — the bound-land conversion joins the `dispatch-failed` tail to the
// dispatch that wrote it by jobId, and that id comes from `beginDispatch`. With
// resume off, `beginDispatch` returns the minted id but never marks it in
// flight; keep resume ON so the fixture exercises the same write-ahead path
// production runs (the state files it writes live in the per-test tmp dir).
process.env.PI_ENSEMBLE_RESUME = "1";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_FORGE = "none";
process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE = "0";
// The budget must actually arm a bound, or the armed/kill trace lines this test
// asserts can never appear.
delete process.env.PI_ENSEMBLE_REVIEW_ENFORCE;
setupSpawnGuard();

/** bare origin + repo on a feature branch + a detached worktree at the branch
 *  tip, in the layout a real cycle has: the lens-fix tree lives under
 *  `<repoRoot>/.worktrees/` and is what `pipelineState.worktrees` records.
 *
 *  #1852 review item 2 — the tree used to sit at `<dir>/wt`, outside the repo.
 *  That is not a shape production ever produces (every workstream develops in a
 *  `.worktrees/` tree, #287/#445), and it made the lens-fix fence gate refuse a
 *  round it should have admitted: the driver's own revert guard
 *  (`assertInsideWorktrees`) refuses to touch anything outside `.worktrees/`, so
 *  an in-fence fix was parked as if it had strays. A fixture whose tree is in a
 *  layout the guard can never accept proves the bound-kill landing only by
 *  accident. */
export async function mkFixture(dir: string, branch: string) {
  const fs = await import("node:fs/promises");
  const origin = path.join(dir, "origin.git");
  const root = path.join(dir, "root");
  const wt = path.join(root, ".worktrees", "issue-lens-bound");
  await realExec("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
  await realExec("git init -q --initial-branch=main root", { cwd: dir });
  await realExec('git config user.email "t@t" && git config user.name "T"', {
    cwd: root,
    shell: "/bin/bash",
  });
  // `.worktrees/` is ignored for the same reason it is in a real cycle: the
  // tree is driver scaffolding, and an unignored one makes the repo root dirty,
  // which the stray revert's own commit refuses to work beside.
  writeFileSync(path.join(root, ".git", "info", "exclude"), "\n.pi/\n.tmp\n.worktrees/\n");
  await fs.writeFile(path.join(root, "base.txt"), "hello\n");
  await realExec("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
  await realExec(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
  await realExec("git push -q -u origin main", { cwd: root });
  await realExec("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
    cwd: root,
  });
  await realExec(`git checkout -qb ${branch}`, { cwd: root });
  const baseSha = (await realExec("git rev-parse HEAD", { cwd: root })).stdout.trim();
  await fs.writeFile(path.join(root, "feature.txt"), "buggy\n");
  // A tracked file under `src/` so the tree HAS that directory: the fence's
  // anchored-helper route admits an undeclared file in a declared path's
  // directory, and the fixer's files live under `src/` for that reason (see
  // `fixerDeclaredPaths`).
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "keep.txt"), "keep\n");
  await realExec(
    `git add feature.txt src/keep.txt && git commit -q -m 'feature' && git push -q -u origin ${JSON.stringify(branch)}`,
    { cwd: root, shell: "/bin/bash" },
  );
  await realExec(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(branch)}`, {
    cwd: root,
  });
  return { origin, root, wt, baseSha };
}

/**
 * The declared fence for the scripted fixer's files (#1852 review item 2).
 *
 * The lens-fix fence (#1852) judges the round's delta against the workstream's
 * DECLARED paths plus the finding-named widening. The scripted fixer writes
 * `src/fix-<i>.txt`, which the findings never name — so with an empty `paths`
 * list the fence refuses its own work and the round parks `lens-fix-scope`
 * before the landing arm can push. That is the fence working; a bound-kill test
 * is not about it, so the fixture declares what the fixer is contracted to
 * write and the assertions keep meaning what they say.
 *
 * The `src/` prefix is not decoration: the anchored-helper route admits an
 * undeclared file that sits in the directory of a declared path, and
 * `anchorDirs(["fix-0.txt"])` is EMPTY for a root-level file — so a root-level
 * stray would be admitted by every route and the fence could not refuse one.
 * Declaring under `src/` is what gives the "must not push a stray" case a stray
 * the ladder actually refuses.
 */
export function fixerDeclaredPaths(commits: number): string[] {
  return Array.from({ length: Math.max(commits, 0) }, (_, i) => `src/fix-${i}.txt`);
}

/**
 * Put a `dispatch-failed` lens-fix tail on a state, for the classifier tests
 * that need an EXACT tail — a jobId the round does not own, or a kill the
 * caller's cycle deadline produced. The driver path cannot fabricate either,
 * so the guard is exercised where it lives.
 */
export function killTail<T extends { eventLog: unknown[] }>(
  state: T,
  jobId: string,
  killCause: DispatchResult["killCause"],
  killedAtCycleDeadline?: boolean,
): T {
  return {
    ...state,
    eventLog: [
      ...state.eventLog,
      {
        kind: "dispatch-failed",
        step: "lens-fix",
        role: "developer",
        jobId,
        label: "developer:lens-fix-1",
        ms: 1_000,
        at: 3_000_000,
        exitCode: null,
        killCause,
        ...(killedAtCycleDeadline === true ? { killedAtCycleDeadline: true } : {}),
      },
    ],
  };
}

/** The state of a cycle that has just come back from a lens round with
 *  findings and is about to dispatch the fixer. */
export function mkLensFixState(
  issue: number,
  branch: string,
  baseSha: string,
  wt: string,
  declaredPaths: readonly string[] = [],
) {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "lens-fix" as const,
      lastCompletedStep: "lens-review" as const,
      worktrees: { default: wt },
      workstreams: {
        default: {
          id: "default",
          scope: "test",
          paths: [...declaredPaths],
          outOfScope: [],
        },
      },
      branchName: branch,
      baseSha,
      prNumber: issue * 10,
      reviewRound: 1,
      // A clock 20 minutes into a 90-minute loop: the budget leaves plenty, so
      // the fixer IS armed with a bound (rather than refused at its gate).
      reviewCapStartedAt: Date.now() - 20 * 60_000,
    },
    eventLog: [
      {
        kind: "lens-issues-found" as const,
        at: 2_000_000,
        jobId: "j-lens-1",
        round: 1,
        headSha: "",
        findings: JSON.stringify([
          {
            lens: "SIMPLICITY",
            severity: "MEDIUM",
            path: "feature.txt",
            line: 1,
            title: "stale comment",
            description: "the comment contradicts the code",
            suggestion: "fix it",
          },
        ]),
        verdict: "ISSUES_FOUND" as const,
      },
    ],
  };
}

/** A fixer dispatch that commits in the lens worktree and then returns killed.
 *  `commits: 0` makes it kill without producing anything.
 *
 *  #1789 — the transcript path is derived from the `runId` the driver passed in
 *  (which IS the dispatch's jobId), the way `spawn` does in production. That is
 *  what lets the completion event carry the driver's jobId: the builder accepts
 *  a claimed id only when the transcript basename proves it. */
export function killedFixer(wt: string, commits: number, killCause: DispatchResult["killCause"]) {
  return async (
    _pi: unknown,
    spec: { role?: string; prompt?: string; runId?: string },
    opts?: { label?: string },
  ): Promise<DispatchResult> => {
    if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
    const transcript = (role: string) =>
      spec.runId ? `/tmp/${spec.runId}-${role}.json` : "/tmp/stub.json";
    if (opts?.label?.startsWith("developer:lens-fix")) {
      const fs = await import("node:fs/promises");
      for (let i = 0; i < commits; i++) {
        await fs.mkdir(path.join(wt, "src"), { recursive: true });
        await fs.writeFile(path.join(wt, `src/fix-${i}.txt`), `fix ${i}\n`);
        await realExec(`git add src/fix-${i}.txt && git commit -q -m 'fix(lens): part ${i}'`, {
          cwd: wt,
          shell: "/bin/bash",
        });
      }
      // #1789 round 2 — a real spawn ends a child that has COMMITTED as DONE,
      // not as a `timeout` kill (spawn-child-bound.ts `atBackstop`/`commits:`).
      // A scenario that needs the killed-anyway shape — the conversion, which
      // is what runs when the child is stopped before it could report — leaves
      // `commitAndKill` off, so the kill is reported as it was observed.
      if (boundLandRun.commitAndKill) {
        return mkResult({
          role: "developer",
          text: "Fixed, then stopped at the bound.",
          transcriptPath: transcript("developer"),
        });
      }
      return mkResult({
        role: "developer",
        ok: false,
        text: "",
        exitCode: null,
        killCause,
        killBudgetMs: 45 * 60_000,
        transcriptPath: transcript("developer"),
      });
    }
    // An adversarial fix pass (the develop step re-dispatched with findings):
    // report the work done so the loop proceeds. Its worktree lives in a
    // scratch dir the scenario hands in, NOT the lens-fix tree — that tree must
    // stay exactly as the killed fixer left it, which is the whole subject of
    // the reposition assertion below.
    if (spec.role === "developer") {
      return mkResult({
        role: "developer",
        text: "Fixed.",
        transcriptPath: transcript("developer"),
      });
    }
    // Any other role (ops:ci, ops:handoff, step-back, …) answers so the cycle
    // runs to its real terminal rather than dying on the fixture. Throwing here
    // would fabricate a dispatch failure the driver then caps — a fixture
    // artefact the assertions would read as a product defect.
    if (spec.role === "ops") {
      return mkResult({
        role: "ops",
        text: "ci-status: success\nPosted.",
        transcriptPath: transcript("ops"),
      });
    }
    return mkResult({
      role: spec.role ?? "explore",
      text: "done",
      transcriptPath: transcript(spec.role ?? "explore"),
    });
  };
}

export function driverCtx(
  root: string,
  issue: number,
  dispatchFn: NonNullable<DriverContext["dispatchFn"]>,
  extra?: Partial<DriverContext>,
): DriverContext {
  return {
    host: makeFakePi(),
    repoRoot: root,
    issue,
    issueBodyFetcherFn: mockIssueBodyOk,
    dispatchFn,
    // Deliberately NOT injected: the driver's default executor honours the argv
    // form (`execFn("git", { argv: [...] })`). A test executor that only speaks
    // the shell-string form turns those calls into a bare `git`, and the cherry-
    // pick machinery inside `landCommittedFix` then fails for a reason that has
    // nothing to do with what is under test.
    adversarialLoopFn: async () =>
      mkResult({
        role: "adversarial-loop",
        ok: true,
        loopOutcome: "approved",
        adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
        text: "Approved.",
      }),
    lensReviewFn: async () => mkLensSummary({ verdict: "APPROVED" }),
    ...extra,
  } as unknown as DriverContext;
}
