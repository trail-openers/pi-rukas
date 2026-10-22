#!/usr/bin/env bun
/**
 * #1768 (1/2) — a develop pass that exits 0 mid-step is not "done": the rule
 * and the commit ATTRIBUTION it rests on.
 *
 * The defect (orchard cycle-id, cycle-id): a developer child
 * exited 0 and reported itself done, made NO commit of its own ahead of base,
 * and left its work uncommitted in the worktree. The #622 safety net committed
 * that dirt, and the net's own commit then satisfied the green rule — so a
 * mid-step quit was a completed step, rode into commit-pr on a
 * `wip: driver safety-net commit`, and surfaced two hours later as
 * `verify-failed:develop` naming no assertion.
 *
 * This file is the half that decides "did this pass commit its OWN work":
 *  (1) the pure green rule: own commits / leftover / clean / driver-only /
 *      unreadable, and that a driver-only commit is never a green
 *  (2) `ownCommitsAheadOfBase` against a REAL git repo: a developer commit
 *      counts; a lone safety-net commit is `driverOnly`; a mixed stack counts
 *      only its own; an unreadable base is never 0
 *  (3) the classify seam: a claimed green over a dirty tree is `ok: false`
 *      with the unfinished fragment, and the fragment names the paths
 *  (4) the safety net cannot certify a pass — not by its subject, and not by
 *      its SHA once a later commit re-stages its content (the misattribution
 *      the subject prefix alone cannot catch)
 *
 * The corrective round, the park, the registries and the untouched ordinary
 * pass are in `test-develop-unfinished-attribution.ts`. Each file runs alone.
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyDevelopPass } from "../src/work-develop-crash.ts";
import { readGreenPassFields } from "../src/work-develop-green-classify.ts";
import { childOwnWork } from "../src/work-develop-greens.ts";
import {
  decideGreenFromTree,
  unfinishedTreeSentence,
  unfinishedUnrecoverable,
} from "../src/work-develop-unfinished-facts.ts";
import {
  SAFETY_NET_COMMIT_SUBJECT_PREFIX,
  developUnfinished,
  ownCommitsAheadOfBase,
  unfinishedBranchCompleted,
} from "../src/work-develop-unfinished.ts";
import { safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import {
  childCommitPaths,
  commit,
  greenResult,
  makeAssert,
  mkRepo,
} from "./lib/develop-unfinished-fixture.ts";
import { realExec } from "./lib/exec-fake.ts";

const { assert, failed } = makeAssert();

// ---------------------------------------------------------------- (1) pure rule
function caseOne() {
  const g = decideGreenFromTree({ commits: 2 }, []);
  assert(g.done === true && g.unfinished === false, "(1) own commits → done");

  const u = decideGreenFromTree({ commits: 0 }, ["src/a.ts", "docs/b.md"]);
  assert(
    u.done === false && u.unfinished === true && u.evidence === "leftover",
    "(1) 0 own commits + dirty tree → unfinished",
  );
  assert(
    (u.reason ?? "").includes("src/a.ts") && (u.reason ?? "").includes("docs/b.md"),
    "(1) the unfinished reason names the uncommitted paths",
  );

  const c = decideGreenFromTree({ commits: 0 }, []);
  assert(
    c.done === false && c.unfinished === false && c.evidence === "none",
    "(1) 0 own commits + clean tree → the existing GREEN_DOWNGRADE, not this cap",
  );

  const d = decideGreenFromTree({ driverOnly: true }, ["src/a.ts"]);
  assert(
    d.done === false && d.unfinished === true,
    "(1) only the driver's own recovery commits + dirt → unfinished (the pre-fix green)",
  );
  assert(
    (d.reason ?? "").includes("driver's own safety-net recovery commits"),
    "(1) the driver-only reason says so, rather than counting the net's commit",
  );

  const r = decideGreenFromTree({ unreadable: "git: fatal" }, ["src/a.ts"]);
  assert(
    r.done === false && r.unreadable === true && r.unfinished === false,
    "(1) an unreadable tree blocks the pass, and is not reported as unfinished work",
  );

  const dirty0 = decideGreenFromTree(
    { commits: 0 },
    Array.from({ length: 12 }, (_, i) => `f${i}`),
  );
  assert(
    (dirty0.reason ?? "").includes("+2 more"),
    "(1) a long leftover list is bounded in the sentence",
  );

  assert(
    unfinishedUnrecoverable([
      { id: "a", tree: "clean", paths: [], reason: "" },
      { id: "b", tree: "dirty", paths: ["x"], reason: "" },
      { id: "c", tree: "unreadable", paths: [], reason: "boom" },
    ])
      .map((r) => r.id)
      .join(",") === "b,c",
    "(1) only a dirty or unreadable tree parks; a clean no-commit pass does not",
  );
  assert(
    unfinishedTreeSentence({ id: "b", tree: "dirty", paths: ["x"], reason: "" }).includes("x"),
    "(1) the tree sentence names the paths",
  );
}

// --------------------------------------------- (2) ownCommitsAheadOfBase, real git
async function caseTwo() {
  const { root, wt, baseSha } = await mkRepo();
  const exec = realExec;
  try {
    const empty = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert("commits" in empty && empty.commits === 0, "(2) a fresh worktree has 0 own commits");

    await commit(wt, "a.ts", "feat(x): developer work");
    const own = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert("commits" in own && own.commits === 1, "(2) a developer commit counts as its own");

    // The pre-fix shape: the ONLY commit ahead of base is the driver's net.
    const repo2 = await mkRepo();
    const exec2 = realExec;
    await commit(repo2.wt, "leftover.ts", `${SAFETY_NET_COMMIT_SUBJECT_PREFIX} for default`);
    const netOnly = await ownCommitsAheadOfBase(exec2, repo2.wt, repo2.baseSha);
    assert(
      "driverOnly" in netOnly,
      "(2) a stack whose only commit is a safety-net commit is driverOnly, never a green",
    );

    const mixed = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert("commits" in mixed && mixed.commits === 1, "(2) mixed stack counts own commits only");

    const broken = await ownCommitsAheadOfBase(exec, wt, "not-a-sha");
    assert("unreadable" in broken, "(2) an invalid base is unreadable, never folded into 0");

    const noBase = await ownCommitsAheadOfBase(exec, wt, undefined);
    assert("unreadable" in noBase, "(2) a missing base is unreadable, never a count");

    rmSync(repo2.root, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- (3) the classify seam
async function caseThree() {
  const { root, wt, baseSha } = await mkRepo();
  try {
    // The child's own claim of completion over a dirty tree.
    writeFileSync(path.join(wt, "left.ts"), "wip\n");
    const v = await classifyDevelopPass({
      id: "default",
      cwd: wt,
      base: baseSha,
      execFn: realExec,
      result: greenResult(),
    });
    assert(v.ok === false, "(3) a claimed green over a dirty tree is NOT ok");
    assert(v.unfinished === true, "(3) the verdict carries the unfinished marker");
    assert(
      v.unfinishedReading?.evidence === "leftover" &&
        v.unfinishedReading.uncommitted.includes("left.ts"),
      "(3) the reading names the uncommitted path",
    );

    const ev = unfinishedBranchCompleted({
      id: "default",
      ms: 1,
      reading: v.unfinishedReading!,
    });
    const read = developUnfinished([ev]);
    assert(
      read.length === 1 && read[0].tree === "dirty" && read[0].paths.includes("left.ts"),
      "(3) the event round-trips to a record with the paths",
    );

    // A test seam drives the three-state answer without a repository. The
    // status read is real (a fake could not hide a dirty tree), so the tree
    // keeps its uncommitted file from the top of this case.
    const v2 = await classifyDevelopPass({
      id: "default",
      cwd: wt,
      base: baseSha,
      execFn: realExec,
      result: greenResult(),
      ownCommits: async () => ({ driverOnly: true }),
    });
    assert(
      v2.ok === false && v2.unfinished === true,
      "(3) driver-only commits are refused through the seam too",
    );

    const v3 = await classifyDevelopPass({
      id: "default",
      cwd: wt,
      base: baseSha,
      execFn: realExec,
      result: greenResult(),
      ownCommits: async () => ({ commits: 3 }),
    });
    assert(
      v3.ok === true && v3.ownCommits !== undefined && v3.unfinished === undefined,
      "(3) a pass with its own commits stays green and carries no fragment",
    );

    // A `DriverExecFn` whose git calls cannot succeed: the commit read is
    // unreadable, and an unreadable tree is never a certified green.
    const fields = await readGreenPassFields(
      (_cmd, _opts) => Promise.reject(new Error("git exploded")),
      wt,
      baseSha,
    );
    assert(
      fields.reading.unreadable === true && fields.reading.done === false,
      "(3) an unreadable commit read blocks the pass rather than counting it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --------------------------------- (4) the safety net cannot certify a pass
async function caseFour() {
  const { root, wt, baseSha } = await mkRepo();
  try {
    writeFileSync(path.join(wt, "dirt.ts"), "wip\n");
    const exec = realExec;
    // The green rule the phases now apply BEFORE the net: no own commit, so no
    // green — and the net is not consulted for the verdict at all.
    const own = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert(!childOwnWork({ ownCommits: own }), "(4) a dirt-only tree fails the green rule");
    // A driver commit made by the net does not retroactively satisfy it — and
    // the net's commit carries ONLY its own file: it runs at a moment when the
    // tree holds nothing else of the child's, exactly as in the incident, so a
    // later `git add` here cannot sweep the net's file into a developer commit
    // and make the assertion about the net's subject pass for the wrong reason.
    // The child-style commit stages the whole tree, so the removed dirt file is
    // recorded as a deletion here and the tree really is clean afterwards: the
    // net then has nothing of the child's left to commit, which is the point.
    rmSync(path.join(wt, "dirt.ts"), { force: true });
    await commit(wt, "net.ts", `${SAFETY_NET_COMMIT_SUBJECT_PREFIX} for default`);
    const after = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert(
      !childOwnWork({ ownCommits: after }),
      "(4) the net's own commit never satisfies the green rule (the pre-fix bug)",
    );
    // And a developer commit does.
    await commit(wt, "real.ts", "feat(x): real work");
    const third = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert(childOwnWork({ ownCommits: third }), "(4) once the child commits, the pass is green");

    // (4b) the misattribution case the subject prefix alone cannot catch: the
    // net committed `net.ts` (a driver commit), and a later child commit
    // re-stages that same path — so the net's CONTENT now sits in a commit whose
    // SUBJECT reads like a developer's. Discounting by the SHA the net recorded
    // is what keeps the pass from being certified on the driver's own work.
    const repo3 = await mkRepo();
    const exec3 = realExec;
    try {
      const notes: string[] = [];
      writeFileSync(path.join(repo3.wt, "net-only.ts"), "driver wrote this\n");
      const netEv = await safetyNetWorktree(
        "default",
        repo3.root,
        repo3.wt,
        repo3.baseSha,
        exec3,
        notes,
      );
      assert(
        netEv?.kind === "safety-net-commit",
        "(4b) the net commits a dirt-only tree (it is recovery for an EARNED green)",
      );
      const netShas = netEv && netEv.kind === "safety-net-commit" ? (netEv.commitShas ?? []) : [];
      assert(netShas.length === 1, "(4b) the net names the commit it created");
      // A later commit that re-stages the net's file, under a developer subject.
      writeFileSync(path.join(repo3.wt, "net-only.ts"), "driver wrote this (touched)\n");
      await childCommitPaths(repo3.wt, "feat(x): child work", ["net-only.ts"]);
      const bySubject = await ownCommitsAheadOfBase(exec3, repo3.wt, repo3.baseSha);
      assert(
        "commits" in bySubject && bySubject.commits >= 1,
        "(4b) without the SHAs, the net's content in a child-subject commit does count",
      );
      const withShas = await ownCommitsAheadOfBase(exec3, repo3.wt, repo3.baseSha, netShas);
      assert(
        childOwnWork({ ownCommits: withShas }),
        "(4b) discounting the net's SHA still counts the child's own commit",
      );
      // And a stack of ONLY that kind is no work at all.
      const repo4 = await mkRepo();
      const exec4 = realExec;
      const notes4: string[] = [];
      writeFileSync(path.join(repo4.wt, "dirt.ts"), "child dirt\n");
      const netEv2 = await safetyNetWorktree(
        "default",
        repo4.root,
        repo4.wt,
        repo4.baseSha,
        exec4,
        notes4,
      );
      const shas2 = netEv2 && netEv2.kind === "safety-net-commit" ? (netEv2.commitShas ?? []) : [];
      writeFileSync(path.join(repo4.wt, "dirt.ts"), "child dirt touched\n");
      await childCommitPaths(repo4.wt, "wip: driver safety-net recovery commit amend", ["dirt.ts"]);
      const allDriver = await ownCommitsAheadOfBase(exec4, repo4.wt, repo4.baseSha, shas2);
      assert(
        "driverOnly" in allDriver,
        "(4b) commits the driver made are never the child's work, by SHA or by subject",
      );
      rmSync(repo4.root, { recursive: true, force: true });
    } finally {
      rmSync(repo3.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

caseOne();
await caseTwo();
await caseThree();
await caseFour();

if (failed()) {
  console.error("\nFAILED");
  process.exit(1);
}
console.log("\nall pass");
