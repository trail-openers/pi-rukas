#!/usr/bin/env bun
/**
 * #1852 — the lens-fix scope fence refuses a widening BEFORE anything pushes.
 *
 * The gate (`lensFixFenceCheck`) is what the lens-fix step never had: the fix
 * pass's fence ran between a pass's dispatch and its push, and the lens fix had
 * no equivalent, so every landing arm committed and pushed whatever the fixer
 * wrote anywhere in the tree. These are real-git tests: a fixture repo with a
 * real `.worktrees/` tree, a real round tip, and the driver's own
 * `postPassFault`/admission ladder underneath the gate.
 *
 * Each case asserts a refusal (or its absence) AND that the refusal says why,
 * because the park reason is the only thing the operator reads.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultExec, isAncestor } from "../src/work-driver-adversarial-fix-git.ts";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import type { PassPlan } from "../src/work-driver-adversarial-fix-scope.ts";
import {
  lensFixFenceCheck,
  lensFixPlanFromSnapshot,
  lensFixRevertAlreadyUsed,
} from "../src/work-driver-lens-fix-fence-gate.ts";
import { revertLensFixStrays } from "../src/work-driver-lens-fix-fence-revert.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { git } from "./lib/adversarial-fix-fixtures.ts";
import { FINDINGS, ctxFor, cycle, snapshotFor, stateFor } from "./lib/lens-fix-gate-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The record a real revert produces, spelled from the event type rather than `any`. */
type LensFixEventShape = Extract<WorkEvent, { kind: "fix-pass-strays-reverted" }>;

console.log("# a fix that stays inside the fence lands");
{
  const c = cycle("gate-ok");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,
  });
  assert(v.ok, `an in-fence round is approved (reason: ${v.ok ? "" : v.reason})`);
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a stray in a worktree: reverted once, then allowed");
{
  const c = cycle("gate-stray");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  writeFileSync(`${c.tree}/scratch-notes.md`, "the fixer should not have written this\n");
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,

    onRevertible: async () => {
      called++;
      // The test performs the revert the driver performs, then reports it.
      rmSync(`${c.tree}/scratch-notes.md`, { force: true });
      return {
        ok: true as const,
        event: {
          kind: "fix-pass-strays-reverted" as const,
          at: 1_500_000,
          workstreamId: "default",
          paths: ["scratch-notes.md"],
          preservedRef: "refs/pi-rukas/lens-fix-strays/1852/default-1",
          patchPath: "/tmp/1852-default-1.patch",
          source: "lens-fix" as const,
          round: 1,
        },
      };
    },
  });
  assert(called === 1, "the gate asked for exactly one revert");
  assert(
    v.ok,
    `a reverted first stray set does not park the round (reason: ${v.ok ? "" : v.reason})`,
  );
  assert(
    v.ok && v.revert?.source === "lens-fix" && v.revert.round === 1,
    "the revert record carries the lens-fix source and the round (the counter reads them)",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# the revert the DRIVER performed leaves an event the round can count");
{
  // #1852 review round 2. The stub above proves the gate REPORTS an event; this
  // one proves the event the real destructive path produces is COUNTABLE. A
  // hand-typed event can carry fields the real revert never writes, and the real
  // revert can omit the two fields the counter reads — which is precisely how
  // `lensFixRevertAlreadyUsed` came to be blind to a revert the driver had done,
  // letting a retried adversarial step revert a SECOND set in the same round.
  // The assertion is made through the counter itself, not by reading fields off
  // the returned object, so it fails if either of the two fields is missing.
  const c = cycle("gate-real-revert");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  // Untracked: the hardest case for the record, because no ref can ever hold it
  // — only the patch and the copies do, so their paths have to be on the event.
  writeFileSync(`${c.tree}/scratch-notes.md`, "the fixer should not have written this\n");
  const realCtx = {
    ...ctxFor(c.repoRoot),
  } as unknown as CycleContext;
  let event: LensFixEventShape | undefined;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: realCtx,
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,

    onRevertible: async (post, plan) => {
      const out = await revertLensFixStrays(realCtx, st, defaultExec, plan, post, 1, false);
      if (out?.ok === true) event = out.event;
      return out;
    },
  });
  assert(v.ok, `the driver's own revert clears the round (${v.ok ? "" : v.reason.slice(0, 120)})`);
  assert(
    existsSync(`${c.tree}/scratch-notes.md`) === false,
    "the stray really is gone from the worktree, so the record describes a real deletion",
  );
  assert(event !== undefined, "the real revert produced an event");
  assert(
    event?.source === "lens-fix" && event.round === 1,
    `it carries the lens-fix source and the round (${JSON.stringify([event?.source, event?.round])})`,
  );
  assert(
    (event?.paths ?? []).includes("scratch-notes.md"),
    `it names the reverted path (${JSON.stringify(event?.paths)})`,
  );
  assert(
    (event?.preservedRef ?? "").includes("1852") && (event?.patchPath ?? "").length > 0,
    `it names where the content survives (${event?.preservedRef} / ${event?.patchPath})`,
  );
  // THE counter is the consumer that was blind. Feed it the log a recorded round
  // would have: with the event appended, the round has spent its allowance.
  const withEvent = [...st.eventLog, event as never];
  assert(
    lensFixRevertAlreadyUsed(withEvent, 1, "default"),
    "lensFixRevertAlreadyUsed COUNTS the driver's revert — this is what a retried step reads",
  );
  assert(
    !lensFixRevertAlreadyUsed(st.eventLog, 1, "default"),
    "and it counted nothing before the revert happened (the allowance really is spent by this event alone)",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
  rmSync(`${c.repoRoot}/tmp`, { recursive: true, force: true });
}

console.log("# a SECOND stray set in the same round parks");
{
  const c = cycle("gate-second");
  // The allowance is spent by a RECORD, not by a caller's flag: the round's own
  // `fix-pass-strays-reverted` (source lens-fix, this round, this workstream) is
  // what makes a second set park, which is also what makes a retried step see it.
  const st = {
    ...stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]),
    eventLog: [
      ...stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]).eventLog,
      {
        kind: "fix-pass-strays-reverted" as const,
        at: 1_300_000,
        workstreamId: "default",
        source: "lens-fix" as const,
        round: 1,
        paths: ["earlier-stray.md"],
        preservedRef: "refs/pi-rukas/fix-pass-strays/1852-default-1",
        patchPath: "/tmp/1852-default-1.patch",
      },
    ],
  };
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  writeFileSync(`${c.tree}/scratch-notes.md`, "again\n");
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,

    onRevertible: async () => {
      called++;
      return {
        ok: true as const,
        event: {
          kind: "fix-pass-strays-reverted" as const,
          at: 1,
          workstreamId: "default",
          paths: [],
          preservedRef: "r",
          patchPath: "p",
        },
      };
    },
  });
  assert(
    !v.ok && v.reason.includes("SECOND"),
    `a second set parks with the reason that says so (${v.ok ? "APPROVED" : v.reason.slice(0, 90)})`,
  );
  assert(called === 0, "the gate does not revert a second time");
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# an outOfScope change parks and is never reverted");
{
  const c = cycle("gate-fenced");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  // Tracked AND committed in the round, so it is in the delta rather than the
  // working tree: an outOfScope file the fixer modified and committed.
  writeFileSync(`${c.tree}/b.txt`, "touched past the fence\n");
  git(c.tree, "add -A");
  git(c.tree, 'commit -q -m "widening past the fence"');
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,

    onRevertible: async () => {
      called++;
      return undefined;
    },
  });
  assert(!v.ok, "the outOfScope change is refused");
  assert(
    v.ok === false && v.reason.includes("b.txt"),
    `the refusal names the fenced file (${v.ok ? "APPROVED" : v.reason.slice(0, 120)})`,
  );
  assert(
    called === 0,
    "an absolute refusal never reaches the revert — the fence wins over the driver's own convenience",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# the repo-root arm parks on ANY stray and says why");
{
  const c = cycle("gate-root");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  writeFileSync(`${c.tree}/scratch-notes.md`, "stray at the lens tree\n");
  let called = 0;
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    // The lens tree IS the tree the driver would revert into — here declared as
    // the repo root, which is the arm PM decision #1852-1 makes stricter.
    inWorktree: false,
    tree: c.tree,
    round: 1,

    onRevertible: async () => {
      called++;
      return undefined;
    },
  });
  assert(
    !v.ok && v.reason.includes("repo root"),
    `the repo-root stray parks naming the tree as the reason the revert was skipped (${v.ok ? "APPROVED" : v.reason.slice(0, 120)})`,
  );
  assert(called === 0, "no revert is attempted at the repo root (PM decision #1852-1)");
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# an EMPTY delta only passes when the recorded tip is in this tree's history");
{
  // #1852 round 2 item 3. `git diff <tip>..HEAD` against a tip that is not an
  // ancestor of HEAD reads as "nothing changed", so the empty-range pass used to
  // be reachable from a corrupt or stale `roundTip` — the fence would clear a
  // round it had never measured. The ancestor read is what turns the empty
  // answer into evidence.
  // A clean tree whose recorded tip IS an ancestor, and which changes only files
  // the fence admits: this is the fixture's own non-vacuity — it proves the
  // empty-delta arm is reachable at all and that an ancestor tip still earns the
  // pass. Without it, the case below could be passing because the gate always
  // refuses, not because of the ancestry read.
  const c = cycle("gate-empty-tip");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  // A clean tree whose recorded tip IS an ancestor: the pass this arm still
  // grants, so the case below is about the tip and not about the tree.
  const clean = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: snap,
    inWorktree: true,
    tree: c.tree,
    round: 1,
  });
  assert(
    clean.ok,
    `a clean tree whose tip is an ancestor passes (${clean.ok ? "" : clean.reason})`,
  );

  // A tip this tree's HEAD does not descend from, with a tree git cannot tell
  // apart from HEAD's. The field shape is a `roundTip` left behind by a force-push
  // or a history rewrite: a real commit, in this object store, that the tree no
  // longer descends from. The gate must not read the empty diff it produces as
  // "the fixer changed nothing" — `git diff <tip> <head>` prints nothing there,
  // and before #1852 round 2 that silence was evidence enough to land the round.
  //
  // The tip is built here as `commit-tree` over the tree HEAD ITSELF points at:
  // same tree object, no parent, so it is byte-identical in content and unrelated
  // in history. Every other shape was measured and rejected — an empty-tree commit
  // makes each diff list HEAD's files (the fence then refuses on an unrelated
  // arm), an unresolvable SHA makes `git diff` fatal (the gate parks earlier, in
  // `committedChanges`), and a commit made in the lens tree or in the superproject
  // is content-different from HEAD, so its own file name lands in the diff.
  const roundHead = git(c.tree, "rev-parse HEAD").trim();
  const headTree = git(c.tree, "rev-parse HEAD^{tree}").trim();
  const orphanSha = git(c.tree, `commit-tree ${headTree} -m "orphan round tip"`).trim();

  // The fixture's claims, checked before the gate is asked to act on them — each
  // one is a way this case could pass for the wrong reason.
  assert(
    git(c.tree, "status --porcelain").trim() === "",
    "NON-VACUITY: the lens tree is clean, so nothing but the tip differs from the case above",
  );
  const trackedRange = git(c.tree, `diff --name-only --no-renames ${orphanSha} -- HEAD`).trim();
  assert(
    trackedRange === "",
    `NON-VACUITY: the tracked delta reads empty for that tip (git said ${JSON.stringify(trackedRange.slice(0, 40))})`,
  );
  const probe = await isAncestor(defaultExec, c.tree, orphanSha, roundHead);
  assert(
    probe === "no",
    `NON-VACUITY: git says that tip is not in HEAD's history (probe: ${probe})`,
  );

  const stale = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: { ...snap, roundTip: orphanSha },
    inWorktree: true,
    tree: c.tree,
    round: 1,
  });
  assert(
    !stale.ok,
    `an empty delta against a tip that is NOT an ancestor of HEAD does not pass (${stale.ok ? "APPROVED — the empty range was taken as evidence" : stale.reason.slice(0, 110)})`,
  );
  // The gate does not merely park — it must park IN THE ANCESTRY ARM. Any other
  // refusal (a stray file, an unreadable range) would pass this case for reasons
  // that have nothing to do with the read under review.
  assert(
    !stale.ok && stale.reason.includes("could not be confirmed as an ancestor"),
    `the refusal is the ancestry read, not an unrelated arm (${stale.ok ? "APPROVED" : stale.reason.slice(0, 90)})`,
  );
  assert(
    !stale.ok && stale.reason.includes(orphanSha),
    "the refusal names the tip it could not place",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a RECORDED fence failure parks; no record at all means the gate does not run");
{
  const c = cycle("gate-nosnap");
  // The record is what decides, so the two cases put it on the log (or leave it
  // off) rather than passing a boolean: #1852 round 2 MEDIUM moved both reads
  // inside the gate, which reads them from `state.eventLog` and `round`.
  const recorded = {
    ...stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]),
    eventLog: [
      ...stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]).eventLog,
      {
        kind: "lens-fix-fence-unavailable" as const,
        at: 1_400_000,
        round: 1,
        worktree: c.tree,
        reason: "git ls-tree failed: exit 128",
      },
    ],
  };
  const noSnap = {
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    snapshot: undefined,
    inWorktree: true,
    tree: c.tree,
    round: 1,
  };
  const v = await lensFixFenceCheck({ ...noSnap, state: recorded });
  assert(
    !v.ok,
    `a round that RECORDS a fence failure parks fail-closed — nothing pushes (${v.ok ? "APPROVED" : v.reason.slice(0, 90)})`,
  );
  const skipped = await lensFixFenceCheck({
    ...noSnap,
    state: stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]),
  });
  assert(
    skipped.ok,
    `a round with NO fence record at all is not judged — an older driver wrote this state (${skipped.ok ? "" : skipped.reason})`,
  );
  assert(
    skipped.ok && (skipped.notes[0] ?? "").includes("did not run"),
    "and the skip says so in its notes, where the trace says why",
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log("# a fence from another round cannot clear this one");
{
  const c = cycle("gate-stale-round");
  const st = stateFor(c.repoRoot, c.tree, ["a.txt"], ["b.txt"]);
  const snap = await snapshotFor(c.repoRoot, c.tree, c.roundTip, st);
  const v = await lensFixFenceCheck({
    execFn: defaultExec,
    ctx: ctxFor(c.repoRoot),
    state: st,
    snapshot: { ...snap, round: 4 },
    inWorktree: true,
    tree: c.tree,
    round: 1,
  });
  assert(
    !v.ok && v.reason.includes("round 4"),
    `the gate refuses a fence belonging to another round (${v.ok ? "APPROVED" : v.reason.slice(0, 90)})`,
  );
  rmSync(c.repoRoot, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
