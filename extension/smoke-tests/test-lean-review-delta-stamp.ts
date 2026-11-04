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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { reviewDeps } from "../src/lean/review-deps.ts";
import type { BudgetArms } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const execp = promisify(exec);

const BRANCH = "lean/issue-1967";

/** A clone of this repo with the run's shape: a branch whose head is one commit
 * past `since`, in a clone that has an `origin/main`. Real commits, so the layer
 * resolves refs itself rather than trusting a fixture's word for them. */
async function mkRunRepo(): Promise<{ root: string; dir: string; base: string; since: string; head: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), "lean-delta-stamp-"));
  const dir = path.join(root, "repo");
  const G = (args: string) => execp(`git ${args}`, { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  // Clone THIS repo so the run has a real `origin/main` (the layer resolves a
  // mainline base, and a fixture without one silently loses the delta path).
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  await execp(`git clone -q --no-local ${repoRoot} ${dir}`);
  await G("config user.email t@t");
  await G("config user.name T");
  // A commit on the branch, then one more: `since` is the first, `head` the
  // second, so the fix range is exactly one commit and cannot be confused with
  // the branch diff (which carries the whole feature).
  await G(`checkout -qb ${BRANCH} origin/main`);
  writeFileSync(path.join(dir, "lean-delta-first.ts"), "export const first = 1;\n");
  await G("add -A");
  await G("commit -q -m 'review: pre-fix head'");
  const since = (await G("rev-parse HEAD")).stdout.trim();
  writeFileSync(path.join(dir, "lean-delta-fix.ts"), "export const fix = 2;\n");
  await G("add -A");
  await G("commit -q -m 'fix: the fix wave commit'");
  const head = (await G("rev-parse HEAD")).stdout.trim();
  const base = (await G("merge-base origin/main HEAD")).stdout.trim();
  return { root, dir, base, since, head };
}

/** A clean lens child: one lens, no findings. Only the CHILD is stubbed — the
 * diff resolution, the delta decision and the summary are the real layer's. */
const cleanLensChild = async () =>
  ({
    lens: "SECURITY",
    ok: true,
    ms: 0,
    startMs: Date.now(),
    findings: [],
    attempts: 1,
    blocked: false,
    summary: "clean",
  }) as never;

const dir0 = await mkRunRepo();
const savedLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
const savedSkills = process.env.PI_ENSEMBLE_SKILLS_DIR;
// The roster reads the installed skills dir, which CI does not have; the repo's
// own skill/ dir is the offline stand-in the other lens tests use.
process.env.PI_ENSEMBLE_SKILLS_DIR = path.resolve(import.meta.dirname, "..", "..", "skill");
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(dir0.root, "ledger.json");

try {
  const deps = reviewDeps(false);
  deps.lensChildFn = cleanLensChild as never;
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
    evidence: undefined,
    extraFindings: [],
    headless: false,
    budget: { opts: {}, fired: () => undefined } as unknown as BudgetArms,
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
