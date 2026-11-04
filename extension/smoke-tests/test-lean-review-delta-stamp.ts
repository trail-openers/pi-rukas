#!/usr/bin/env bun
/**
 * lean/review-deps — an explicit-`since` re-review must arrive STAMPED.
 *
 * The `lens` seam builds the `LensRound` the `review` step reads, and it does so
 * FIELD BY FIELD. `deltaReview` is one of `LensRound`'s `Pick<>`ed layer fields
 * (`review-args.ts`), so the compiler could not catch its omission — `Pick<>`
 * keeps the TYPE, and a hand-written return literal that never mentions the key
 * still compiles. It shipped that way: the re-review of the fix wave reached
 * `assertRangedOverTheFix` with no stamp and the step handed the run back with
 * "reported ISSUES_FOUND without stamping the range it ranged over", because the
 * layer's own range (`git diff <since>..<head>`) was dropped between the summary
 * and the round.
 *
 * Every assertion is on what the seam DELIVERED to the step, captured off the
 * round it returned — and the round came out of the REAL `runLensReview` over a
 * REAL git repo, with only the lens children stubbed. A stub that stamped by hand
 * would pass with the bug present: the stamp is exactly what the buggy seam
 * deleted, so the test has to take it from the layer.
 */

import { exec } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { reviewDeps } from "../src/lean/review-deps.ts";
import type { runLensChild } from "../src/lens-review-child.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const execp = promisify(exec);

const BRANCH = "lean/review-round-2";

/**
 * The run's shape, built from nothing but `git init`: a bare origin carrying
 * `main`, and a clone whose run branch is two commits past it.
 *
 * NOT a clone of this repo. The first version cloned the checkout it ran from
 * and branched off `origin/main`, and died on CI's checkout — a detached HEAD
 * with no local `main`, so the clone carried no `origin/main` to branch from
 * (`fatal: 'origin/main' is not a commit`). The fixture's verdict was a property
 * of the host's git state. Building the repo here makes every ref the layer
 * resolves (`main`, `origin/main`, the branch, both commits) one this fixture
 * created, which is also what makes the file runnable outside a git checkout.
 */
async function mkRunRepo(): Promise<{
  root: string;
  skills: string;
  dir: string;
  base: string;
  since: string;
  head: string;
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "lean-delta-stamp-"));
  const origin = path.join(root, "origin.git");
  const dir = path.join(root, "repo");
  // `gitTestEnv()` points the ambient env at an isolated git view (and returns
  // it for a threaded child), so the fixture's commits and the layer's own git
  // reads see the same host — never the operator's config (lib/git-test-env.ts).
  gitTestEnv();
  // Args are quoted because the command goes through a shell: an unquoted commit
  // subject with spaces reaches git as three arguments and fails as a pathspec.
  const G = (cwd: string, ...args: string[]) =>
    execp(`git ${args.map((a) => `'${a}'`).join(" ")}`, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
  await G(root, "init", "-q", "--bare", origin);
  mkdirSync(dir);
  await G(dir, "init", "-q", "-b", "main");
  await G(dir, "config", "user.email", "t@t");
  await G(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "base.ts"), "export const base = 0;\n");
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "base");
  const base = (await G(dir, "rev-parse", "HEAD")).stdout.trim();
  await G(dir, "remote", "add", "origin", origin);
  await G(dir, "push", "-q", "-u", "origin", "main");
  // The run branch, then two commits: `since` is the pre-fix head the step
  // re-reviewed FROM, `head` the tip the fix wave left. Two, not one, so the fix
  // range is a single commit and cannot be confused with the branch diff (which
  // carries the whole feature).
  await G(dir, "checkout", "-qb", BRANCH);
  writeFileSync(path.join(dir, "lean-delta-first.ts"), "export const first = 1;\n");
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "review: pre-fix head");
  const since = (await G(dir, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(path.join(dir, "lean-delta-fix.ts"), "export const fix = 2;\n");
  await G(dir, "add", "-A");
  await G(dir, "commit", "-q", "-m", "fix: the fix wave commit");
  const head = (await G(dir, "rev-parse", "HEAD")).stdout.trim();
  return { root, skills: installLensSkills(root), dir, base, since, head };
}

/**
 * The installed-skills dir the lens roster reads: one valid `SKILL.md` per
 * bundled lens.
 *
 * Pointing at this repo's own `skill/` dir worked only while the test ran from a
 * checkout, and the roster reading it made the round's completeness depend on the
 * host too. The fixture writes what the roster needs, the same shape
 * `lib/review-findings-fixtures.ts` installs; the bundled set is the expected one,
 * so `buildExpectedRoster` finds every lens installed and none blocked.
 */
function installLensSkills(root: string): string {
  const skills = path.join(root, "skills");
  let prec = 10;
  for (const l of LENS_ROSTER) {
    mkdirSync(path.join(skills, l.skill), { recursive: true });
    writeFileSync(
      path.join(skills, l.skill, "SKILL.md"),
      `---\nname: ${l.skill}\nprecedence: ${prec}\n---\n`,
    );
    prec += 10;
  }
  return skills;
}

/** A clean lens child: every lens answers with prose and no findings. Only the
 * CHILD is stubbed — the diff resolution, the delta decision and the summary are
 * the real layer's, which is where the stamp was being lost. */
const cleanLensChild: typeof runLensChild = async (args): Promise<LensRunResult> => ({
  lens: args.lens.name,
  ok: true,
  ms: 0,
  startMs: Date.now(),
  findings: [],
  attempts: 1,
  blocked: false,
  summary: "clean",
});

const dir0 = await mkRunRepo();
const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
const savedSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;

try {
  // The roster reads the installed skills dir, which CI does not have, and the
  // ledger must not land in a real clone: both are redirected INSIDE the try, so
  // the finally below restores the env however this body leaves it.
  process.env.PI_ENSEMBLE_SKILLS_DIR = dir0.skills;
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(dir0.root, "ledger.json");

  const deps = reviewDeps(false);
  deps.lensChildFn = cleanLensChild;
  // NO `lensEngine`: the seam must call the real `runLensReview`, which is where
  // the range is decided and where the stamp was being lost.
  const round = await deps.lens({
    base: dir0.base,
    head: dir0.head,
    branch: BRANCH,
    cwd: dir0.dir,
    wave: "fix",
    pr: undefined,
    since: dir0.since,
    context: "re-review of the fix wave's commits",
    issueBody: "body",
    evidence: undefined,
    extraFindings: [],
    headless: false,
    budget: { opts: {}, fired: () => undefined },
    threshold: "HIGH",
  });

  // (1) THE STAMP EXISTS. With the bug this is `undefined` and the step's guard
  // refuses the round, which is the handback this test exists to prevent.
  assert(
    round.deltaReview !== undefined,
    `(1) the re-review round carries deltaReview — the layer stamped the range it ranged over and the seam carried it to the step (captured ${JSON.stringify(round.deltaReview)}; absent is the bug: assertRangedOverTheFix refuses the round and the run hands back)`,
  );

  // (2) AND IT NAMES THE STEP'S OWN RANGE. Both bounds are compared with
  // `git rev-parse` by the guard, so they must be the commits the step handed in
  // — not the auto-delta base, not the branch head from an earlier read.
  assert(
    round.deltaReview?.since === dir0.since,
    `(2) the stamp's since is the since the seam was handed: ${dir0.since} (captured ${round.deltaReview?.since ?? "none"})`,
  );
  assert(
    round.deltaReview?.head === dir0.head,
    `(2) and its head is the head the seam was handed: ${dir0.head} (captured ${round.deltaReview?.head ?? "none"})`,
  );

  // (3) THE ROUND IS A DELTA ROUND, NOT A FULL REVIEW THAT FORGOT TO SAY SO. A
  // round that reviewed the whole branch would carry no stamp at all (case 1) or
  // the wrong one; and it must not be the automatic delta either — the step's
  // `since` is an instruction, not the ledger's suggestion.
  assert(
    round.noReview !== true,
    "(3) the round actually ran lenses (a no-review round would carry a stamp but reviewed nothing)",
  );
  assert(
    round.deltaReview?.auto === undefined,
    `(3) and the stamp is the step's explicit since, not the automatic delta base (${JSON.stringify(round.deltaReview)})`,
  );
} finally {
  if (savedLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
  else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = savedLedger;
  if (savedSkills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
  else process.env.PI_ENSEMBLE_SKILLS_DIR = savedSkills;
  rmSync(dir0.root, { recursive: true, force: true });
}

process.exit(failures());
