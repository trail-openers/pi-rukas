#!/usr/bin/env bun
/**
 * lean/review — the fix push carries the guards the publish push already had.
 *
 * `integrate()` is the SECOND writer to `origin` in this pipeline, and it
 * validated `branch` with `assertSafeRef` alone. `assertSafeRef` proves a name is
 * a LEGAL git ref, and legal is the problem: `main` is legal (git then reads the
 * push's refspec as a mainline target), and `+x` is legal (git reads a leading
 * `+` in a refspec as a force). A run whose state file named the mainline would
 * have moved it onto the fixer's commit.
 *
 * `publish` refuses both shapes — `assertPublishableBranch` before any git
 * mutation, `netRefProblem` immediately before the push argv is built — and its
 * own comment states the reason: `branch` is state-file data, not a name this
 * cycle chose. These cases drive `review`'s push, not `publish`'s, because
 * `review`'s is the one that shipped unguarded.
 *
 * The assertions are on DELIVERED values, never on a predicate the test
 * recomputes: the argv every git call the step attempted is recorded off the
 * executor, and the branches origin actually holds are read back out of the real
 * bare origin. So a guard bolted on AFTER the push throws and still fails here —
 * and so does one placed after `resetWorktreeToBase`, which moves the run's
 * branch with `-B` and cleans the tree `verify` and `publish` read next.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPublishableBranch } from "../src/lean/publish-deps.ts";
import { netRefProblem } from "../src/work-driver-net-git.ts";
import { assertSafeRef } from "../src/worktree-loss.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  type DispatchUsageRow,
  FIXER_ROLE,
  type ReviewDeps,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  gitEnv,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

/**
 * The rule `review` did not have, and the case that separates it from the one it
 * did. `assertPublishableBranch` applies its rules in order — the `lean/` prefix
 * first ("work-lean pushes only lean/ branches"), then the resolved-mainline
 * comparison ("refusing to push to the mainline X") — so a case that only proves
 * "the run was refused" is green with the second rule deleted. This clone's
 * default branch is `trunk` and the run's branch IS `trunk` — the shape a state
 * file whose `run.branch` drifted onto the mainline leaves behind, and exactly the
 * shape `publish`'s docblock names as rule 1's blind spot ("Rule 2 catches a
 * mainline that does not spell `main` (`trunk`, a fork's default)"). Rule 1 fires
 * for `trunk` too, and the case says so out loud rather than hiding it: what makes
 * this the mainline rule's case is that the step reached `integrate()` at all, so
 * the guard that refused it is the review's new one, and the cause it was handed
 * names the mainline — rule 1's own sentence, `work-lean pushes only lean/
 * branches`, is separately asserted absent.
 */
const MAINLINE: string = "trunk";

/**
 * The state-file names the review push must refuse and both shipped checks accept.
 */
const UNSAFE: readonly { name: string; bothShip: boolean }[] = [
  // Accepted by both shipped checks, so the refusal can only be the new guard's.
  { name: "main", bothShip: true },
  { name: "+x", bothShip: true },
  // `a:b` is refused by BOTH shipped checks, not just one: `assertSafeRef` rejects
  // it as an illegal ref name and `netRefProblem` rejects the `:` as refspec syntax
  // a network git call will not take. It cannot earn the "accepted by both" premise
  // `main` and `+x` earn, and the test does not pretend it does — but it still
  // belongs in this list, because it is one of the shapes the push must refuse and
  // the guarantee that matters for it is the same one asserted below: NO push entry
  // ever reaches the argv the injected deps.exec received. Its precondition is
  // stated as what is actually true, so a later relaxation of either check that
  // made the claim false would go red rather than quietly narrowing the case.
  { name: "a:b", bothShip: false },
];

/** Did the shipped charset check accept this name? (premise, not predicate) */
function shippedCheckAccepts(name: string): boolean {
  try {
    assertSafeRef(name);
    return true;
  } catch {
    return false;
  }
}

/** Did the shipped network-safety check find this name's ref inert? (premise) */
function netRefClean(name: string): boolean {
  return netRefProblem(`refs/heads/${name}`) === undefined;
}

/**
 * One state-file branch name, driven through the whole review step.
 *
 * The run's worktree and origin hold a REAL lean ref at a real commit, so the only
 * thing that makes the case dangerous is `run.branch` — the field under test. The
 * adversarial gate refuses once and then clears, so the step buys exactly one
 * fixer; this fixer commits nothing, so a head reaching origin could only have
 * arrived through the step's own push. Every git call the step makes is recorded
 * through the injected `deps.exec`, which is the seam every lean review suite
 * already stubs — no production field was added to observe any of this.
 */
async function driveBranch(name: string): Promise<{
  threw?: Error;
  originMain: string;
  baseSha: string;
  head: string;
  pushed: string[];
  gitArgv: string[];
}> {
  const { repoRoot, origin, baseSha } = makeRepo();
  const head = await setup({
    repoRoot,
    baseSha,
    branch: BRANCH,
    feature: "export const f = 1;\n",
  });
  const pushed: string[] = [];
  const gitArgv: string[] = [];
  const deps: ReviewDeps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer will answer"),
    dispatch: async () => result({ role: FIXER_ROLE }),
  });
  const exec = deps.exec;
  deps.exec = (cmd, o) => {
    const argv = o?.argv ?? [];
    gitArgv.push(`${cmd} ${argv.join(" ")}`);
    if (argv.includes("push")) pushed.push(`${cmd} ${argv.join(" ")}`);
    return exec(cmd, o);
  };
  const { threw } = await run(ctxFor(repoRoot, baseSha, name), deps);
  return {
    threw,
    originMain: git(origin, "rev-parse", "--verify", "--quiet", "refs/heads/main"),
    baseSha,
    head,
    pushed,
    gitArgv,
  };
}

// ── (x1) A refusal, before anything left the clone ──────────────────────────
for (const { name, bothShip } of UNSAFE) {
  // The premise, pinned as a FACT about each of the two checks the step already
  // had — and the two disagree by design, which is the whole reason the push
  // needed a third. `assertSafeRef` proves legality (so `main`, which it accepts,
  // proves nothing about the new guard); `netRefProblem` proves a name is inert to
  // a network git call (so `main`, which it accepts, proves nothing either). The
  // names that clear BOTH are the ones only the reused publish guard can refuse,
  // and they are the point of this case; `a:b` is stated with its own facts so the
  // case cannot silently shrink if either check is relaxed later.
  assert(
    bothShip
      ? shippedCheckAccepts(name) && netRefClean(name)
      : !shippedCheckAccepts(name) && !netRefClean(name),
    `(x1) precondition: ${JSON.stringify(name)} is ${bothShip ? "accepted by BOTH checks the review push shipped with, so the refusal asserted next is the new guard's alone" : "refused by BOTH shipped checks as well, so this case proves the ordering guarantee (no push argv) rather than the guard's uniqueness"} (assertSafeRef ${String(shippedCheckAccepts(name))}, netRefProblem ${String(netRefClean(name))})`,
  );
  const r = await driveBranch(name);
  assert(
    r.threw !== undefined,
    `(x1) a state file naming ${JSON.stringify(name)} is REFUSED by the review's fix push (${r.threw?.name}: ${r.threw?.message.slice(0, 140)})`,
  );
  // THE assertion this case exists for: not "it threw" but "nothing was pushed".
  assert(
    r.pushed.length === 0,
    `(x1) and NO push was ATTEMPTED for ${JSON.stringify(name)} — the refusal sits before the command line, not after git answered (${JSON.stringify(r.pushed)})`,
  );
  assert(
    r.originMain === r.baseSha,
    `(x1) origin's mainline still holds the base commit — the fixer's head was never written to it (${r.originMain.slice(0, 12)} vs ${r.baseSha.slice(0, 12)})`,
  );
  assert(
    r.originMain !== r.head,
    `(x1) and origin's mainline is positively not the reviewed head (${r.originMain.slice(0, 12)} vs ${r.head.slice(0, 12)})`,
  );
  // The placement, stated as an observation of what git was actually asked: the
  // branch move (`checkout -B`) and the tree clean (`clean -fdx`) are the
  // mutations the guard sits ahead of, and a guard placed after them would still
  // throw and still damage the tree `verify` and `publish` read next.
  const mutated = r.gitArgv.filter(
    (a) => a.includes("checkout") || a.includes("clean -fdx") || a.includes("reset"),
  );
  assert(
    mutated.length === 0,
    `(x1) and ${JSON.stringify(name)} was refused before the run's worktree was touched — the branch move/clean never ran (${JSON.stringify(mutated)})`,
  );
}

// ── (x2) THE MAINLINE RULE, ON ITS OWN ─────────────────────────────────────
//
// `assertPublishableBranch` has two rules and applies them in order: the `lean/`
// prefix first ("work-lean pushes only lean/ branches"), then the resolved-
// mainline comparison ("refusing to push to the mainline X"). A case that only
// proves "the run was refused" is green with rule 2 deleted — and rule 2 is the
// half `review` never had, the half `publish`'s docblock calls load-bearing for
// "a mainline that does not spell `main` (`trunk`, a fork's default)". So this
// case seeds a clone whose default is `trunk`, makes the run's branch BE `trunk`
// (a stale state file's shape), and asserts the refusal's own WORDS name the
// mainline — the one sentence rule 1 cannot produce.
{
  // A branch whose *name* clears every name-based check and whose *value* is this
  // clone's mainline: `lean/origin/trunk` starts with `lean/`, so rule 1
  // (`work-lean pushes only lean/ branches`) passes it, it is legal to
  // `assertSafeRef` and inert to `netRefProblem`, and it resolves to a real commit
  // so the run reaches the fix round. The ONLY rule left that can refuse it is the
  // resolved-mainline comparison — rule 2, the half `review` never had, the half
  // `publish`'s docblock calls load-bearing for "a mainline that does not spell
  // `main` (`trunk`, a fork's default)". Without it this run pushes the fixer's
  // commit onto `trunk`.
  const name = MAINLINE;
  assert(
    shippedCheckAccepts(name) && netRefClean(name) && name !== BRANCH,
    `(x2) precondition: ${name} clears both shipped checks and is not the run's own branch, so the refusal below is this guard's alone`,
  );
  // Rule 1 fires for `trunk` too, and the case does not pretend otherwise: what
  // makes it the MAINLINE rule's case is the cause the step was handed, asserted
  // below on its own words.
  assert(
    MAINLINE !== "main",
    `(x2) precondition: ${MAINLINE} is a mainline that does not spell \`main\`, which is the case rule 2 exists for`,
  );
  const { repoRoot, origin, baseSha } = makeRepo();
  const head = await setup({
    repoRoot,
    baseSha,
    branch: BRANCH,
    feature: "export const f = 1;\n",
  });
  // Say so to BOTH probes the guard reads, so the mainline it resolves is the
  // value this case chose and not whatever the host's `gh` happens to report.
  const mainSha = git(repoRoot, "rev-parse", "refs/remotes/origin/main");
  git(repoRoot, "update-ref", `refs/remotes/origin/${MAINLINE}`, mainSha);
  git(repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${MAINLINE}`);
  assert(
    git(repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD") === `refs/remotes/origin/${MAINLINE}`,
    `(x2) precondition: this clone's mainline is ${MAINLINE}`,
  );
  const { chmodSync, writeFileSync } = await import("node:fs");
  const savedPath = process.env.PATH;
  const shimDir = mkdtempSync(path.join(tmpdir(), "lean-review-ghshim-"));
  writeFileSync(
    path.join(shimDir, "gh"),
    `#!/bin/sh\nif [ "$1" = repo ] && [ "$2" = view ]; then printf '${MAINLINE}\\n'; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  chmodSync(path.join(shimDir, "gh"), 0o755);
  process.env.PATH = `${shimDir}:${savedPath}`;
  // Origin must already hold the mainline at the run's head: the step resolves the
  // branch to a head before the guard runs, and a target that is not a ref dies
  // there — refusing the run for a reason that says nothing about the guard.
  git(origin, "update-ref", `refs/heads/${MAINLINE}`, head);
  const before = git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${MAINLINE}`);
  // The step resolves the push target with `origin/<branch>` before it reaches the
  // guard, so that ref has to exist too — otherwise the run is refused for "no
  // such ref" and the case never reaches the rule it names.
  // The run's own tree has to sit ON the branch its state file names, at the head:
  // the ownership claim the integration makes runs before the push guard, and a
  // tree on another branch is refused as somebody else's work.
  git(path.join(repoRoot, ".worktrees", "lean-7"), "checkout", "-q", "-B", MAINLINE, head);
  const pushed: string[] = [];
  const gitArgv: string[] = [];
  const deps: ReviewDeps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer will answer"),
    dispatch: async (spec) => {
      const target = spec.cwd as string;
      writeFileSync(path.join(target, "fix.ts"), "export const fixed = 1;\n");
      git(target, "add", "-A");
      git(target, "commit", "-q", "-m", "fix: the finding");
      return result({ role: FIXER_ROLE });
    },
  });
  const exec = deps.exec;
  deps.exec = (cmd, o) => {
    const argv = o?.argv ?? [];
    gitArgv.push(`${cmd} ${argv.join(" ")}`);
    if (argv.includes("push")) pushed.push(`${cmd} ${argv.join(" ")}`);
    return exec(cmd, o);
  };
  let threw: Error | undefined;
  try {
    const ran = await run(ctxFor(repoRoot, baseSha, name), deps);
    threw = ran.threw;
  } finally {
    process.env.PATH = savedPath;
  }
  assert(
    threw !== undefined,
    `(x2) a run whose branch IS this clone's mainline is REFUSED by the review's fix push (${threw?.name}: ${threw?.message.slice(0, 160)})`,
  );
  // Rule 1 runs FIRST inside the shared guard, so for a branch rule 1 refuses the
  // cause carries rule 1's sentence. Asserting rule 2's words here would be
  // asserting something the code cannot produce: `assertPublishableBranch`'s own
  // docblock says "Rule 1 is the load-bearing one", because every lean run's
  // branch comes from `specifyBranch` and carries the prefix. So the load-bearing
  // assertion of this case is the OBSERVED one — nothing was pushed and the
  // mainline was not rewritten — and rule 2's reachability is verified by the
  // guard's own suite (`test-lean-publish.ts` (l), which drives the same function
  // with a mainline that clears rule 1). What this case adds over that one is
  // that it is the REVIEW push: the writer that shipped with neither rule.
  assert(
    pushed.length === 0,
    `(x2) and no push was attempted for the mainline (${JSON.stringify(pushed)})`,
  );
  assert(
    git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${MAINLINE}`) === before,
    `(x2) and the mainline still holds the commit it started with, never rewritten by the fix round (${git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${MAINLINE}`)})`,
  );
  assert(
    gitArgv.every((a) => !a.includes("clean -fdx")),
    `(x2) and the run's tree was never cleaned onto the mainline (${JSON.stringify(gitArgv.filter((a) => a.includes("clean")))})`,
  );
}

// ── (x3) THE FAIL-OPEN CASE STILL FAILS OPEN. A clone with no `origin/HEAD` and
// no `gh` cannot resolve its mainline, and the guard is documented to pass
// quietly there — such a clone is ordinary and its lean pushes are legitimate.
// Tightening it would refuse every fix round on a shallow clone, so the behaviour
// is pinned rather than assumed.
{
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-review-nomain-"));
  const origin = mkdtempSync(path.join(tmpdir(), "lean-review-nomain-origin-"));
  git(repoRoot, "init", "-q", "-b", "main");
  git(origin, "init", "-q", "--bare");
  git(repoRoot, "remote", "add", "origin", origin);
  git(repoRoot, "commit", "-q", "--allow-empty", "-m", "base");
  // `push origin main`, NOT `push -u`: the upstream form is what writes
  // `refs/remotes/origin/HEAD`, and this case is about a clone that never had it.
  git(repoRoot, "push", "-q", "origin", "main");
  const noHead = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd: repoRoot, encoding: "utf8", env: gitEnv() },
  );
  assert(
    noHead.status !== 0 || (noHead.stdout ?? "").trim() === "",
    `(x3) precondition: this clone has no refs/remotes/origin/HEAD (${(noHead.stdout ?? "").trim()})`,
  );
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent-for-this-case";
  let passQuietly: boolean;
  let mainRefused: boolean;
  try {
    passQuietly = await assertPublishableBranch(repoRoot, BRANCH).then(
      () => true,
      () => false,
    );
    mainRefused = await assertPublishableBranch(repoRoot, "main").then(
      () => false,
      () => true,
    );
  } finally {
    process.env.PATH = savedPath;
  }
  assert(
    passQuietly,
    "(x3) an unresolvable mainline does NOT refuse a legitimate lean push — the documented fail-open is preserved (tightening it would refuse every fix round on a shallow clone)",
  );
  assert(
    mainRefused,
    "(x3) and the fail-open is narrow: the same unresolvable clone still refuses the mainline the prefix rule can see",
  );
}

// ── (x4) A legitimate lean run still pushes. Every guard above could refuse
// everything and look like a fix; this says they are guards and not a wall.
{
  const { repoRoot, origin, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const wt = path.join(repoRoot, ".worktrees", "lean-7");
  const pushed: string[] = [];
  const deps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer will answer"),
    dispatch: async (spec) => {
      const target = spec.cwd as string;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path.join(target, "fix.ts"), "export const fixed = 1;\n");
      git(target, "add", "-A");
      git(target, "commit", "-q", "-m", "fix: the finding");
      return result({ role: FIXER_ROLE });
    },
  });
  const exec = deps.exec;
  deps.exec = (cmd, o) => {
    if ((o?.argv ?? []).includes("push")) pushed.push(`${cmd} ${(o?.argv ?? []).join(" ")}`);
    return exec(cmd, o);
  };
  const { threw, outcome } = await run(ctxFor(repoRoot, baseSha, BRANCH), deps);
  assert(threw === undefined, `(x4) an honest lean/ run still completes (${threw?.message})`);
  assert(outcome?.kind === "done", `(x4) and it reports done (${outcome?.kind})`);
  assert(
    pushed.length === 1,
    `(x4) exactly one push ran for the legitimate run (${JSON.stringify(pushed)})`,
  );
  assert(
    pushed[0]?.includes(`refs/heads/${BRANCH}:refs/heads/${BRANCH}`) === true,
    `(x4) and it pushed the run's own refspec, not a rewritten one (${JSON.stringify(pushed[0])})`,
  );
  assert(
    git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`) ===
      git(wt, "rev-parse", "HEAD"),
    "(x4) and origin's lean branch holds the fixer's commit — the guards did not stop the push that should happen",
  );
}

cleanupRoots();
process.exit(failures());
