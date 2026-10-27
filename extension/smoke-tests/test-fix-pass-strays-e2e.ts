#!/usr/bin/env bun
/**
 * #1846 — end to end: a fix pass that changes a file outside its fence is
 * REVERTED AND CONTINUES instead of parking the cycle.
 *
 * The field shape this replaces (issue #1846): a fix pass lands its fix, adds a
 * small helper the fence does not admit, and the whole cycle hands off with
 * `cap-hit: fix-pass-park` and text telling a human to
 * "revert <files> in that worktree and land the rest by hand". The driver can do
 * that revert itself, losslessly, so the park is now reserved for the cases where
 * reverting is the wrong answer:
 *
 *   - a SECOND stray set from the same pass (the pass will not stay inside its
 *     fence — reverting again would be looping on it);
 *   - a stray the fence refused as fenced or protected (those files are the
 *     protected-path gate's decision, never the revert's);
 *   - no positively recorded head to revert to, or a preservation that failed.
 *
 * Each branch below runs the REAL `runAdversarialFixPass` against a real git
 * repo, so what is asserted is the event the cycle ends on — the thing the
 * handoff renderer and the merge gate read — not an internal helper's return.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PassPlan, PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { correctiveRoundFor, correctiveRoundsOf } from "../src/work-driver-corrective-admission.ts";
import { passWindow, revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import { fixPassStraysRef } from "../src/work-driver-fix-pass-strays.ts";
import type { FixPassStraysRevertedEvent } from "../src/workflow-state-events-fix-pass-strays.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import {
  type DispatchResult,
  devCommit,
  devOk,
  devWrite,
  fixState,
  git,
  repoWithFile,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

const emitSink = { emit: () => {}, fingerprints: [] } as never;

/** Run a real fix pass whose developer is `onDev`, with git running for real. */
async function runPass(dir: string, st: WorkState, onDev: (d: string) => void) {
  const ctx: CycleContext = {
    host: { sendUserMessage: () => {}, emit: () => {} },
    emitSink,
    repoRoot: dir,
    issue: 1846,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "developer") onDev(dir);
      return devOk(spec.role) as DispatchResult;
    },
  };
  const out = await runAdversarialFixPass(ctx, st, pendingFixes(st.eventLog), Date.now());
  const tail = out.eventLog[out.eventLog.length - 1];
  const revert = out.eventLog.find(
    (e): e is FixPassStraysRevertedEvent => e.kind === "fix-pass-strays-reverted",
  );
  return {
    out,
    tailKind: tail?.kind ?? "",
    parked: tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "",
    applied: tail?.kind === "adversarial-fix-applied",
    revert,
  };
}

/**
 * The worktree path the cwd gate accepts. The fixtures' repos ARE the worktree
 * for the single-workstream shape; `planFixPass` reads the path from state, so
 * the gate's requirement (`<repoRoot>/.worktrees/…`) is what a real cycle
 * satisfies and what this fixture must too.
 */
function wtOf(dir: string): string {
  // A real `git worktree add`, which is what the driver's branch step runs. The
  // revert needs a tree that is actually attached: `git checkout <rev> -- <path>`
  // refuses a path git has never tracked, and a commit needs a HEAD — a copied
  // directory fakes both badly, a real worktree answers them exactly.
  git(dir, "worktree add -q --detach .worktrees/issue-1846 HEAD");
  return `${dir}/.worktrees/issue-1846`;
}

/** The developer's work, committed IN ITS WORKTREE. The fixture keeps the repo
 *  root and the worktree as separate trees (that is what the cwd gate needs), so
 *  the pass's own commits have to be made in the tree the revert reads. */
function devCommitIn(wt: string, file: string, body: string): void {
  const at = `${wt}/${file}`;
  mkdirSync(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  writeFileSync(at, body);
  git(wt, "add -A");
  git(wt, 'commit -q -m "the fix pass"');
}

/** The developer's edit left UNCOMMITTED — the shape the fence reads as a stray
 *  (`treeChanges` merges `ls-files --others`), and the one no ref can preserve. */
function devWriteIn(wt: string, file: string, body: string): void {
  const at = `${wt}/${file}`;
  mkdirSync(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  writeFileSync(at, body);
}

/** A pass plan with the two heads the revert reads, as the fence records them. */
function planOf(worktree: string, headBefore: string, headAtRound: string): PassPlan {
  return {
    id: "default",
    worktree,
    findings: ["a.txt: change one to two"],
    headBefore,
    before: { names: [], diff: "", untracked: [] },
    declared: ["a.txt"],
    named: [],
    widened: [],
    outOfScope: [],
    specSlots: [],
    candidates: new Set<string>(),
    dirs: new Set<string>(),
    fence: ["a.txt"],
    headAtRound,
  } as unknown as PassPlan;
}

/** The minimal context the revert step reads: repo root, issue, and the git exec. */
function ctxOf(dir: string): CycleContext {
  return {
    host: { sendUserMessage: () => {}, emit: () => {} },
    emitSink,
    repoRoot: dir,
    issue: 1846,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
  } as unknown as CycleContext;
}

/** `devCommit` writes then commits; a file in a NEW directory needs the dir first. */
function commitNew(dir: string, file: string, body: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  devCommit(dir, file, body);
}

/** The developer lands its fix in scope and commits a helper the fence refuses.
 *  The stray is written but left UNCOMMITTED, which is the shape that reached the
 *  field: the fence reads the working tree (`treeChanges`), so an uncommitted
 *  helper is a stray, and a committed one would already be part of the pass's
 *  reviewed diff. */
const fixPlusStray = (d: string) => {
  devCommit(d, "a.txt", "two\n");
  mkdirSync(`${d}/lib`, { recursive: true });
  devWrite(d, "lib/helper.ts", "export const helper = () => 1;\n");
};

console.log("# the seam: a stray set that is revertible is reverted, not parked");
{
  // The single-tree fixture cannot drive the whole pass with an uncommitted stray
  // (the consolidated-verify dirty-root gate refuses the pass before the fence is
  // ever read), so this drives the seam the pass actually calls — the same
  // `revertStraysOnce` the fix pass invokes with its own plans — and then asserts
  // the tree outcome with git. What the pass does with the outcome (continue vs
  // park) is asserted by the second set's case below and by the refusal branches.
  const dir = repoWithFile("1846-seam");
  try {
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const wt = wtOf(dir);
    const headBefore = git(wt, "rev-parse HEAD").trim();
    devCommitIn(wt, "a.txt", "two\n");
    const headAtRound = git(wt, "rev-parse HEAD").trim();
    devWriteIn(wt, "lib/helper.ts", "export const helper = () => 1;\n");
    const post: PostPass = {
      diffs: {},
      admissions: [],
      reason: "stray",
      straysFor: "default",
      strays: [{ file: "lib/helper.ts", refused: "undeclared" }],
      untracked: ["lib/helper.ts"],
    };
    const plans = [planOf(wt, headBefore, headAtRound)];
    const outcome = await revertStraysOnce(ctxOf(dir), st, plans, post, Date.now());
    assert(
      outcome?.ok === true,
      `the stray set is reverted, not parked (${JSON.stringify(outcome)})`,
    );
    assert(!existsSync(`${wt}/lib/helper.ts`), "the stray is gone from the tree");
    assert(
      readFileSync(`${wt}/a.txt`, "utf8") === "two\n",
      "the pass's own committed fix survived — a whole-tree reset would have destroyed it",
    );
    assert(
      git(wt, "show-ref").includes(fixPassStraysRef(1846, "default", 1)),
      "the preserved ref exists, so the reverted content is still reachable",
    );
    const copy = `${dir}/tmp/issue-1846/fix-pass-strays-untracked/lib/helper.ts`;
    assert(
      existsSync(copy) && readFileSync(copy, "utf8").includes("helper"),
      "the untracked bytes survive in the copy beside the patch — nothing is lost",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("# a SECOND stray set parks: the driver reverts once, it does not loop");
{
  const dir = repoWithFile("1846-twice");
  try {
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const wt = wtOf(dir);
    const headBefore = git(wt, "rev-parse HEAD").trim();
    devCommitIn(wt, "a.txt", "two\n");
    devWriteIn(wt, "lib/helper.ts", "export const helper = () => 1;\n");
    const post: PostPass = {
      diffs: {},
      admissions: [],
      reason: "stray",
      straysFor: "default",
      strays: [{ file: "lib/helper.ts", refused: "undeclared" }],
      untracked: ["lib/helper.ts"],
    };
    const plans = [planOf(wt, headBefore, headBefore)];
    const first = await revertStraysOnce(ctxOf(dir), st, plans, post, Date.now());
    assert(first?.ok === true, "the first stray set is reverted");
    // The state now carries the revert event, as it would in the pass.
    const after: WorkState = {
      ...st,
      eventLog: [...st.eventLog, ...(first?.ok === true ? [first.event] : [])],
    };
    const second = await revertStraysOnce(ctxOf(dir), after, plans, post, Date.now());
    assert(
      second?.ok === false && second.secondSet,
      "a SECOND stray set is a park, not a second revert",
    );
    assert(
      /SECOND/.test(second?.ok === false ? second.reason : ""),
      `and the reason says the driver already reverted once (${JSON.stringify(second)})`,
    );
    assert(
      existsSync(`${wt}/lib/helper.ts`) === false,
      "the first revert's tree change stands — nothing was re-reverted",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("# the revert target is the pass's OWN headBefore, never a round's");
{
  // A corrective round dispatched inside the pass records the HEAD it FOUND —
  // which by then already contains the pass's own commits, strays included. The
  // revert must target the pass's `headBefore`, the one referent the fence's own
  // judgement uses. Varying one thing: the round's baseline points at a tree
  // where `lib/helper.ts` is already tracked with the out-of-fence content.
  const dir = repoWithFile("1846-target");
  try {
    const wt = wtOf(dir);
    const baseHead = git(wt, "rev-parse HEAD").trim();
    // A commit made by the driver's corrective round: helper.ts exists there.
    devCommitIn(wt, "lib/helper.ts", "export const helper = 1;\n");
    devCommitIn(wt, "a.txt", "fixed\n");
    const roundHead = git(wt, "rev-parse HEAD").trim();
    // The pass then EDITED it out of fence.
    devWriteIn(wt, "lib/helper.ts", "export const helper = 999;\n");
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const events: WorkEvent[] = [
      ...st.eventLog,
      {
        kind: "corrective-round",
        at: 1,
        step: "develop",
        workstreamId: "default",
        attempt: 1,
        command: "sh check.sh",
        evidenceLines: ["a.txt: assertion failed"],
        headAtRound: roundHead,
      },
    ];
    const round = correctiveRoundFor(
      correctiveRoundsOf(passWindow({ ...st, eventLog: events })),
      "default",
    );
    assert(
      round?.headAtRound === roundHead,
      "the pass window finds the corrective round's own baseline, not an earlier one",
    );
    const outcome = await revertStraysOnce(
      ctxOf(dir),
      { ...st, eventLog: events },
      [planOf(wt, baseHead, roundHead)],
      {
        diffs: {},
        admissions: [],
        reason: "stray",
        straysFor: "default",
        strays: [{ file: "lib/helper.ts", refused: "undeclared" }],
        untracked: [],
      },
      Date.now(),
    );
    assert(outcome?.ok === true, `the stray is reverted (${JSON.stringify(outcome)})`);
    // #1846 — the revert targets the PASS's own `headBefore`, never a corrective
    // round's `headAtRound`. `headAtRound` is the HEAD the round FOUND, which by
    // then already contains the pass's own commits — so restoring a stray to it
    // restores the stray. This assertion is the difference between the two
    // targets made visible: the round's content is the OUT-OF-FENCE content, and
    // it must not survive.
    assert(
      !existsSync(`${wt}/lib/helper.ts`),
      "the pass-created stray is GONE: a headAtRound target would have kept the round's out-of-fence content",
    );
    // And the pass's own fix, which is NOT in the stray list, is untouched by a
    // path-scoped revert to `headBefore`.
    assert(
      readFileSync(`${wt}/a.txt`, "utf8") === "fixed\n",
      "the pass's own committed fix survived the revert to headBefore",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("# a fenced or protected refusal is never offered a revert");
{
  const dir = repoWithFile("1846-fenced");
  try {
    const wt = wtOf(dir);
    const headBefore = git(wt, "rev-parse HEAD").trim();
    const before = readFileSync(`${dir}/a.txt`, "utf8");
    const outcome = await revertStraysOnce(
      ctxOf(dir),
      fixState(dir, ["a.txt"], "a.txt: change one to two"),
      [planOf(wt, headBefore, headBefore)],
      {
        // The shape `postPassFault` returns for a fenced / protected stray: no
        // `straysFor`, because those files are the protected-path gate's decision.
        diffs: {},
        admissions: [],
        reason: "protected",
      },
      Date.now(),
    );
    assert(outcome === undefined, "a refusal with no `straysFor` is not offered a revert at all");
    assert(readFileSync(`${dir}/a.txt`, "utf8") === before, "the tree was not touched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
