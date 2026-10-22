#!/usr/bin/env bun
/**
 * #1768 — a develop pass that exits 0 mid-step is not "done".
 *
 * The defect (orchard cycle-id, cycle-id): a developer child
 * exited 0 and reported itself done, made NO commit of its own ahead of base,
 * and left its work uncommitted in the worktree. The #622 safety net committed
 * that dirt, and the net's own commit then satisfied the green rule — so a
 * mid-step quit was a completed step, rode into commit-pr on a
 * `wip: driver safety-net commit`, and surfaced two hours later as
 * `verify-failed:develop` naming no assertion.
 *
 * Covered:
 *  (1) the pure green rule: own commits / leftover / clean / driver-only /
 *      unreadable, and that a driver-only commit is never a green
 *  (2) `ownCommitsAheadOfBase` against a REAL git repo: a developer commit
 *      counts; a lone safety-net commit is `driverOnly`; a mixed stack counts
 *      only its own; an unreadable base is never 0
 *  (3) the classify seam: a claimed green over a dirty tree is `ok: false`
 *      with the unfinished fragment, and the fragment names the paths
 *  (4) the safety net does NOT commit an unfinished pass (the green rule fires
 *      before the net, so the net's commit can never certify the pass)
 *  (5) the corrective round runs exactly once per unfinished workstream, is
 *      handed the paths and the no-reset instruction, and never calls reset
 *  (6) a round that finishes → no park; a round that quits again → park on
 *      `develop-incomplete-uncommitted` with the paths in evidence
 *  (7) the cap is known to every registry (validator, headless caps, cause
 *      table) and the explanation names the paths
 *  (8) a normal pass that committed its own work is untouched: no fragment, no
 *      park, safety net still fires for its leftovers
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { FIXED_CAPS } from "../src/headless/caps.ts";
import { classifyDevelopPass } from "../src/work-develop-crash.ts";
import { childOwnWork } from "../src/work-develop-greens.ts";
import {
  decideGreenFromTree,
  unfinishedTreeSentence,
  unfinishedUnrecoverable,
} from "../src/work-develop-unfinished-facts.ts";
import { runUnfinishedCorrectiveRound } from "../src/work-develop-unfinished-round.ts";
import { readGreenPassFields } from "../src/work-develop-green-classify.ts";
import {
  SAFETY_NET_COMMIT_SUBJECT_PREFIX,
  developUnfinished,
  ownCommitsAheadOfBase,
  parkOnDevelopUnfinished,
  unfinishedBranchCompleted,
  unfinishedCorrectivePrompt,
} from "../src/work-develop-unfinished.ts";
import { FIXED_CAP_CAUSE } from "../src/work-driver-cause-table.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { safetyNetWorktree } from "../src/work-driver-safety-net.ts";
import { applySafetyNet } from "../src/work-driver-safety-net.ts";
// The net's default executor, used where the test wants the net's real
// behaviour rather than a fake's.
import { execp } from "../src/work-driver-verify.ts";
import { CAP_HIT_FIXED_LITERALS, isKnownCap } from "../src/workflow-state-validate-caps.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exitCode = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

/** A `DriverExecFn` fake over the real git binary, matching what `execp` does
 *  with the argv form (`execFile(cmd, argv, …)` — the array goes to git as-is,
 *  so a commit message with spaces survives without shell quoting) and
 *  PROPAGATING the exit status. That second half is load-bearing: a fake that
 *  resolved every call successfully turns `git rev-parse -q --verify MERGE_HEAD`
 *  into "a merge is in progress" and makes the safety net skip for a reason that
 *  has nothing to do with the product. */
function gitExec(defaultCwd: string) {
  return (cmd: string, opts?: { cwd?: string; argv?: string[] }): Promise<{ stdout: string }> =>
    execFileP(cmd, opts?.argv ?? [], {
      cwd: opts?.cwd ?? defaultCwd,
    }).then((r) => ({ stdout: r.stdout }));
}

/** A git repo with a base commit and one detached worktree (same fixture as
 *  test-develop-safety-net.ts — the shape must be the real one here). */
async function mkRepo(): Promise<{ root: string; wt: string; baseSha: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "dev-unfinished-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  await execFileP("git", ["init", "-q", "--initial-branch=main", repo]);
  await execFileP("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  await execFileP("git", ["-C", repo, "add", "base.txt"]);
  await execFileP("git", ["-C", repo, "commit", "-q", "-m", "base"]);
  const { stdout } = await execFileP("git", ["-C", repo, "rev-parse", "HEAD"]);
  const baseSha = stdout.trim();
  const wt = path.join(root, ".worktrees", "wt");
  await execFileP("git", ["-C", repo, "worktree", "add", "-q", "--detach", wt, "HEAD"]);
  return { root, wt, baseSha };
}

/** A child-style commit: `git add -A` then commit, as the developer prompt
 *  instructs. Staging the whole tree (not one path) matters for these fixtures —
 *  a helper that staged one file and left a removed sibling in the index would
 *  leave the tree "clean" for the wrong reason and the net would find nothing to
 *  commit, which is a test bug rather than a fact about the product. */
async function commit(wt: string, file: string, subject: string): Promise<void> {
  writeFileSync(path.join(wt, file), `${subject}\n`);
  await execFileP("git", ["-C", wt, "add", "-A"]);
  await execFileP("git", ["-C", wt, "commit", "-q", "-m", subject]);
}

/** The shape classifyDevelopPass is called with on a child-reported green. */
function greenResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    text: "agent done: developer",
    stopReason: "endTurn",
    ...overrides,
  } as never;
}

function stateWith(issue: number, events: WorkState["eventLog"]): WorkState {
  let s = initialState(issue, Date.now());
  s = { ...s, pipelineState: { ...s.pipelineState, currentStep: "develop" } };
  for (const e of events) s = appendEvent(s, e);
  return s;
}

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
  const exec = gitExec(root);
  try {
    const empty = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert("commits" in empty && empty.commits === 0, "(2) a fresh worktree has 0 own commits");

    await commit(wt, "a.ts", "feat(x): developer work");
    const own = await ownCommitsAheadOfBase(exec, wt, baseSha);
    assert("commits" in own && own.commits === 1, "(2) a developer commit counts as its own");

    // The pre-fix shape: the ONLY commit ahead of base is the driver's net.
    const repo2 = await mkRepo();
    const exec2 = gitExec(repo2.root);
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
      execFn: gitExec(root),
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
      execFn: gitExec(root),
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
      execFn: gitExec(root),
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
    const exec = gitExec(root);
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
    const exec3 = gitExec(repo3.root);
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
      await execFileP("git", ["-C", repo3.wt, "add", "-A"]);
      await execFileP("git", ["-C", repo3.wt, "commit", "-q", "-m", "feat(x): child work"]);
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
      const exec4 = gitExec(repo4.root);
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
      await execFileP("git", ["-C", repo4.wt, "add", "-A"]);
      await execFileP("git", [
        "-C",
        repo4.wt,
        "commit",
        "-q",
        "-m",
        "wip: driver safety-net recovery commit amend",
      ]);
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

// -------------------------------------------------- (5) the round: once, resumed
async function caseFive() {
  const calls: { id: string; cwd: string; prompt: string; label: string }[] = [];
  const unfinished = [
    {
      id: "default",
      cwd: "/tmp/wt-a",
      base: "abc",
      paths: ["src/a.ts", "docs/b.md"],
      reason: "r",
    },
  ];
  const ctx = { issue: 1768 } as never;
  // The live holder the fan-out closures write through, exactly as the step
  // hands it over.
  const stateRef = { current: stateWith(1768, []) };
  stateRef.current = appendEvent(
    stateRef.current,
    unfinishedBranchCompleted({
      id: "default",
      ms: 1,
      reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts", "docs/b.md"]),
    }),
  );
  const out = await runUnfinishedCorrectiveRound({
    ctx,
    stateRef,
    unfinished,
    multi: false,
    scopeFor: () => "implement the gate",
    pathsFor: () => ["src/a.ts"],
    runPass: async (id, cwd, corrective) => {
      calls.push({ id, cwd, ...corrective });
      // The round's own record: still unfinished (another `agent done` over a
      // dirty tree), appended through the live ref as the real closure does.
      stateRef.current = appendEvent(
        stateRef.current,
        unfinishedBranchCompleted({
          id,
          ms: 1,
          reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts", "docs/b.md"]),
        }),
      );
      return { id, ok: false };
    },
  });
  assert(calls.length === 1, "(5) exactly ONE corrective dispatch per unfinished workstream");
  assert(calls[0]?.id === "default", "(5) the round targets the unfinished workstream");
  assert(calls[0]?.cwd === "/tmp/wt-a", "(5) the round runs IN the quitting child's worktree");
  assert(
    calls[0]?.prompt.includes("src/a.ts") && calls[0]?.prompt.includes("docs/b.md"),
    "(5) the prompt names the paths the child left uncommitted",
  );
  assert(
    calls[0]?.prompt.includes("NOT been reset") &&
      calls[0]?.prompt.includes("git reset --hard") &&
      calls[0]?.prompt.includes("git clean"),
    "(5) the prompt forbids discarding the work and says the tree was not reset",
  );
  assert(
    calls[0]?.prompt.includes("git commit") && calls[0]?.prompt.includes("Do NOT push"),
    "(5) the prompt ends in the commit the quitting child never made, and forbids pushing",
  );
  assert(
    calls[0]?.label.includes("unfinished-corrective"),
    "(5) the dispatch is labelled as the corrective round",
  );
  assert(out.blocked.join() === "default" && out.parked === true, "(5) still unfinished → park");

  // A closure that throws (dispatch failure) is recorded by the closure itself;
  // the round must not crash and must still judge from the tree.
  const ref2 = { current: stateWith(1768, []) };
  ref2.current = appendEvent(
    ref2.current,
    unfinishedBranchCompleted({
      id: "ws",
      ms: 1,
      reading: decideGreenFromTree({ commits: 0 }, ["x.ts"]),
    }),
  );
  const out2 = await runUnfinishedCorrectiveRound({
    ctx,
    stateRef: ref2,
    unfinished: [{ id: "ws", cwd: "/tmp/wt", base: "b", paths: ["x.ts"], reason: "r" }],
    multi: false,
    scopeFor: () => undefined,
    pathsFor: () => [],
    runPass: async () => {
      throw new Error("dispatch blew up");
    },
  });
  assert(
    out2.parked === true,
    "(5) a throwing corrective dispatch still parks, never green-lights",
  );

  const prompt = unfinishedCorrectivePrompt({
    issue: 1768,
    workstreamId: "ws-1",
    parallel: true,
    scope: "the scope",
    paths: ["src/x.ts"],
    uncommitted: [],
  });
  assert(
    prompt.includes("workstream `ws-1`") &&
      prompt.includes("the scope") &&
      prompt.includes("src/x.ts"),
    "(5) the parallel prompt carries the workstream id, scope and declared paths",
  );
  assert(
    prompt.includes("could not read the tree"),
    "(5) an unreadable tree is told to the developer, not hidden",
  );
}

/** A `branch-completed` for a workstream the driver CERTIFIED as done — the
 *  ordinary green, and the record that CLEARS an earlier unfinished one. The
 *  round's fake closures emit exactly what `classifyDevelopPass` emits for a
 *  pass with its own commits: `ok: true`, no `unfinished` fragment. Leftovers
 *  are NOT a fragment (a green pass may have them; the net notes them), so a
 *  reader must key on the reading being `done`, never on the dirt list. */
function greenBranchCompleted(id: string): WorkEvent {
  return {
    kind: "branch-completed",
    step: "develop",
    workstreamId: id,
    ok: true,
    ms: 1,
    at: Date.now(),
  };
}

// ------------------------------------------ (6) recovery vs park, end to end
async function caseSix() {
  const { root, wt, baseSha } = await mkRepo();
  try {
    writeFileSync(path.join(wt, "wip.ts"), "wip\n");
    const exec = gitExec(root);
    const ctx = { issue: 1768 } as never;

    // (6a) the round commits its own work → no park, and the net still recovers
    // the leftovers it earned. The tree is put back to the state a green pass
    // leaves: the corrective commit landed, and one path is still uncommitted.
    writeFileSync(path.join(wt, "done.ts"), "feat(x): finished the step\n");
    await execFileP("git", ["-C", wt, "add", "done.ts"]);
    await execFileP("git", ["-C", wt, "commit", "-q", "-m", "feat(x): finished the step"]);
    writeFileSync(path.join(wt, "leftover.ts"), "still uncommitted\n");
    const ref1 = { current: stateWith(1768, []) };
    ref1.current = appendEvent(
      ref1.current,
      unfinishedBranchCompleted({
        id: "default",
        ms: 1,
        reading: decideGreenFromTree({ commits: 0 }, ["wip.ts"]),
      }),
    );
    const out1 = await runUnfinishedCorrectiveRound({
      ctx,
      stateRef: ref1,
      unfinished: [{ id: "default", cwd: wt, base: baseSha, paths: ["wip.ts"], reason: "r" }],
      multi: false,
      scopeFor: () => undefined,
      pathsFor: () => [],
      runPass: async (id) => {
        ref1.current = appendEvent(ref1.current, greenBranchCompleted(id));
        return { id, ok: true };
      },
    });
    assert(out1.parked === false, "(6a) a corrective round that commits → no park");
    assert(out1.recovered.join() === "default", "(6a) the workstream is reported recovered");
    // The net is handed the worktree map and the base the step holds (without
    // the map it has no worktree to visit), and the REAL executor: the fake
    // above resolves every git call successfully, which would make the net's
    // `mergeInProgress` probe answer "yes" and skip for a reason unrelated to
    // the product.
    const netState: WorkState = {
      ...ref1.current,
      pipelineState: {
        ...ref1.current.pipelineState,
        worktrees: { default: wt },
        baseSha,
      },
    };
    const afterNet = await applySafetyNet(
      { host: {}, repoRoot: root, verifyExecFn: execp } as never,
      netState,
    );
    // #1768 keeps the net's AC2 as it was: a pass WITH its own commits is not
    // the net's to rescue, so its leftover dirt is reported, not committed onto
    // the branch under a commit the review never saw. The consequence this issue
    // needs is the asymmetry — the net creates no commit that could certify a
    // pass, and for a pass without its own commits the phases never reach it.
    assert(
      !afterNet.eventLog.some((e) => e.kind === "safety-net-commit"),
      "(6a) the net creates no commit for a pass that already has its own (AC2 preserved)",
    );
    assert(
      afterNet.pipelineState.plumbReports.some(
        (r) => r.body.includes("left over") || r.body.includes("left out of the PR"),
      ),
      "(6a) the leftover is REPORTED to the operator rather than silently committed",
    );

    // (6b) the round quits the same way → park on the named cap with the paths.
    const ref2 = { current: stateWith(1768, []) };
    ref2.current = appendEvent(
      ref2.current,
      unfinishedBranchCompleted({
        id: "ws-1",
        ms: 1,
        reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts"]),
      }),
    );
    const out2 = await runUnfinishedCorrectiveRound({
      ctx,
      stateRef: ref2,
      unfinished: [{ id: "ws-1", cwd: wt, base: baseSha, paths: ["src/a.ts"], reason: "r" }],
      multi: true,
      scopeFor: () => undefined,
      pathsFor: () => [],
      runPass: async (id) => {
        ref2.current = appendEvent(
          ref2.current,
          unfinishedBranchCompleted({
            id,
            ms: 1,
            reading: decideGreenFromTree({ commits: 0 }, ["src/a.ts"]),
          }),
        );
        return { id, ok: false };
      },
    });
    assert(out2.parked === true, "(6b) a second unfinished pass parks");
    const parked = parkOnDevelopUnfinished(ref2.current, 1768);
    const tail = parked?.eventLog[parked.eventLog.length - 1];
    assert(
      tail?.kind === "cap-hit" && tail.cap === "develop-incomplete-uncommitted",
      "(6b) the cap is the event-log tail",
    );
    assert(
      tail?.kind === "cap-hit" && tail.nextStep === "handoff",
      "(6b) the park routes to handoff, not to the verify gate",
    );
    assert(
      tail?.kind === "cap-hit" && (tail.evidence ?? "").includes("src/a.ts"),
      "(6b) the cap's evidence names the unfinished path",
    );
    assert(
      parkOnDevelopUnfinished(stateWith(1768, []), 1768) === undefined,
      "(6b) nothing to park when no pass is unfinished",
    );

    // (6c) a clean no-commit pass is NOT this cap's finding.
    const s3 = stateWith(1768, [
      unfinishedBranchCompleted({
        id: "d",
        ms: 1,
        reading: decideGreenFromTree({ commits: 0 }, []),
      }),
    ]);
    assert(
      parkOnDevelopUnfinished(s3, 1768) === undefined,
      "(6c) a clean pass with no own commits stays the existing GREEN_DOWNGRADE",
    );

    // (6d) unreadable tree parks (the driver cannot certify a pass it cannot read).
    const s4 = stateWith(1768, [
      unfinishedBranchCompleted({
        id: "d",
        ms: 1,
        reading: decideGreenFromTree({ unreadable: "x" }, []),
      }),
    ]);
    assert(parkOnDevelopUnfinished(s4, 1768) !== undefined, "(6d) an unreadable tree parks");

    // (7) registries + explanation.
    assert(
      isKnownCap("develop-incomplete-uncommitted") &&
        CAP_HIT_FIXED_LITERALS.includes("develop-incomplete-uncommitted"),
      "(7) the state validator knows the cap",
    );
    assert(
      FIXED_CAPS.includes("develop-incomplete-uncommitted"),
      "(7) the headless cap list knows it",
    );
    assert(
      FIXED_CAP_CAUSE["develop-incomplete-uncommitted"] !== undefined,
      "(7) the cause table has a row",
    );
    assert(
      FIXED_CAP_CAUSE["develop-incomplete-uncommitted"]?.cls === "change",
      "(7) it is a change problem, not an environment one — the work is on disk",
    );
    const capEv = parked?.eventLog[parked.eventLog.length - 1];
    const explained =
      capEv?.kind === "cap-hit" ? explainCap(capEv.cap, parked!) : "(no cap to explain)";
    assert(
      explained.includes("src/a.ts") && explained.includes("--restart"),
      "(7) the handoff explanation names the path and the recovery command",
    );
    assert(
      explainCap("develop-incomplete-uncommitted", stateWith(1768, [])).includes("git -C"),
      "(7) with no record to read, the explanation still tells the operator where to look",
    );

    // (8) ordinary passes are untouched.
    const s5 = stateWith(1768, [
      { kind: "branch-completed", step: "develop", workstreamId: "d", ok: true, ms: 1, at: 1 },
    ]);
    assert(
      developUnfinished(s5.eventLog).length === 0,
      "(8) an ordinary green carries no fragment",
    );
    assert(
      parkOnDevelopUnfinished(s5, 1768) === undefined,
      "(8) an ordinary green never parks here",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

caseOne();
await caseTwo();
await caseThree();
await caseFour();
await caseFive();
await caseSix();

if (exitCode !== 0) {
  console.error("\nFAILED");
  process.exit(1);
}
console.log("\nall pass");
