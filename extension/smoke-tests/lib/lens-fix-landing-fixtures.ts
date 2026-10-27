/**
 * Shared fixtures for the #1852 lens-fix LANDING tests — the ones that drive
 * `runAdversarial` over a real repo with a real `.worktrees/` tree and a real
 * plan-time fence.
 *
 * Not a test itself (no `test-` prefix, so the gate glob does not run it). It
 * exists because the landing assertions split across two files once #1852 round
 * 2 added the revert-record cases: both files need the same repo shape, the same
 * plan-time fence, and the same APPROVED-reviewer context, and a copy of this
 * much fixture would drift into two subtly different rounds.
 *
 * `label` names the temp dir so cases can tell their repos apart in a failure
 * message. Each fixture builds its tree from scratch rather than mutating one:
 * `reset --hard` would strand the widening commit outside every ref, and
 * `integrate()` reads the round's work through a ref range.
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { DispatchResult } from "../../src/types.ts";
import { defaultExec } from "../../src/work-driver-adversarial-fix-git.ts";
import type { CycleContext } from "../../src/work-driver-context.ts";
import type { LensFixFenceSnapshot } from "../../src/workflow-state-schema.ts";
import { initialState } from "../../src/workflow-state.ts";
import type { WorkState } from "../../src/workflow-state.ts";
import { git, repoWithFile, silentSink } from "./adversarial-fix-fixtures.ts";

/** The findings the lens round reported, naming only the in-scope file. */
export const FINDINGS = '[{"path":"a.txt","severity":"MEDIUM","title":"t","suggestion":"s"}]';

export interface LandingFixture {
  repoRoot: string;
  tree: string;
  branch: string;
}

/** The origin + branch scaffolding both fixtures need, in one place. */
function repoOnBranch(label: string): LandingFixture {
  const repoRoot = repoWithFile(label);
  const branch = "feature/issue-1852";
  // A real `origin` so the landing arm's push has somewhere to go (and so the
  // test can see whether it tried).
  const remote = `${repoRoot}-origin`;
  execSync(`git init -q --bare ${remote}`, { cwd: repoRoot, stdio: "pipe" });
  git(repoRoot, `remote add origin ${remote}`);
  // An identity in the repo config: the landing arm's `git commit` runs in a
  // test process whose HOME is isolated (gitTestEnv), so without this the
  // commit fails for a missing author and the test reports the wrong thing.
  git(repoRoot, "config user.email t@t");
  git(repoRoot, "config user.name t");
  git(repoRoot, "push -q -u origin main");
  git(repoRoot, `checkout -q -b ${branch}`);
  git(repoRoot, `push -q -u origin ${branch}`);
  git(repoRoot, "checkout -q main");
  const tree = `${repoRoot}/.worktrees/issue-1852`;
  git(repoRoot, `worktree add -q --detach .worktrees/issue-1852 ${branch}`);
  writeFileSync(`${tree}/a.txt`, "two\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "feat: the fix the findings asked for"');
  return { repoRoot, tree, branch };
}

/**
 * A repo whose lens fixer COMMITTED a change to `b.txt`, which the workstream
 * fenced `outOfScope`. This is the widening the gate must refuse.
 */
export function fixture(label: string): LandingFixture {
  const f = repoOnBranch(label);
  writeFileSync(`${f.tree}/b.txt`, "written past the fence\n");
  git(f.tree, "add -A");
  git(f.tree, 'commit -q -m "the widening"');
  return f;
}

/** As `fixture`, but with no widening: the round changed only what it declared. */
export function fixtureInFence(label: string): LandingFixture {
  const f = repoOnBranch(label);
  // The finding's fix, in the declared file, on top of the develop commit.
  writeFileSync(`${f.tree}/a.txt`, "three — the finding is addressed\n");
  git(f.tree, "add -A");
  git(f.tree, 'commit -q -m "fix(lens): the round 1 finding"');
  return f;
}

/**
 * #1852 review round 2 — the fixture whose fixer committed the in-fence fix AND
 * wrote one untracked stray outside it. The `ok: true` arm of the fence is the
 * one whose revert used to vanish: the gate reverted the stray, judged the
 * re-read delta clean, and returned the event to a caller that dropped it.
 */
export function fixtureStrayAllowed(label: string): LandingFixture {
  const f = fixtureInFence(label);
  // Untracked, so no ref holds it and the patch is its only record — which is
  // exactly why the ref and patch paths have to reach the operator.
  writeFileSync(`${f.tree}/scratch-notes.md`, "written past the fence, never staged\n");
  return f;
}

/** The workstream shape every fixture and every snapshot agrees on. */
function workstream(tree: string): WorkState["pipelineState"]["workstreams"] {
  return {
    default: { id: "default", scope: "fix a.txt", paths: ["a.txt"], outOfScope: ["b.txt"] },
  };
}

/** The plan-time fence for this tree, from the driver's own planner. */
export async function fenceFor(
  repoRoot: string,
  tree: string,
  branch: string,
): Promise<LensFixFenceSnapshot> {
  const roundTip = git(tree, "rev-parse HEAD~1").trim();
  const s = initialState(1852, 1_000_000);
  const ps = {
    ...s.pipelineState,
    baseSha: git(repoRoot, "rev-parse main").trim(),
    branchName: branch,
    worktrees: { default: tree },
    workstreams: workstream(tree),
  };
  // Loaded lazily: on base the module does not exist, and the base run
  // must load this file at all to demonstrate the hole.
  const { lensFixPassPlan } = await import("../../src/work-driver-lens-fix-fence.ts");
  const planned = await lensFixPassPlan(defaultExec, repoRoot, ps, {
    id: "default",
    worktree: tree,
    roundTip,
    findings: FINDINGS,
  });
  if (!planned.ok) throw new Error(`fence plan failed: ${planned.reason}`);
  return {
    round: 1,
    workstreamId: "default",
    roundTip,
    fence: { ...planned.value.fence, helperDirs: [...planned.value.fence.helperDirs] },
    declared: planned.value.declared,
    named: planned.value.named,
    candidates: [...planned.value.candidates],
    findings: planned.value.findings,
    worktree: tree,
  };
}

/**
 * The state that reaches the landing arm: an approval immediately after a
 * lens-fix round. `hasFence` false omits the snapshot entirely (the base run and
 * the "no record" case); `dispatched` writes the `lens-fix-fence-unavailable`
 * record the gate reads to tell "had a fence, lost it" from "older driver".
 */
export async function stateWith(
  repoRoot: string,
  tree: string,
  branch: string,
  hasFence = true,
  dispatched = false,
): Promise<WorkState> {
  const s = initialState(1852, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "lens-fix",
      reviewRound: 1,
      baseSha: git(repoRoot, "rev-parse main").trim(),
      branchName: branch,
      worktrees: { default: tree },
      workstreams: workstream(tree),
      // The fence the fixer's PROMPT printed, recorded at dispatch time. Built
      // by the driver's OWN planner over this tree rather than hand-typed: a
      // hand-typed candidate set claims provenance the round does not have, and
      // the fence then admits a file nothing earned — the widening case would
      // pass for the wrong reason. On base no such field is written, so none is
      // written here either.
      ...(hasFence ? { lensFixFence: await fenceFor(repoRoot, tree, branch) } : {}),
    },
    eventLog: dispatched
      ? [
          {
            kind: "lens-fix-fence-unavailable" as const,
            at: 1_500_000,
            round: 1,
            worktree: tree,
            reason: "git ls-tree failed: exit 128",
          },
        ]
      : s.eventLog,
  };
}

/**
 * The context every case drives: an APPROVED reviewer (so the step reaches the
 * landing arm, which is where #1852 puts its gate) and an optional push recorder
 * — an attempted push IS the failure in the blocking cases, so those pass a
 * recorder and assert it stayed empty.
 */
export function stubCtx(repoRoot: string, pushes?: string[]): CycleContext {
  return {
    host: { sendUserMessage: () => {}, emit: () => {} } as never,
    repoRoot,
    issue: 1852,
    emitSink: silentSink,
    verifyExecFn: defaultExec,
    ...(pushes
      ? {
          netGitFn: async (args: string[]) => {
            pushes.push(args.join(" "));
            return { stdout: "", stderr: "" };
          },
        }
      : {}),
    adversarialLoopFn: async () =>
      ({
        role: "adversarial-developer",
        ok: true,
        text: "VERDICT: APPROVED",
        toolUses: [],
        ms: 5,
        exitCode: 0,
        transcriptPath: "/tmp/stub.json",
        // A structured absence: the fan-out's infra classifier reads the
        // `error` field alone, and an absent field there is "no error". `ok` and
        // `stopReason` are not consulted for that verdict, so an incomplete stub
        // reads as a severed provider stream and the step never reaches the
        // landing arm these tests exist to drive.
        stopReason: "endTurn",
        killCause: undefined,
        // The reportOnly driver path never re-parses prose: `interpretReview`
        // reads the structured verdict the loop recorded, and a reply without it
        // is "no verdict" -> infra.
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
