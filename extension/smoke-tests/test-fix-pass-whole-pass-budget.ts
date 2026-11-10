#!/usr/bin/env bun
/**
 * #2156 R5 — the whole-pass rewind's BUDGET: one rewind per pass, read from the
 * `fix-pass-strays-reverted` event the rewind stamps.
 *
 * Split from `test-fix-pass-strays-e2e.ts` for the AGENTS.md §12 size gate; the
 * seam is the question each file answers. That file asserts the REWIND (what the
 * tree looks like afterwards); this one asserts the COUNTER that decides whether
 * a rewind is allowed at all, which reads the event log rather than the tree.
 *
 * Four readings of ONE counter, each on a tree of its own (a rewind consumes its
 * tree's diff, so the four cannot share one fixture):
 *   - nothing on the log: the pass rewinds;
 *   - the rewind's own record on the log: the budget reads as spent, and the
 *     tree is NOT rewound a second time;
 *   - a `cap-hit` that merely CLAIMS a rewind, with no rewind event: unspent
 *     (this is the forge a prose-matching reader would have accepted);
 *   - a LENS round's record (`source: "lens-fix"`): it belongs to that round's
 *     budget and must not refuse a rewind this pass is entitled to.
 *
 * AGENTS.md §7 principle 1: a gate reads executed evidence, never a claim.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";
import {
  devCommit,
  fixState,
  git,
  passTreeAt,
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

console.log("# the whole-pass rewind is counted, so a re-run does not rewind twice (R5)");
{
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
    const spent: WorkState = {
      ...stateFor(base1),
      eventLog: [...stateFor(base1).eventLog, rewindEvent],
    };
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
    for (const t of [base0, base1, base2, base3])
      rmSync(t.repoRoot, { recursive: true, force: true });
  }
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
