#!/usr/bin/env bun
/**
 * lean/challenge — the boundary a round's SUBMISSIONS pass, end to end.
 *
 * `test-lean-challenge-coverage.ts` drives what a round's verdict means and
 * `test-lean-challenge-gates.ts` drives what stops a round before a child is
 * paid. This file drives the one rule that decides whether a submitted file is
 * the adversary's work at all: a kept path must not exist at the run's BASE
 * COMMIT. It lives on the challenge side because challenge is the step whose
 * ref makes the rule subtle — it resets to, and proves red against, the HEAD,
 * and at the head every test of the run and every test the project shipped are
 * present. Only the base can answer "did this child write this?", which is why
 * the step asks the base while proving against the head.
 *
 *   (r1) a tracked project test that is neither frozen nor the run's, submitted
 *        as an edge case: refused as OLD, and only the file the child wrote is
 *        frozen and committed. It reads red at the head for the wrong reason —
 *        nothing exercises it — which is the fraud the rule exists to stop.
 *   (r2) the run's own frozen test, submitted: keeps the FROZEN reason and never
 *        gets the newness one, so nobody is told to rename a file the contract
 *        names. This is the ordering that the two rules would fight over, since
 *        an inherited frozen test is present at the base too.
 *   (r3) the control: an edge case the child actually wrote still freezes, in the
 *        same call as the refusals — the rule is per path, not a "submit nothing".
 *   (r4) the probe goes through the step's OWN exec seam, in argv form, against
 *        the run's base sha: a rule wired to the wrong ref (or the working tree)
 *        looks identical right up until it passes something it should not.
 */

import { ChallengeInfraError } from "../src/lean/challenge.ts";
import { NEWNESS_REASON } from "../src/lean/specify-tree.ts";
import { SpecifyInfraError } from "../src/lean/specify.ts";
import {
  ROOTS,
  SpecifyInfraError as SpecifyInfraErrorFromFixture,
  challengeFixture,
  commitPaths,
  git,
  put,
  redEdge,
  runChallenge,
  submit,
} from "./lib/lean-challenge-fixture.ts";
import { assert, testLocationExit } from "./lib/lean-test-location-fixture.ts";

const EDGE = "tests/AC1-edge-new-for-round.test.sh";
/** A test the PROJECT shipped before the run: tracked, red-herring, not frozen. */
const TRACKED = "tests/AC1-project-preexisting.test.sh";
/** The run's own frozen acceptance test, named by the fixture's step log. */
const FROZEN = "tests/AC1-retry.test.sh";

/**
 * A fixture whose BASE commit also holds `rel` — a test the project shipped
 * before the run began, tracked, and NOT in the run's frozen map.
 *
 * The file has to live in the literal `baseSha` the run carries, because that is
 * the commit the probe under test is asked about: committing it on top of the
 * branch would make it present at the head and absent at the base, which is the
 * opposite case and would assert the opposite thing. So the base is amended and
 * the run's own two commits are replayed onto the rewritten base, and every step
 * of that is verified rather than trusted — a fixture that quietly lost the
 * frozen-test commit would leave the step hashing a record against no blob.
 */
function withTrackedAtBase(issue: number, rel: string, content: string) {
  const built = challengeFixture(issue);
  const repo = built.repoRoot;
  const wt = built.worktree;
  const oldBase = built.baseSha;
  const buildSha = built.buildSha;
  const branch = `lean/issue-${issue}`;
  put(repo, rel, content, 0o755);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--amend", "--no-edit");
  const newBase = git(repo, "rev-parse", "HEAD");
  if (git(repo, "show", `HEAD:${rel}`).includes("tracked") === false)
    throw new Error("fixture: the amended base does not hold the project's test");
  // The run's two commits are replayed detached in `repoRoot` (which holds
  // `main`, so the branch the run's worktree owns is never touched here) and
  // copied ONE AT A TIME with `--allow-empty`: a range pick silently skips the
  // fixture's deliberately-empty frozen-test commit, and a run whose step log
  // says it froze a test at a commit that does not exist is a fixture that
  // asserts nothing — `assertFrozenIntact` would throw for the wrong reason.
  git(repo, "checkout", "-q", "--detach", newBase);
  for (const c of git(repo, "rev-list", "--reverse", `${oldBase}..${buildSha}`).split("\n"))
    git(repo, "cherry-pick", "--ff", "--allow-empty", c);
  const newHead = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  if (git(repo, "rev-list", "--count", newHead).trim() !== "3")
    throw new Error(
      `fixture: the replay is not base + frozen + build (got ${git(repo, "rev-list", "--count", newHead)})`,
    );
  if (git(repo, "rev-parse", `${newHead}~2`).trim() !== newBase)
    throw new Error("fixture: the replay did not land the run's commits on the rewritten base");
  // The step reads its head with `rev-parse HEAD` IN THE WORKTREE, so that is
  // what has to move; the branch moves with it, from the only tree allowed to
  // move it, so the step's ownership check still finds the tree on the branch.
  git(wt, "checkout", "-q", "--detach", newHead);
  git(wt, "branch", "-f", branch, newHead);
  if (git(wt, "rev-parse", "HEAD").trim() !== newHead)
    throw new Error(`fixture: the worktree is at ${git(wt, "rev-parse", "HEAD")}, not ${newHead}`);
  return {
    ...built,
    baseSha: newBase,
    headBefore: git(repo, "rev-parse", `${newHead}~1`),
    buildSha: newHead,
    ctx: { ...built.ctx, run: { ...built.ctx.run, baseSha: newBase } },
  };
}

// ------------------------- (r1) a tracked project test is refused as not new

{
  const built = withTrackedAtBase(241, TRACKED, "#!/bin/sh\necho ok - tracked\nexit 0\n");
  const r = await runChallenge({
    issue: 241,
    built,
    child: (wt) => put(wt, EDGE, redEdge(EDGE), 0o755),
    toolUses: [submit("AC1", [EDGE, TRACKED])],
  });
  assert(
    r.threw === undefined,
    `(r1) a tracked submission is a verdict, not infrastructure (${r.threw?.message})`,
  );
  assert(
    r.outcome?.kind === "new-tests" && Object.keys(r.outcome.frozen ?? {}).join() === EDGE,
    `(r1) only the file the child wrote is frozen — the project's own test is not (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(`${TRACKED} ${NEWNESS_REASON}`),
    `(r1) the refusal names the file and states the rule (got ${r.outcome?.reason})`,
  );
  assert(
    commitPaths(r.worktree).join() === EDGE,
    `(r1) the round's commit holds the new edge case alone (got ${commitPaths(r.worktree).join(", ")})`,
  );
  assert(
    git(r.worktree, "show", `HEAD^:${TRACKED}`).includes("tracked") === true,
    "(r1) the project's own test is untouched in the tree it was committed from",
  );
}

// -------------- (r2) an inherited frozen test keeps the FROZEN reason, never "old"

{
  const built = withTrackedAtBase(242, TRACKED, "#!/bin/sh\necho ok - tracked\nexit 0\n");
  const r = await runChallenge({
    issue: 242,
    built,
    child: (wt) => put(wt, EDGE, redEdge(EDGE), 0o755),
    toolUses: [submit("AC1", [EDGE, FROZEN, TRACKED])],
  });
  const reason = r.outcome?.reason ?? "";
  assert(
    r.outcome?.kind === "new-tests" && Object.keys(r.outcome.frozen ?? {}).join() === EDGE,
    `(r2) the round freezes the one genuine edge case despite two refused submissions (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    reason.includes(`${FROZEN} is a frozen acceptance test`),
    `(r2) the frozen path is refused as FROZEN (got ${reason})`,
  );
  assert(
    reason.includes(`${FROZEN} ${NEWNESS_REASON}`) === false,
    `(r2) and never as merely old — the frozen reason is the one that says leave it alone (got ${reason})`,
  );
  assert(
    reason.includes(`${TRACKED} ${NEWNESS_REASON}`) === true,
    "(r2) the tracked-but-unfrozen path gets the newness reason, so the two rules stay distinguishable",
  );
}

// ----------------------- (r3) the control: what the child wrote still freezes

{
  const built = withTrackedAtBase(243, TRACKED, "#!/bin/sh\necho ok - tracked\nexit 0\n");
  const r = await runChallenge({
    issue: 243,
    built,
    child: (wt) => put(wt, EDGE, redEdge(EDGE), 0o755),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(r.threw === undefined, `(r3) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "new-tests" && Object.keys(r.outcome.frozen ?? {}).join() === EDGE,
    `(r3) a new file in a repo that also holds a tracked test still freezes (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(NEWNESS_REASON) === false,
    "(r3) and nothing is refused when nothing names an old path — the rule is not a blanket refusal",
  );
}

// ------------------- (r4) the probe rides the step's exec, in argv, at the BASE

{
  const built = withTrackedAtBase(244, TRACKED, "#!/bin/sh\necho ok - tracked\nexit 0\n");
  const r = await runChallenge({
    issue: 244,
    built,
    child: (wt) => put(wt, EDGE, redEdge(EDGE), 0o755),
    toolUses: [submit("AC1", [EDGE, TRACKED])],
  });
  const probes = r.gitArgvs.filter(
    (a) => a.includes("cat-file") && a.includes("-e") && a.includes("--end-of-options"),
  );
  assert(
    probes.length >= 1,
    `(r4) the newness check is a real git probe through the step's exec seam (${probes.length} call(s))`,
  );
  assert(
    probes.some((a) => a[a.length - 1] === `${built.baseSha}:${TRACKED}`),
    `(r4) the probe is asked against the run's BASE sha and the normalised path, as one argv word (got ${JSON.stringify(probes.map((a) => a[a.length - 1]))})`,
  );
  assert(
    probes.some((a) => a.includes("--literal-pathspecs")),
    "(r4) and the pathspec is literal, so a submitted glob cannot name a tracked file by pattern",
  );
  assert(
    probes.every((a) => (a[a.length - 1] ?? "").startsWith(`${built.baseSha}:`)),
    `(r4) no probe reads the head or the working tree — every newness question is about the base (got ${JSON.stringify(probes.map((a) => a[a.length - 1]))})`,
  );
  // Both infra classes are in scope on purpose: an unreadable base must throw
  // the pipeline's infra error rather than arrive as `none`, and this file's
  // assertions about verdicts are only meaningful if the throw type they would
  // have accepted is imported and named.
  assert(
    typeof SpecifyInfraError === "function" &&
      typeof ChallengeInfraError === "function" &&
      typeof SpecifyInfraErrorFromFixture === "function",
    "the infra error classes are in scope — a refused submission threw none of them",
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(
  testLocationExit() === 0 ? "\nA challenge round's edge cases must be new." : "\nFAILED",
);
process.exit(testLocationExit());
