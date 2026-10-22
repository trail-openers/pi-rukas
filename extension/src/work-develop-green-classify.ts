/**
 * work-develop-green-classify — the green half of the develop pass
 * classification (#1768), split from `work-develop-crash.ts` so that module
 * keeps the size AGENTS.md §12 asks for and the two halves stay legible.
 *
 * The rule this half owns: a child that exited 0 and reported itself done is
 * NOT believed. The worktree is read here, BEFORE any #622 safety net sees it,
 * because the net commits leftover dirt when the pass has 0 commits ahead, and
 * that driver-made commit then satisfied the green rule — the incident orchard
 * cycle-id recorded as `safety net committed default (d81ce007) — 6
 * file(s)` one second after the child's own `… test/review_test.sh remain, then
 * the gate. Continuing.`, and `agent done: developer` one second after that.
 *
 * The failure half (#1403, still in `work-develop-crash.ts`) already read the
 * tree for a dead child; this is its mirror for a live one. Between them a pass
 * is read by the tree exactly once either way, and neither half asks the child
 * what it did.
 */

import type { ClassifyArgs, CrashVerdict } from "./work-develop-crash.ts";
import { readTreeBounded } from "./work-develop-git-tree.ts";
import {
  type GreenPassFields,
  decideGreenFromTree,
  ownCommitsAheadOfBase,
} from "./work-develop-unfinished.ts";

/**
 * The two facts the child's claim cannot supply, read together and
 * independently: its own commits ahead of base, and its own dirt. `Promise.all`
 * so a slow tree costs one window, and each read degrades to `unreadable`
 * rather than throwing — a hung git is a blocked pass, never a green one and
 * never a stalled step.
 *
 * The status read is never injectable: an unreadable tree stays unreadable
 * whatever a fake says about the commits. `ownCommits` is the test seam that
 * drives the three-state answer without a repository.
 */
export async function readGreenPassFields(
  execFn: ClassifyArgs["execFn"],
  cwd: string,
  base: string | undefined,
  ownCommits?: ClassifyArgs["ownCommits"],
  driverShas?: readonly string[],
): Promise<GreenPassFields> {
  const ownFn = ownCommits ?? ((c, b) => ownCommitsAheadOfBase(execFn, c, b, driverShas));
  const [own, status] = await Promise.all([ownFn(cwd, base), readTreeBounded(execFn, cwd)]);
  if ("unreadable" in status) {
    return { own, uncommitted: [], reading: decideGreenFromTree(own, undefined) };
  }
  const paths = status.entries.map((e) => e.path);
  return { own, uncommitted: paths, reading: decideGreenFromTree(own, paths) };
}

/**
 * The verdict for a pass whose child reported ok. Three outcomes, and the
 * distinction between the last two is the whole issue:
 *
 *  - its own commits ahead of base → green, unchanged from before #1768
 *    (including the net's existing "left out of the PR" note for leftovers).
 *  - no own commits AND dirt in the tree → `unfinished`: the child quit
 *    mid-step, the step is not done, and the reading rides out to the event
 *    record, the cap evidence and the corrective prompt.
 *  - no own commits and a CLEAN tree → the pre-existing GREEN_DOWNGRADE shape,
 *    owned by `work-develop-greens.ts`. This module deliberately does not
 *    claim that case: there is no unfinished work to resume, so the park below
 *    must not name it.
 *
 * An unreadable tree is `done: false` and never a count of zero — the driver
 * cannot certify a pass it cannot read, and a green that rests on an unreadable
 * worktree is the same class of confident-wrong record #1403 removed.
 */
export async function classifyGreenPass(args: ClassifyArgs): Promise<CrashVerdict> {
  const { cwd, base, execFn, result } = args;
  const reading = await readGreenPassFields(execFn, cwd, base, args.ownCommits, args.driverShas);
  if (reading.reading.done) {
    return {
      ok: true,
      crashed: false,
      uncommitted: reading.uncommitted,
      lostWork: false,
      exitCode: result.exitCode,
      ownCommits: reading.own,
    };
  }
  if (reading.reading.evidence === "none") {
    // 0 own commits and a clean tree is not this issue's finding — the existing
    // GREEN_DOWNGRADE owns it, and its reason string is unchanged. Nothing is
    // recorded here beyond the count the caller already needs.
    return {
      ok: true,
      crashed: false,
      uncommitted: [],
      lostWork: false,
      exitCode: result.exitCode,
      ownCommits: reading.own,
    };
  }
  return {
    ok: false,
    crashed: false,
    unfinished: true,
    unfinishedReading: reading.reading,
    evidence: undefined,
    uncommitted: reading.uncommitted,
    lostWork: false,
    reason: reading.reading.reason,
    exitCode: result.exitCode,
    ownCommits: reading.own,
  };
}
