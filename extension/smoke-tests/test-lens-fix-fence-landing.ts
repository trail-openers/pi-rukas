#!/usr/bin/env bun
/**
 * #1852 — the lens-fix landing arm pushes an out-of-fence change, and the gate
 * is what stops it.
 *
 * NON-VACUITY FOR THE GATE. The other #1852 tests prove the fence's parts
 * (`test-lens-fix-fence-gate.ts` judges a tree; `test-lens-fix-prompt-fence.ts`
 * pins the prompt). This one drives the STEP: a real repo, a real `.worktrees/`
 * tree, a lens-fix approval whose `lastCompletedStep` is `lens-fix`, and a
 * fixer's commit that changes a file the workstream fenced `outOfScope`.
 *
 * On base (before #1852) that commit is committed and pushed by the landing arm
 * with nobody consulting a fence: `git rev-list --count origin/<base>..HEAD`
 * grows and the push is attempted. With the gate, the round parks on
 * `lens-fix-scope`, the landing arm never runs, and NEITHER happens. The
 * assertions are on git's answer and on the push being attempted, not on a
 * string in a log.
 */

import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import type { DispatchResult } from "../src/types.ts";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import { runAdversarial } from "../src/work-driver-adversarial.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import type { LensFixFenceSnapshot } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The findings the lens round reported, naming only the in-scope file. */
const FINDINGS = '[{"path":"a.txt","severity":"MEDIUM","title":"t","suggestion":"s"}]';

/**
 * A repo with an origin, a branch, a develop commit in the lens worktree, and
 * the fixer's out-of-fence commit on top of it.
 */
function fixture(label: string): { repoRoot: string; tree: string; branch: string } {
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
  // The widening the fence must refuse: a tracked file the workstream fenced.
  writeFileSync(`${tree}/b.txt`, "written past the fence\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "the widening"');
  return { repoRoot, tree, branch };
}

/** As `fixture`, but with no widening: the round changed only what it declared. */
function fixtureInFence(label: string): { repoRoot: string; tree: string; branch: string } {
  const repoRoot = repoWithFile(label);
  const branch = "feature/issue-1852";
  const remote = `${repoRoot}-origin`;
  execSync(`git init -q --bare ${remote}`, { cwd: repoRoot, stdio: "pipe" });
  git(repoRoot, `remote add origin ${remote}`);
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
  // The finding's fix, in the declared file, on top of the develop commit.
  writeFileSync(`${tree}/a.txt`, "three — the finding is addressed\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "fix(lens): the round 1 finding"');
  return { repoRoot, tree, branch };
}

function stateWith(
  repoRoot: string,
  tree: string,
  branch: string,
  hasFence = true,
  dispatched = false,
): Promise<WorkState> {
  const s = initialState(1852, 1_000_000);
  return Promise.resolve(build(repoRoot, tree, branch, s, hasFence, dispatched));
}

async function build(
  repoRoot: string,
  tree: string,
  branch: string,
  s: WorkState,
  hasFence = true,
  dispatched = false,
): Promise<WorkState> {
  const base = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      // The shape that reaches the landing arm: an approval immediately after a
      // lens-fix round.
      lastCompletedStep: "lens-fix",
      reviewRound: 1,
      baseSha: git(repoRoot, "rev-parse main").trim(),
      branchName: branch,
      worktrees: { default: tree },
      workstreams: {
        default: { id: "default", scope: "fix a.txt", paths: ["a.txt"], outOfScope: ["b.txt"] },
      },
      // The fence the fixer's prompt printed, recorded at dispatch time. Built
      // by the driver's OWN planner over this tree rather than hand-typed: a
      // hand-typed candidate set claims provenance the round does not have, and
      // the fence then admits a file nothing earned — the widening case would
      // pass for the wrong reason. On base no such field is written, so none is
      // written here either.
      ...(hasFence ? { lensFixFence: await fenceFor(repoRoot, tree, branch) } : {}),
    },
    // The record the gate reads to tell "this round had a fence and lost it"
    // (park) from "an older driver wrote this state" (do not run) — the same
    // event `runLensFix` writes when its planner refuses.
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
  return base;
}

/** The plan-time fence for this tree, from the driver's own planner. */
async function fenceFor(
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
    workstreams: {
      default: { id: "default", scope: "fix a.txt", paths: ["a.txt"], outOfScope: ["b.txt"] },
    },
  };
  // Loaded lazily: on base the module does not exist, and the base run
  // must load this file at all to demonstrate the hole.
  const { lensFixPassPlan } = await import("../src/work-driver-lens-fix-fence.ts");
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
 * The context every case drives: an APPROVED reviewer (so the step reaches the
 * landing arm, which is where #1852 puts its gate) and a push recorder that
 * refuses — an attempted push IS the failure, and letting one reach a throwaway
 * remote would hide it.
 */
function stubCtx(repoRoot: string, pushes?: string[]): CycleContext {
  return {
    host: { sendUserMessage: () => {}, emit: () => {} } as never,
    repoRoot,
    issue: 1852,
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

console.log("# an out-of-fence lens fix does not reach the branch");
{
  // #1852-4 — the base-vs-head proof is driven THROUGH this file rather than by
  // importing the new fence modules, so the same file runs against base sources
  // too: on base the driver has no lens-fix scope fence, so the SAME fixture
  // that parks here integrates the widening onto the branch. DEFAULT (no env) is
  // the HEAD expectation, because this is the file the offline suite runs.
  // `PI_1852_EXPECT=base` selects the base expectation, and the driver runs it
  // against a copy of the pre-#1852 sources — if those assertions also held
  // there, the head-side ones below would be vacuous.
  const hasFence = process.env.PI_1852_EXPECT !== "base";
  const f = fixture("land-blocked");
  const st = await stateWith(f.repoRoot, f.tree, f.branch, hasFence);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const pushes: string[] = [];
  const ctx = stubCtx(f.repoRoot, pushes);

  const out = await runAdversarial(ctx, st, 2_000_000);
  const after = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  if (!hasFence) {
    // BASE: no fence exists, so the widening is integrated and the branch moves.
    // If this holds on base, every assertion below would hold there too.
    assert(
      !caps.includes("lens-fix-scope"),
      `base has no lens-fix fence to park on (caps: ${JSON.stringify(caps)})`,
    );
    assert(
      Number(after) > Number(before),
      `NON-VACUITY: on base the out-of-fence change REACHES the branch (${before} -> ${after} commits) — the hole #1852 closes`,
    );
    rmSync(f.repoRoot, { recursive: true, force: true });
    rmSync(`${f.repoRoot}-origin`, { recursive: true, force: true });
    console.log(`\nexit ${exit}`);
    process.exit(exit);
  }
  assert(
    caps.includes("lens-fix-scope"),
    `the round parked on the lens-fix scope cap (caps seen: ${JSON.stringify(caps)})`,
  );
  assert(
    out.eventLog.some(
      (e) => e.kind === "cap-hit" && e.cap === "lens-fix-scope" && e.lensWorktreePath === f.tree,
    ),
    "the park names the tree the operator has to open",
  );
  assert(
    !out.eventLog.some((e) => e.kind === "lens-fix-committed"),
    "the landing arm did not commit the out-of-fence change",
  );
  assert(
    before === after,
    `the branch still has ${before} commits — the widening was not integrated`,
  );
  assert(
    !pushes.some((p) => p.includes("push")),
    `no push was attempted (attempts: ${JSON.stringify(pushes)})`,
  );
  const cap = out.eventLog.find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-scope") as
    | { evidence?: string }
    | undefined;
  assert(
    (cap?.evidence ?? "").includes("b.txt"),
    "the park reason names the file the fixer had no business touching",
  );
  rmSync(f.repoRoot, { recursive: true, force: true });
  rmSync(`${f.repoRoot}-origin`, { recursive: true, force: true });
}

console.log("# a round that RECORDS a fence failure does not land");
{
  // Fail closed. The round's own step said it could not build the fence, so the
  // record is on the log and the gate refuses rather than letting a landing arm
  // push work nothing checked.
  const f = fixture("land-lost-fence");
  const st = await stateWith(f.repoRoot, f.tree, f.branch, false, true);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const ctx = stubCtx(f.repoRoot, []);
  const out = await runAdversarial(ctx, st, 2_000_000);
  const after = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  assert(
    caps.includes("lens-fix-scope"),
    `a round with a recorded fence failure parks (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    before === after,
    `and nothing was integrated (${before} -> ${after}) — the gate is what stopped it, not the tree`,
  );
  rmSync(f.repoRoot, { recursive: true, force: true });
  rmSync(`${f.repoRoot}-origin`, { recursive: true, force: true });
}

console.log("# a state with NO fence record is not judged by the gate");
{
  // The other half of the rule, and the one that keeps #1852 from being a
  // schema break: an older driver wrote this state, so there is no fence and no
  // fence failure. The gate does not run and the landing arms behave as before.
  const f = fixture("land-no-record");
  const st = await stateWith(f.repoRoot, f.tree, f.branch, false, false);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const ctx = stubCtx(f.repoRoot, []);
  const out = await runAdversarial(ctx, st, 2_000_000);
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  assert(
    !caps.includes("lens-fix-scope"),
    `no record, no gate: the round is not parked by a fence it never had (caps: ${JSON.stringify(caps)})`,
  );
  void before;
  rmSync(f.repoRoot, { recursive: true, force: true });
  rmSync(`${f.repoRoot}-origin`, { recursive: true, force: true });
}

console.log("# an in-fence lens fix still reaches the branch");
{
  // The SAME fixture shape, minus the out-of-fence commit — built rather than
  // undone, because `reset --hard` would strand that commit outside every ref
  // and `integrate()` reads the round's work through a ref range.
  const f = fixtureInFence("land-allowed");
  const st = await stateWith(f.repoRoot, f.tree, f.branch);
  const before = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const ctx = {
    host: { sendUserMessage: () => {}, emit: () => {} } as never,
    repoRoot: f.repoRoot,
    issue: 1852,
    verifyExecFn: defaultExec,
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
        // `error` field alone, and an absent field there is "no error". `ok`
        // and `stopReason` are not consulted for that verdict, so an incomplete
        // stub reads as a severed provider stream and the step never reaches
        // the landing arm this test exists to drive.
        stopReason: "endTurn",
        killCause: undefined,
        // The reportOnly driver path never re-parses prose: `interpretReview`
        // reads the structured verdict the loop recorded, and a reply without
        // it is "no verdict" -> infra, which never reaches the landing arm.
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
  const out = await runAdversarial(ctx, st, 2_000_000);
  const caps = out.eventLog
    .filter((e) => e.kind === "cap-hit")
    .map((e) => (e as { cap: string }).cap);
  const after = git(f.repoRoot, `rev-list --count ${f.branch}`).trim();
  const why = out.eventLog.find(
    (e) => e.kind === "cap-hit" && e.cap === "lens-fix-not-integrated",
  ) as { evidence?: string } | undefined;
  void why;
  assert(
    !caps.includes("lens-fix-scope"),
    `an in-fence round is not parked by the fence (caps: ${JSON.stringify(caps)})`,
  );
  assert(
    Number(after) > Number(before),
    `the fix landed: the branch moved from ${before} to ${after} commits — the gate does not block what it should admit`,
  );
  rmSync(f.repoRoot, { recursive: true, force: true });
  rmSync(`${f.repoRoot}-origin`, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
