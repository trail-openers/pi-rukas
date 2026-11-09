#!/usr/bin/env bun
/**
 * The TOCTOU half of the merge-time protected-path read: the head the gate diffs
 * must be the head the caller PINNED, not whatever `<remote>/<branch>` happens to
 * point at when the gate looks.
 *
 * The bug this file exists for: the read re-resolved `<remote>/<branch>` even
 * when the caller handed it an OID, so between the reviewer's approval and the
 * merge a pushed commit could be judged as if it were the reviewed one — or, the
 * direction that actually merges unreviewed code, a clean pinned head could be
 * reported clean while the gate had looked at a different commit entirely. Every
 * arm here drives the fixture in ./lib/merge-protected-paths-fixture.ts, whose
 * ref MOVES after the pin: an implementation that re-resolves cannot pass these
 * assertions, because the late commit's diff, merge base, and path list are all
 * distinguishable from the pinned commit's.
 */

import { mergeProtectedPathsForBranch } from "../src/merge-protected-paths.ts";
import { HEAD_SHA, LATE_SHA, MAIN_SHA, movingRefFixture } from "./lib/merge-protected-paths-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The branch form; `headOid` is the caller's pinned head (omitted = unpinned). */
function read(headOid?: string) {
  const fx = movingRefFixture({ clean: true });
  return { r: mergeProtectedPathsForBranch(fx.exec, "/repo", "feature/x", headOid), fx };
}

{
  // The pinned-head case, and the only arm that can see it: the caller (the
  // merged step's head check) pins HEAD_SHA, the ref then MOVES and answers
  // LATE_SHA, and the gate must still diff the pinned commit — the one the
  // merge lands. The scripted `<remote>/<branch>` gives up its moved value on
  // any re-read, so a regression that re-resolves shows the wrong range.
  const { exec, calls } = movingRefFixture({ clean: false });
  const r = await mergeProtectedPathsForBranch(exec, "/repo", "feature/x", HEAD_SHA);
  const range = calls.find((c) => c.argv[0] === "-c")?.argv.slice(-1)[0] ?? "";
  assert(
    r.ok === true && range.endsWith(`..${HEAD_SHA}`) && !range.includes(LATE_SHA),
    `the diff ends at the PINNED head OID even though <remote>/<branch> moved to ${LATE_SHA.slice(0, 8)} (got ${JSON.stringify(range)})`,
  );
  const mb = calls.find((c) => c.argv[0] === "merge-base");
  assert(
    mb?.argv.slice(-2).join(" ") === `${HEAD_SHA} ${MAIN_SHA}`,
    `the merge-base is taken between the pinned head and the resolved base, so a moved ref shifts neither end (got ${JSON.stringify(mb?.argv.slice(-2).join(" "))})`,
  );
}

{
  // The other direction, which is the one that merges unreviewed code: with the
  // pinned head CLEAN and the moved ref PROTECTED, a re-read would report a
  // protected path the PR does not contain — and on a real branch the moved
  // commit's changes would stand in for the reviewed ones.
  const { exec, calls } = movingRefFixture({ clean: true });
  const r = await mergeProtectedPathsForBranch(exec, "/repo", "feature/x", HEAD_SHA);
  const range = calls.find((c) => c.argv[0] === "-c")?.argv.slice(-1)[0] ?? "";
  assert(
    r.ok === true && r.paths.length === 0,
    `a clean pinned head is a pass even when the ref has moved to a commit with a protected file (range ${JSON.stringify(range)}, paths ${JSON.stringify(r.ok ? r.paths : r.unreadable)})`,
  );
  assert(
    calls.filter((c) => c.argv[0] === "rev-parse" && c.argv.includes("origin/feature/x")).length ===
      0,
    "with a pinned head the read issues no resolve of <remote>/<branch> at all — there is nothing left to re-resolve",
  );
}

{
  // And the control: with no pin from the caller, the ref IS resolved, once, and
  // that OID is what both the merge-base and the diff describe.
  const { exec, calls } = movingRefFixture({ clean: true });
  const r = await mergeProtectedPathsForBranch(exec, "/repo", "feature/x");
  const headResolves = calls.filter(
    (c) => c.argv[0] === "rev-parse" && c.argv.includes("origin/feature/x"),
  );
  const range = calls.find((c) => c.argv[0] === "-c")?.argv.slice(-1)[0] ?? "";
  assert(
    r.ok === true && headResolves.length === 1 && range.endsWith(`..${HEAD_SHA}`),
    `without a pin each ref is resolved ONCE and reused (${headResolves.length} resolves, range ${JSON.stringify(range)})`,
  );
}

{
  // A pinned BASE is not re-resolved either: `git fetch <remote> <branch>`
  // updates the remote-tracking ref as a side effect, so a resolve of the base
  // after the fetch is a different commit than the resolve before it.
  const { exec, calls } = movingRefFixture({ clean: true });
  const r = await mergeProtectedPathsForBranch(exec, "/repo", "feature/x");
  const baseResolves = calls.filter(
    (c) => c.argv[0] === "rev-parse" && c.argv.includes("origin/main"),
  );
  assert(
    r.ok === true && baseResolves.length >= 1,
    `an unpinned base IS resolved, once (base resolves: ${baseResolves.length})`,
  );
}

process.exit(exit);
