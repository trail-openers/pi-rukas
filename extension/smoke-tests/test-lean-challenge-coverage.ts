#!/usr/bin/env bun
/**
 * lean/challenge, part 2 — the coverage rule and the two guards that must throw.
 *
 * Split from `test-lean-challenge.ts` at the natural seam: that file is the
 * round's COMMIT contract (what lands, where it lands, that the frozen map
 * still matches at the new head); this one is the round's VERDICT rules — when
 * `challenge` may say `new-tests`, when it must say `none`, and the two shapes
 * it must never answer either of with. Same fixture, same real git repo, only
 * the model stubbed.
 *
 *   (b2) a red for AC1 and a green for AC2 -> `new-tests` with EXACTLY the AC1
 *        file frozen. This is the regression the coverage rule exists for: the
 *        shared pipeline used to apply `specify`'s "every criterion or refuse"
 *        rule to both callers, so a challenge round that found one genuine gap
 *        was reported as having found none, and the proven-red file was deleted.
 *   (b)  a test that PASSES on HEAD -> `none`, nothing committed, the child's
 *        file gone from the tree.
 *   (c)  a submission naming a FROZEN path, spelled `tests/…` and `./tests//…`
 *        -> refused at the boundary; only the new file is frozen.
 *   (d)  a dispatch that died -> THROW (the step's own error class), never `none`.
 *   (e)  a runner that cannot start -> THROW, never `none`.
 *
 * Every throw case asserts the error CLASS. `none` and a throw are the only two
 * answers this step gives and the machine routes them to opposite places, so a
 * message match alone would still pass if the throw were the wrong kind — or if
 * a refactor returned `none` carrying a scary string.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { ChallengeInfraError } from "../src/lean/challenge.ts";
import {
  ROOTS,
  SpecifyInfraError,
  TWO_AC_BODY,
  blobSha,
  challengeFixture,
  commitPaths,
  git,
  greenEdge,
  put,
  redEdge,
  runChallenge,
  sha,
  status,
  subjectsAbove,
  submit,
} from "./lib/lean-challenge-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const EDGE = "tests/AC1-edge-second-failure.test.sh";
/** A second new file, so one run can submit a red and a green for two criteria. */
const GREEN_EDGE = "tests/AC2-edge-already-handled.test.sh";

// ---------------- (b2) "any red" is enough: a red for AC1 freezes despite a green AC2
//
// THE regression this file exists for. Under the old shared rule the pipeline
// refused the whole run because AC2 had no red file, and `challenge` reported
// `none` — an adversary that found a real gap was told it had found nothing, and
// the proven-red file was thrown away. The coverage rule is now a per-caller
// argument, and `challenge` passes `"any-red"`: everything proven red is
// committed, and one red anywhere is `new-tests`.
{
  const r = await runChallenge({
    issue: 220,
    specBody: TWO_AC_BODY,
    child: (wt) => {
      put(wt, EDGE, redEdge(EDGE));
      put(wt, GREEN_EDGE, greenEdge(GREEN_EDGE));
    },
    toolUses: [submit("AC1", [EDGE]), submit("AC2", [GREEN_EDGE])],
  });
  assert(r.threw === undefined, `(b2) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "new-tests", `(b2) new-tests, got ${r.outcome?.kind}`);
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === EDGE,
    `(b2) EXACTLY the AC1 file is frozen — the green AC2 file is not (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    JSON.stringify(r.outcome?.tests) === JSON.stringify({ AC1: [EDGE] }),
    `(b2) tests maps only the criterion that earned a red (got ${JSON.stringify(r.outcome?.tests)})`,
  );
  assert(
    commitPaths(r.worktree).join() === EDGE,
    `(b2) the commit holds the red file and nothing else (got ${commitPaths(r.worktree).join(", ")})`,
  );
  assert(
    existsSync(path.join(r.worktree, GREEN_EDGE)) === false,
    "(b2) the green file is deleted from the tree, not left for the next step to find",
  );
  assert(status(r.worktree) === "", `(b2) the worktree is clean (got ${status(r.worktree)})`);
}

// ------------------------ (b) a test that PASSES on HEAD is `none`, and commits nothing
//
// `none` is the round's honest "the builder closed every case I could find", and
// the machine routes it to verify with the contract it already had. The two
// things that make this assertion mean anything: HEAD has not moved, and the
// child's file is gone from the tree — a `none` that left a green test behind
// would hand verify a file nobody proved anything about.
{
  const built = challengeFixture(221);
  const before = git(built.worktree, "rev-parse", "HEAD");
  const r = await runChallenge({
    issue: 221,
    built,
    child: (wt) => {
      put(wt, GREEN_EDGE, greenEdge(GREEN_EDGE));
      put(wt, EDGE, redEdge(EDGE));
    },
    // Only the GREEN file is declared. The red one exists in the tree but was
    // never submitted, so the step must never see it — which is what separates
    // "the proof dropped the green" from "the step committed whatever was there".
    toolUses: [submit("AC1", [GREEN_EDGE])],
  });
  assert(r.threw === undefined, `(b) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "none", `(b) none, got ${r.outcome?.kind}`);
  assert(
    git(built.worktree, "rev-parse", "HEAD") === before,
    "(b) nothing was committed — the head the step found is still the head",
  );
  assert(
    subjectsAbove(built.worktree, before).length === 0,
    `(b) no commit above it at all (got ${subjectsAbove(built.worktree, before).join(" | ")})`,
  );
  assert(
    existsSync(path.join(built.worktree, GREEN_EDGE)) === false,
    "(b) the child's green file is gone from the tree",
  );
  assert(
    existsSync(path.join(built.worktree, EDGE)) === false,
    "(b) and so is the file it never declared — the tree is the head's, not the child's",
  );
  assert(status(built.worktree) === "", `(b) clean afterwards (got ${status(built.worktree)})`);
}

// --------------------- (c) a submission naming a FROZEN path is refused, both spellings
//
// The adversary's one dangerous act: replacing a frozen test rewrites the
// contract the builder is measured against. The boundary refuses it — and
// refuses it on the NORMALISED path, which is the half that leaks if you are not
// careful: a child writing `./tests//AC1-…` names the same file through a string
// the frozen set does not contain, so the check has to run after normalisation
// and before the existence check (a frozen path DOES exist, so the order is what
// makes the reason say "you may not replace a frozen test" rather than the
// misleading "this file is not a regular file").
{
  const FROZEN_EXTRA = "tests/AC1-second-failure.test.sh";
  const extra = { [FROZEN_EXTRA]: redEdge(FROZEN_EXTRA) };
  const built = challengeFixture(222, { extraFrozen: extra });
  // Two runs against one repo would fight over the same worktree, so the run
  // that does NOT touch a frozen path gets its own tree at the same content.
  const clean = challengeFixture(223, { extraFrozen: extra, worktreeIssue: 2233 });
  const r = await runChallenge({
    issue: 222,
    built,
    child: (wt) => {
      // The child overwrites the frozen file AND writes a new one, then
      // declares both — twice for the frozen one, in both spellings.
      put(wt, FROZEN_EXTRA, `${redEdge(FROZEN_EXTRA)}# weakened by the adversary\n`);
      put(wt, EDGE, redEdge(EDGE));
    },
    toolUses: [
      submit("AC1", [FROZEN_EXTRA]),
      submit("AC1", ["./tests//AC1-second-failure.test.sh"]),
      submit("AC1", [EDGE]),
    ],
  });
  assert(
    r.threw === undefined,
    `(c) no throw — a refused path is a drop, not infra (${r.threw?.message})`,
  );
  assert(r.outcome?.kind === "new-tests", `(c) new-tests, got ${r.outcome?.kind}`);
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === EDGE,
    `(c) ONLY the new file is frozen (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    commitPaths(r.worktree).join() === EDGE,
    `(c) the commit holds the new file alone — no frozen path (got ${commitPaths(r.worktree).join(", ")})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(`${FROZEN_EXTRA} is a frozen acceptance test`),
    `(c) the reason names the frozen refusal, under the NORMALISED path — so the ./ and // spellings cannot dodge it (got ${r.outcome?.reason})`,
  );
  assert(
    blobSha(r.worktree, "HEAD", FROZEN_EXTRA) === sha(redEdge(FROZEN_EXTRA)),
    "(c) the frozen test the child weakened is restored from the commit it was hashed at",
  );
  const c2 = await runChallenge({
    issue: 223,
    built: clean,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(
    c2.outcome?.kind === "new-tests" && Object.keys(c2.outcome?.frozen ?? {}).join() === EDGE,
    `(c) the same run WITHOUT a frozen submission freezes the new file as before (got ${JSON.stringify(c2.outcome?.frozen)})`,
  );
}

// --------------------------- (d) a dispatch that died THROWS — it is never `none`
//
// `none` certifies "I looked and found no gap". A child that never ran looked at
// nothing, and an outage must not get to certify an implementation.
{
  const r = await runChallenge({
    issue: 224,
    dispatchOk: false,
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(r.threw !== undefined, "(d) a dead dispatch THROWS");
  assert(
    r.threw instanceof ChallengeInfraError,
    `(d) and the throw is the step's OWN infra class, not a string that merely reads badly (got ${r.threw?.constructor.name ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(
    r.threw instanceof SpecifyInfraError === false,
    "(d) it is not the specify step's class — a handback names the step that failed",
  );
  assert(
    r.outcome === undefined,
    `(d) it never returned a verdict at all (got ${r.outcome?.kind})`,
  );
  assert(r.dispatched === 1, `(d) the adversary was dispatched once (got ${r.dispatched})`);
}

// ------------------------------ (e) a runner that cannot start THROWS, never `none`
//
// Same reasoning one layer down: the template names an executable that is not
// there, so the process never starts. Read as "this file was not red", that is a
// `none` — a certification about code the toolchain never got to judge.
{
  const r = await runChallenge({
    issue: 225,
    runner: "definitely-not-a-real-runner-binary {file}",
    child: (wt) => put(wt, EDGE, redEdge(EDGE)),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(r.threw !== undefined, "(e) a runner that cannot start THROWS");
  assert(
    r.threw instanceof SpecifyInfraError,
    `(e) and it is the pipeline's infra class (got ${r.threw?.constructor.name ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(
    /could not be started/.test(r.threw?.message ?? ""),
    `(e) the throw names the runner, not the test (got ${r.threw?.message})`,
  );
  assert(r.outcome === undefined, `(e) never a verdict (got ${r.outcome?.kind})`);
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
