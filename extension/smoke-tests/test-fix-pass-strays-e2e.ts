#!/usr/bin/env bun
/**
 * #2156 — the fix-pass stray revert is ALL-OR-NOTHING: a pass that has to give
 * anything up gives up ALL of it, and the round fails.
 *
 * The field shape the issue reports (a downstream repository, v0.14.71-era
 * driver): the adversarial fix pass edited two files. One was a file the SAME
 * cycle's develop step had created; the other was an existing file. The fence
 * reverted the created file as an "out-of-fence file" — preserved under a
 * `refs/pi-rukas/fix-pass-strays/<issue>-...` ref — and KEPT the paired edit in
 * the other file. The kept file imported a function the reverted file no longer
 * defined; the next adversarial round flagged both as CRITICAL and the cycle
 * handed off. Two defects, and this file pins the second one at the seam the
 * driver actually runs:
 *
 *   - the revert is no longer path-scoped to the strays. `postPassFault` hands
 *     the whole pass delta as the rewind set, and `revertStraysOnce` rewinds
 *     every file of it to `plan.headBefore`, so no half-applied tree can reach
 *     the next reviewer;
 *   - the rewind records itself and is counted, so a re-run of the same pass
 *     does not rewind twice (the budget R5).
 *
 * Both cases drive the REAL `revertStraysOnce` in a real `.worktrees/` tree with
 * the state's recorded worktree pointing at it (#1849 item 7's gate), and read
 * the result back from git rather than from the returned object.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import {
  devCommit,
  devWrite,
  fixCtx,
  fixState,
  git,
  passTreeAt,
  repoWithFile,
  silentSink,
  typedCycleCtx,
  typedPassPlans,
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
process.env.PI_ENSEMBLE_SAFETY_NET_COMMIT = "0";
// The develop dispatch's bound, stated rather than left to the 90-minute default:
// a fix pass is a review-loop dispatch, and a bound read against the wrong clock
// turns a stub that returns in milliseconds into a killed child whose
// `dispatch-failed` parks the pass on a failed develop gate — three assertions
// away from the fence under test. The stub IS fast; the bound should never fire,
// and stating it makes this case fail loudly if it ever does.
process.env.PI_ENSEMBLE_DEVELOP_BOUND_MS = "600000";

/** The developer's work, committed IN ITS WORKTREE. */
function devCommitIn(wt: string, file: string, body: string): void {
  const at = `${wt}/${file}`;
  mkdirSync(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  writeFileSync(at, body);
  git(wt, "add -A");
  git(wt, 'commit -q -m "the fix pass"');
}

function devWriteIn(wt: string, file: string, body: string): void {
  const at = `${wt}/${file}`;
  mkdirSync(at.slice(0, at.lastIndexOf("/")), { recursive: true });
  writeFileSync(at, body);
}

/** A whole-pass refusal as `postPassFault` reports it (#2156 shape). */
function wholePassPost(strays: string[], untracked: string[], paths: string[]): PostPass {
  return {
    diffs: {},
    admissions: [],
    reason: "strays",
    straysFor: "default",
    strays: strays.map((file) => ({ file, refused: "no-slot" as const, revertible: true })),
    paths,
    untracked,
    wholePass: true,
  };
}

console.log("# the rewind takes the WHOLE pass back — no paired edit is kept behind");
{
  // The issue's shape, at the seam: the pass committed its fix in `a.txt`,
  // created an out-of-fence helper in a directory the fence never admitted, and
  // edited `b.txt` out of fence too. Reverting only the strays would leave the
  // fix in `a.txt` importing what the removed helper defined.
  const t = passTreeAt("2156-all-or-nothing");
  try {
    const st = {
      ...fixState(t.repoRoot, ["a.txt"], "a.txt: change one to two"),
      pipelineState: { ...fixState(t.repoRoot, ["a.txt"]).pipelineState, worktrees: { default: t.worktree } },
    };
    // The tip the pass starts at, captured BEFORE the pass's own commits.
    const headBeforeAt = git(t.worktree, "rev-parse HEAD").trim();
    const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
    const outcome = await revertStraysOnce(
      typedCycleCtx(t.repoRoot, 2156),
      st,
      plans,
      wholePassPost(
        ["helper.ts", "b.txt", "scratch-notes.md"],
        ["scratch-notes.md"],
        ["a.txt", "helper.ts", "b.txt", "scratch-notes.md"],
      ),
      Date.now(),
    );
    assert(
      outcome?.ok === true,
      `the whole pass is rewound, not parked (${JSON.stringify(outcome)})`,
    );
    assert(
      readFileSync(`${t.worktree}/a.txt`, "utf8") === "one\n",
      "the pass's own fix is GONE too — keeping it alongside the removed helper is the half-applied tree the issue reports",
    );
    assert(
      !existsSync(`${t.worktree}/helper.ts`),
      "the created stray is gone",
    );
    assert(
      readFileSync(`${t.worktree}/b.txt`, "utf8") === "one\n",
      "the edited tracked file is back at its pre-pass content",
    );
    assert(
      !existsSync(`${t.worktree}/scratch-notes.md`),
      "the untracked stray is gone",
    );
    // The branch still STANDS: the rewind is a commit on top of the pass's own
    // tip, not a reset. A tautology (`rev-parse HEAD` compared with itself) proved
    // nothing, so the load-bearing readings are asserted instead: the pre-pass head
    // is still an ANCESTOR of HEAD, and HEAD has GROWN past it — a `reset --hard`.
    // to `headBefore` would drop the rewind commit and fail both.
    assert(
      git(t.worktree, `merge-base --is-ancestor ${headBeforeAt} HEAD`) === "" &&
        git(t.worktree, "rev-list --count HEAD").trim() >
          git(t.worktree, `rev-list --count ${headBeforeAt}`).trim(),
      "the branch still stands and has GROWN past the pre-pass head (the rewind is a commit, not a reset of the cycle's history)",
    );
    assert(
      git(t.worktree, "show-ref").includes("refs/pi-rukas/fix-pass-strays/"),
      "the whole pass is preserved under a ref, so nothing the fixer wrote is unrecoverable",
    );
    // Two records, because a revert preserves in two forms and each covers what
    // the other cannot (the module header of `work-driver-fix-pass-strays.ts`
    // is the rule): the patch is `headBefore` vs the WORKING TREE, so it holds
    // the uncommitted strays; the ref points at the pass's final HEAD, so it
    // holds what the pass COMMITTED. The kept half was committed, so the ref is
    // the record that can hold it — and the whole-pass rewind is only worth
    // having if that record really carries the fix as well as the strays.
    const patch = outcome?.ok === true ? outcome.event.patchPath : "";
    assert(
      existsSync(patch) && readFileSync(patch, "utf8").includes("b.txt"),
      `the patch holds the strays the revert deleted (${patch})`,
    );
    const ref = git(t.worktree, "rev-parse refs/pi-rukas/fix-pass-strays/2156-default-1").trim();
    assert(
      git(t.worktree, `show ${ref}:a.txt`).trim() === "two" &&
        git(t.worktree, `show ${ref}:helper.ts`).trim().includes("export const helper"),
      "the preserved ref holds the KEPT half as well as the strays — the whole pass is recoverable, nothing is kept and nothing is lost",
    );
  } finally {
    rmSync(t.repoRoot, { recursive: true, force: true });
  }
}

console.log("# a pass whose pass delta is empty has nothing to rewind and is refused");
{
  // `preserve` refuses when nothing differs from the pre-pass HEAD and a present
  // stray has no untracked copy: the whole-pass path inherits that refusal, and
  // the caller parks rather than reporting a rewind it did not perform.
  const t = passTreeAt("2156-nothing-to-rewind");
  try {
    const st = {
      ...fixState(t.repoRoot, ["a.txt"], "a.txt: change one to two"),
      pipelineState: { ...fixState(t.repoRoot, ["a.txt"]).pipelineState, worktrees: { default: t.worktree } },
    };
    const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
    const outcome = await revertStraysOnce(
      typedCycleCtx(t.repoRoot, 2156),
      st,
      plans,
      // A stray list naming a file the tree does not hold: the state read refuses.
      wholePassPost(["does-not-exist.ts"], [], ["does-not-exist.ts"]),
      Date.now(),
    );
    assert(
      outcome?.ok === false,
      `the refusal is returned, not a rewind claimed (${JSON.stringify(outcome)})`,
    );
    assert(
      outcome?.ok === false && /none of them exists/.test(outcome.reason),
      `and it names the false claim rather than "succeeding" (${JSON.stringify(outcome)})`,
    );
  } finally {
    rmSync(t.repoRoot, { recursive: true, force: true });
  }
}

console.log("# the whole-pass rewind is counted, so a re-run does not rewind twice (R5)");
{
  // The budget is read from the `fix-pass-strays-reverted` EVENT the rewind
  // stamps — not from the park prose (AGENTS.md §7 principle 1: a gate reads
  // executed evidence, not a claim). Four readings of ONE counter, each on a
  // tree of its own (a rewind consumes its tree's diff, so the four cannot share
  // one fixture):
  //   - nothing on the log: the pass rewinds;
  //   - the rewind's own record on the log: the budget reads as spent, and the
  //     tree is NOT rewound a second time;
  //   - a `cap-hit` that merely CLAIMS a rewind, with no rewind event: unspent;
  //   - a LENS round's record (`source: "lens-fix"`): it belongs to that round's
  //     budget and must not refuse a rewind this pass is entitled to.
  const base0 = passTreeAt("2156-budget-fresh");
  const base1 = passTreeAt("2156-budget-spent");
  const base2 = passTreeAt("2156-budget-claimed");
  const base3 = passTreeAt("2156-budget-lens");
  try {
    const stateFor = (t: typeof base0): WorkState => {
      const base = fixState(t.repoRoot, ["a.txt"], "a.txt: change one to two");
      return {
        ...base,
        pipelineState: { ...base.pipelineState, worktrees: { default: t.worktree } },
      };
    };
    // A tree the pass actually changed, so the rewind has bytes to preserve — the
    // `preserve` step refuses an empty delta, and a refusal would be read here as
    // "the counter refused" rather than the counter itself.
    const prepare = (t: typeof base0): void => {
      devCommitIn(t.worktree, "a.txt", "two\n");
      devWriteIn(t.worktree, "helper.ts", "export const helper = () => 1;\n");
    };
    prepare(base0);
    prepare(base1);
    prepare(base2);
    prepare(base3);
    const post = wholePassPost(["helper.ts"], ["helper.ts"], ["a.txt", "helper.ts"]);
    const mkPlans = async (t: typeof base0) =>
      await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
    const rewindEvent: WorkEvent = {
      kind: "fix-pass-strays-reverted",
      at: 3,
      workstreamId: "default",
      paths: ["a.txt", "helper.ts"],
      preservedRef: "refs/pi-rukas/fix-pass-strays/2156-default-1",
      patchPath: "/tmp/does-not-matter.patch",
    };
    const first = await revertStraysOnce(
      typedCycleCtx(base0.repoRoot, 2156),
      stateFor(base0),
      await mkPlans(base0),
      post,
      1,
    );
    assert(
      first?.ok === true,
      `with no rewind record on the log the pass rewinds (${JSON.stringify(first)})`,
    );
    const spent: WorkState = { ...stateFor(base1), eventLog: [...stateFor(base1).eventLog, rewindEvent] };
    const second = await revertStraysOnce(
      typedCycleCtx(base1.repoRoot, 2156),
      spent,
      await mkPlans(base1),
      post,
      2,
    );
    assert(
      second?.ok === false && second.secondSet,
      `once the rewind's own record is on the log, the budget reads as spent (${JSON.stringify(second)})`,
    );
    assert(
      existsSync(`${base1.worktree}/helper.ts`) &&
        readFileSync(`${base1.worktree}/a.txt`, "utf8") === "two\n",
      "and the refused rewind touched nothing — the tree still holds the pass's work",
    );
    // A `cap-hit` that merely SAYS the driver rewound is not a rewind record: no
    // rewind happened here, so the budget must still be unspent. This is the
    // forge the prose-matching reader accepted.
    const s2 = stateFor(base2);
    const claimed: WorkState = {
      ...s2,
      eventLog: [
        ...s2.eventLog,
        {
          kind: "cap-hit",
          at: 4,
          cap: "fix-pass-park",
          reviewRound: 1,
          nextStep: "handoff",
          evidence:
            "fix pass: default changed helper.ts — outside its declared paths; the driver rewound this pass's whole delta — 2 file(s) back to the head the pass started at",
        },
      ],
    };
    const third = await revertStraysOnce(
      typedCycleCtx(base2.repoRoot, 2156),
      claimed,
      await mkPlans(base2),
      post,
      3,
    );
    assert(
      third?.ok === true,
      `a cap-hit that only CLAIMS a rewind does not spend the budget — the rewind runs (${JSON.stringify(third)})`,
    );
    const s3 = stateFor(base3);
    const withLens: WorkState = {
      ...s3,
      eventLog: [...s3.eventLog, { ...rewindEvent, source: "lens-fix" as const, round: 1 }],
    };
    const fourth = await revertStraysOnce(
      typedCycleCtx(base3.repoRoot, 2156),
      withLens,
      await mkPlans(base3),
      post,
      4,
    );
    assert(
      fourth?.ok === true,
      `a lens round's revert record does not charge this pass's budget (${JSON.stringify(fourth)})`,
    );
  } finally {
    for (const t of [base0, base1, base2, base3]) rmSync(t.repoRoot, { recursive: true, force: true });
  }
}

console.log("# the pass FAILS its round on a rewind and never keeps part of the fix");
{
  // End to end through the WHOLE step — the develop step's real gates, then the
  // fence, then the comment-retention reads that sit below the rewind's park. A
  // pass whose fix includes a file no route admits parks on the FENCE's own
  // refusal, and NEITHER half of its work survives — which is the property the
  // issue asks for. It also does not park on "nothing was fixed", because the no-op
  // check is skipped on the rewind path.
  //
  // One fixture adjustment, and it is the reason this case is worth having: the
  // comment-retention check is given a real `origin/main` to compare against. The
  // fixture repo has none, so the check CANNOT run, and a check that could not run
  // parks the pass on `comment retention could not be checked for …` — a park in the
  // SAME function as the one under test, three branches below it. Giving the check
  // a ref makes it run, clear (the post-rewind diff removes no comment), and fall
  // through, so the park this case asserts on is the fence's own — the only park
  // that can carry `whole delta` and name the stray.
  const dir = repoWithFile("2156-round-fails");
  git(dir, 'update-ref refs/remotes/origin/main HEAD');

  try {
    // The helper directory has to EXIST before the dispatch, exactly as it does
    // in a real cycle: the developer's own worktree writes are fenced to the tree
    // (`writeFence.root`), which does not exist yet when the dispatch starts.
    git(dir, "worktree add -q --detach .worktrees/issue-2156 HEAD");
    const wt = `${dir}/.worktrees/issue-2156`;
    mkdirSync(`${wt}/lib`, { recursive: true });
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const state: WorkState = {
      ...st,
      pipelineState: { ...st.pipelineState, worktrees: { default: wt } },
    };
    const ctx: CycleContext = {
      ...fixCtx(dir, () => undefined),
      emitSink: silentSink,
      repoRoot: dir,
      dispatchFn: async (_pi, spec) => {
        if (spec.role === "developer") {
          // The paired edit, committed in fence, and the out-of-fence helper it
          // needs left UNCOMMITTED — the shape that survives the develop step's
          // #622 safety net. A committed stray is instead committed by the net and
          // judged by the develop gate's undeclared-path rule as an ordinary
          // "warning, not blocking", so the pass reaches its fence with nothing
          // left to refuse: the two forms reach different code, and this case
          // needs the fence's.
          devCommitIn(wt, "a.txt", "two\nimport { helper } from './lib/helper.ts';\n");
          devWriteIn(wt, "lib/helper.ts", "export const helper = () => 1;\n");
        }
        return {
          role: spec.role,
          ok: true,
          exitCode: 0,
          text: "done",
          toolUses: [],
          ms: 1,
        } as never;
      },
    };
    const out = await runAdversarialFixPass(ctx, state, pendingFixes(state.eventLog), Date.now());
    const tail = out.eventLog[out.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "fix-pass-park",
      `the round fails at the fix-pass park (tail: ${JSON.stringify(tail)?.slice(0, 120)})`,
    );
    assert(
      !out.eventLog.some((e) => e.kind === "adversarial-fix-applied"),
      "the pass is not recorded as applied",
    );
    assert(
      out.eventLog.some((e) => e.kind === "fix-pass-strays-reverted"),
      "the rewind is recorded on the log whatever the pass parked on — a driver commit that deleted files must never be unexplained",
    );
    const reason = out.pipelineState.verifyEvidence?.failures.join(" ") ?? "";
    assert(
      /lib\/helper\.ts/.test(reason) && /rewound this pass's whole delta/.test(reason),
      `the park names the stray AND says the whole pass went back (${reason.slice(0, 200)})`,
    );
    assert(
      !/nothing was fixed|byte-identical/.test(reason),
      "the rewind is not re-judged by the no-op check — the pass is not blamed for its own rewind",
    );
    const reverted = out.eventLog.find((e) => e.kind === "fix-pass-strays-reverted");
    assert(
      reverted?.kind === "fix-pass-strays-reverted" &&
        reverted.paths.includes("a.txt") &&
        reverted.paths.includes("lib/helper.ts"),
      `the rewind names the WHOLE pass delta, the kept edit included (${JSON.stringify((reverted as { paths?: string[] })?.paths)})`,
    );
    assert(
      !existsSync(`${wt}/lib/helper.ts`),
      "the out-of-fence helper is gone from the tree",
    );
    assert(
      readFileSync(`${wt}/a.txt`, "utf8") === "one\n",
      "the KEPT half went back with it — the tree is whole again, not half a fix",
    );
    // The record must be REACHABLE, in the two senses that matter: the event
    // names a ref that really exists and a patch file that really exists, AND a
    // note carrying that ref rides the state to the handoff / PR body (a revert
    // whose ref the operator cannot find is a driver commit that quietly deleted
    // their fixer's work). The old `||` hid behind an identity transform that
    // asserted a ref-shaped string is not a file on disk.
    assert(
      reverted?.kind === "fix-pass-strays-reverted" &&
        existsSync(reverted.patchPath) &&
        git(wt, "show-ref").includes(reverted.preservedRef),
      `the event names a patch that exists and a ref that exists (${JSON.stringify((reverted as { patchPath?: string; preservedRef?: string }) ?? {}).slice(0, 160)})`,
    );
    // A disclosure note carrying the ref rides `plumbReports` — `noteFixPass` is
    // the only note channel the fix pass has — so an operator reading the handoff
    // or the PR body can find where the rewound bytes live. A revert whose ref the
    // operator cannot find is a driver commit that quietly deleted their fixer's
    // work. The old `||` hid behind an identity transform that asserted a
    // ref-shaped string is not a file on disk.
    assert(
      out.pipelineState.plumbReports.some(
        (r) =>
          r.body.includes("refs/pi-rukas/fix-pass-strays/") &&
          r.body.includes(reverted?.preservedRef ?? "\u0000"),
      ),
      "a disclosure note on the state carries THIS rewind's ref to the handoff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
