#!/usr/bin/env bun
/**
 * lean/challenge — a round leaves no bytes behind (#2074).
 *
 * `challengePrompt` tells the adversary to leave its files in the tree and let
 * the parent commit; the pipeline then resets to the head the round started at
 * and commits only what the red proof proved red. A round whose submitted rows
 * were ALL refused returns from that boundary as `empty` WITHOUT reaching the
 * reset, so whatever the child wrote was still in the tree when `verify` arrived,
 * and `verifyOutcome` died on its clean-tree gate with "refusing to verify
 * uncommitted bytes". The step now sweeps what is left, to the CURRENT head so a
 * commit the round did make survives, and says in the reason which paths went.
 * (The budget stop already reset its own tree; `test-lean-challenge-budget-clean
 * .ts` owns that path.)
 *
 *   (a) every submitted row refused -> `none`, HEAD unmoved, `git status
 *       --porcelain -uall` EMPTY, and both discarded paths named in the reason.
 *   (e) an `empty` round whose child committed its own file -> HEAD is back at
 *       `headBefore` and the tree is clean; the names in the reason are the raw
 *       `-z` paths (quoted, renamed and non-ASCII names included).
 *   (b) a committed round -> `new-tests`, HEAD moved by exactly one commit
 *       holding only the proved-red file, a clean tree, and NO extra reset: the
 *       sweep must never undo the commit the round just made.
 *   (c) a budget stop still makes exactly ONE reset, so the sweep does not double
 *       the reset that stop already did.
 *   (d) a sweep whose reset cannot run -> THROWS, never a verdict over a tree it
 *       failed to clean.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChallengeInfraError } from "../src/lean/challenge.ts";
import {
  ROOTS,
  challengeFixture,
  commitPaths,
  git,
  put,
  redEdge,
  runChallenge,
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

/** The child's own file: the round proves it red, or nothing keeps it. */
const RED = "tests/AC1-edge-red.test.sh";
/** A byte the child wrote and never declared to the step at all. */
const STRAY = "tests/AC1-stray-unsubmitted.test.sh";
/** The run's own frozen acceptance test — which the adversary must not rewrite. */
const FROZEN = "tests/AC1-retry.test.sh";

/** The fixture's log with AC1's quota already holding `seed` files. */
function seeded(issue: number, seed: string[]) {
  const built = challengeFixture(issue);
  const sp = built.ctx.run.steps.find((s) => s.state === "specify");
  if (sp?.outcome?.tests === undefined) throw new Error("fixture has no specify tests row");
  sp.outcome.tests.AC1 = seed;
  return built;
}

// --------- (a) the round kept NOTHING: the boundary refused every submitted row
{
  const issue = 2401;
  const r = await runChallenge({
    issue,
    // AC1's run-level quota is already full, so the round's only submission is
    // refused, and the child leaves a second file it never even declared.
    built: seeded(issue, ["tests/AC1-already-frozen.test.sh", "tests/AC1-other.test.sh"]),
    child: (wt) => {
      put(wt, STRAY, redEdge(STRAY), 0o755);
      // A rewrite of the contract the run inherited, refused at the boundary —
      // and a byte left standing as an edit `verify` would then re-run.
      put(wt, FROZEN, redEdge(FROZEN), 0o755);
    },
    toolUses: [submit("AC1", [RED, FROZEN])],
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "none", `(a) none, got ${r.outcome?.kind}`);
  assert(
    git(wt, "rev-parse", "HEAD") === r.headBefore,
    "(a) HEAD is where the step found it — nothing was committed",
  );
  assert(status(wt) === "", `(a) no uncommitted bytes for verify (got ${status(wt)})`);
  assert(existsSync(`${wt}/${STRAY}`) === false, "(a) the undeclared byte is gone");
  assert(existsSync(`${wt}/${FROZEN}`) === true, "(a) the run's frozen test is still there");
  assert(
    git(wt, "status", "--porcelain", "-uall", "--", FROZEN) === "",
    "(a) and holds the commit's bytes, not the adversary's rewrite",
  );
  // The reset must be proven by what git RAN, not by the reason's wording: a
  // clean tree is also what a no-op returns, and a no-op is the bug (#2074).
  const resets = (argvs: string[][]): number =>
    argvs.filter((a) => a.includes("reset") && a.includes("--hard")).length;
  assert(
    resets(r.gitArgvs) === 1,
    `(a) the sweep really reset the tree — not a no-op that only LOOKS clean (got ${resets(r.gitArgvs)})`,
  );
  const reason = r.outcome?.reason ?? "";
  // The reason is the only place a child learns that a file it was told was
  // "recorded" never entered the contract: the boundary's refusal in its own
  // vocabulary, and the bytes this step's sweep removed.
  assert(
    reason.includes("no test file the step could keep") &&
      reason.includes(FROZEN) &&
      reason.includes("is a frozen acceptance test"),
    `(a) the boundary's refusal is named in its own words (got ${reason})`,
  );
  assert(
    reason.includes("discarded 2: ") && reason.includes(STRAY) && reason.includes(FROZEN),
    `(a) and the step names both bytes its sweep removed (got ${reason})`,
  );
}

// --------- (e) the sweep goes back to `headBefore`, not to whatever HEAD says now.
// An `empty` round committed NOTHING, so a commit above `headBefore` is the
// child's own — an unjudged file that reached HEAD through `git commit`, the one
// route a dirty-tree check cannot see. A sweep to a re-read HEAD would keep it,
// and `verify` would then re-run bytes nobody proved red. The same round also
// names quoted, renamed and non-ASCII paths verbatim: they come from the `-z`
// reader, so git's C-quoting never reaches the reason.
{
  const issue = 2404;
  const committed = "tests/AC1-child-committed.test.sh";
  const r = await runChallenge({
    issue,
    built: seeded(issue, ["tests/AC1-already-frozen.test.sh", "tests/AC1-other.test.sh"]),
    child: (wt) => {
      put(wt, committed, redEdge(committed), 0o755);
      git(wt, "add", "--", committed);
      git(wt, "commit", "-q", "-m", "unjudged work the round never declared");
      // A rename git detects only because both sides hold the same bytes.
      put(wt, "tests/AC1-renamed-from.test.sh", redEdge("renamed"), 0o755);
      git(wt, "add", "-A", "--", "tests/AC1-renamed-from.test.sh");
      git(wt, "commit", "-q", "-m", "the file that gets renamed");
      git(wt, "mv", "tests/AC1-renamed-from.test.sh", "tests/AC1-renamed-to.test.sh");
      put(wt, 'tests/"AC1 odd, quoted".test.sh', redEdge("quoted"), 0o755);
      put(wt, "tests/AC1-caf\u00e9.test.sh", redEdge("caf\u00e9"), 0o755);
    },
    // A name the boundary has no reason to refuse, declared under a criterion
    // whose run-level quota is already full — so the round ends `empty`, and the
    // commits the child made on its own are still sitting above `headBefore`.
    toolUses: [submit("AC1", [committed])],
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(e) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "none", `(e) none, got ${r.outcome?.kind}`);
  assert(
    git(wt, "rev-parse", "HEAD") === r.headBefore,
    `(e) HEAD is back at the head the step found (got ${git(wt, "rev-parse", "HEAD")})`,
  );
  assert(
    subjectsAbove(wt, r.headBefore).join() === "",
    `(e) no commit is left above it (got ${subjectsAbove(wt, r.headBefore).join(" | ")})`,
  );
  assert(existsSync(`${wt}/${committed}`) === false, "(e) the file only that commit held is gone");
  assert(status(wt) === "", `(e) and the tree is clean for verify (got ${status(wt)})`);
  const reason = r.outcome?.reason ?? "";
  assert(
    reason.includes('tests/"AC1 odd, quoted".test.sh'),
    `(e) a name git would otherwise quote is named verbatim (got ${reason})`,
  );
  assert(
    reason.includes("tests/AC1-renamed-from.test.sh") &&
      reason.includes("tests/AC1-renamed-to.test.sh"),
    `(e) both sides of a rename are named (got ${reason})`,
  );
  assert(
    reason.includes("tests/AC1-caf\u00e9.test.sh") && !reason.includes('"tests/AC1-caf'),
    `(e) a non-ASCII name is not C-quoted into something that does not exist (got ${reason})`,
  );
}

// ------- (b) the sweep must never undo a commit the round made. The pipeline
// proves a committed round's tree clean (step 3 resets it and writes back only
// the red bytes), so this is the OTHER half of the fix: a sweep that ran a second
// reset here would move the branch back to the head the round started at and
// silently throw away the test it just froze.
{
  const issue = 2402;
  const r = await runChallenge({
    issue,
    child: (wt) => {
      put(wt, RED, redEdge(RED), 0o755);
    },
    toolUses: [submit("AC1", [RED])],
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(b) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "new-tests", `(b) new-tests, got ${r.outcome?.kind}`);
  assert(
    subjectsAbove(wt, r.headBefore).join() === `test: challenge tests for #${issue}`,
    `(b) exactly one commit above the head the step found (got ${subjectsAbove(wt, r.headBefore).join(" | ")})`,
  );
  assert(
    commitPaths(wt).join() === RED,
    `(b) that commit holds ONLY the proved-red file (got ${commitPaths(wt).join(", ")})`,
  );
  assert(existsSync(`${wt}/${RED}`) === true, "(b) the file the round froze is still in the tree");
  assert(status(wt) === "", `(b) no uncommitted bytes for verify (got ${status(wt)})`);
  const reason = r.outcome?.reason ?? "";
  // (1) The committed round's bytes are the pipeline's own work, so the sweep
  // adds NO git call at all here: a reset over a committed round would move the
  // branch back to the head the round started at and throw the test it just froze
  // away. (2) `discarded` is the sweep's word alone — the pipeline's own drop
  // notes say `dropped` — so a reason claiming a discard this step did not make is
  // a false account of the round, and resets links the next step still needs.
  const calls = (argvs: string[][]): number =>
    argvs.filter((a) => a.some((x) => /^(reset|clean|checkout)$/.test(x))).length;
  // Two identical committed rounds, run separately. The one whose sweep is DISABLED
  // must make the exact same git calls in the exact same order as the shipped one:
  // a sweep that really ran would add a reset, push the branch back to the head the
  // round started at, and lose the test it just froze.
  const shape = (argvs: string[][]): string =>
    argvs
      .map((a) =>
        a
          .join(" ")
          .replace(/lean\/issue-\d+/g, "lean/issue-N")
          .replace(/[0-9a-f]{40}/g, "<sha>")
          .replace(/#\d+/g, "#N"),
      )
      .join("\n");
  const unswept = await runChallenge({
    issue: 2406,
    child: (wt) => {
      put(wt, RED, redEdge(RED), 0o755);
    },
    toolUses: [submit("AC1", [RED])],
  });
  assert(
    calls(r.gitArgvs) === calls(unswept.gitArgvs) && shape(r.gitArgvs) === shape(unswept.gitArgvs),
    `(b) the sweep adds NO git call to a committed round — identical argv, same order (${calls(r.gitArgvs)} reset/clean/checkout calls both ways)`,
  );
  assert(
    reason.includes("froze 1 red test file(s)") && !reason.includes("discarded"),
    `(b) and the reason claims no discard it did not make (got ${reason})`,
  );
}

// ------- (c) the sweep must not run a SECOND reset over a stopped round's tree.
// `test-lean-challenge-budget-clean.ts` owns "a stopped round leaves a clean
// tree and its dependency links"; this pins only what that file cannot see — the
// sweep would take the links the stop has just provisioned.
{
  const resets = (argvs: string[][]): number =>
    argvs.filter((a) => a.includes("reset") && a.includes("--hard")).length;
  const stopped = await runChallenge({
    issue: 2403,
    child: (wt) => {
      put(wt, STRAY, redEdge(STRAY), 0o755);
    },
    challengeMinutes: 15,
  });
  assert(stopped.outcome?.kind === "budget", "(c) the stop still reports budget");
  assert(
    status(stopped.worktree) === "",
    `(c) and leaves a clean tree (got ${status(stopped.worktree)})`,
  );
  assert(
    resets(stopped.gitArgvs) === 1,
    `(c) exactly ONE reset, the stop's own — never a second over the tree it cleaned (got ${resets(stopped.gitArgvs)})`,
  );
}

// --------- (d) a sweep that cannot reset THROWS rather than reporting a verdict
// over a tree it failed to clean. An unremovable byte is git refusing to say it
// went, and `none` or `budget` over that tree is the step certifying dirt it only
// believes is gone; `verify` would then crash on it. The class is asserted, not
// the message — `none` and a throw route to opposite places in the machine.
{
  const built = challengeFixture(2407);
  const blocked = path.join(built.worktree, "blocked");
  mkdirSync(blocked, { recursive: true });
  writeFileSync(path.join(blocked, "stuck.sh"), "#!/usr/bin/env bash\n");
  const canBlock = process.getuid !== undefined && process.getuid() !== 0;
  if (canBlock) chmodSync(blocked, 0o500);
  const r = await runChallenge({ issue: 2407, built, toolUses: [] });
  if (canBlock) chmodSync(blocked, 0o700);
  assert(
    canBlock || r.threw === undefined,
    "(d) skipped on a host that cannot make a directory unwritable (root)",
  );
  assert(
    canBlock && r.threw instanceof ChallengeInfraError,
    `(d) the failed sweep throws ChallengeInfraError, not a verdict (got ${r.threw?.name ?? `kind=${r.outcome?.kind}`})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
