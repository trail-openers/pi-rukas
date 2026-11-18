/**
 * test-reviewer-unisolated-spawn-2352 — the stamp the fail-open puts on the child
 * (#2352 C2, the other half of test-reviewer-unisolated-roots-2352.ts).
 *
 * `runWithReviewerTree` fails open twice: HEAD does not resolve, or git refuses the
 * tree. In both cases the child is dispatched at the reviewed cwd — and the guard
 * makes that cwd writable, so a reviewer that lost its isolation kept the write
 * access an isolated reviewer has. The spawn is the only site that knows which case
 * it is in, so the spawn says so: the child's env carries the marker the guard reads.
 *
 * Driven the way `test-reviewer-tree-code-index.ts` drives the same function — a real
 * temp repo, a capturing dispatch, no Pi child — with the two fail-opens provoked for
 * real rather than imitated: a non-repo cwd leaves HEAD unresolvable, and the
 * operator's `PI_ENSEMBLE_REVIEWER_ISOLATION=0` makes git refuse to be asked at all.
 */

import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UNISOLATED_CHILD_ENV } from "../src/reviewer-tree.ts";
import { runWithReviewerTree } from "../src/spawn-reviewer-isolation.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";
import { makeGit } from "./lib/reviewer-child-stub.ts";

const UNISOLATED = UNISOLATED_CHILD_ENV;

isolateLedger();
const gitEnv = gitTestEnv();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const main = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rev-2352-uni-")));
const git = makeGit(main, gitEnv);
git.run("init", "-q", "-b", "main");
writeFileSync(path.join(main, "f.txt"), "one\n");
git.run("add", "-A");
git.run("-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-q", "-m", "base");

/** What the dispatch was about to hand the child, had there been one. */
async function capture(role: string, cwd: string) {
  let seen: DispatchSpec | undefined;
  await runWithReviewerTree({ role, prompt: "REVIEW THIS", cwd }, async (s) => {
    seen = s;
    return { role, ok: true, text: "", toolUses: [] } as unknown as DispatchResult;
  });
  return seen as DispatchSpec;
}

// ── The isolated path: no marker, and the relocated cwd.
const isolated = await capture("adversarial-developer", main);
assert(
  isolated.cwd !== main && isolated.cwd.startsWith(os.tmpdir()),
  "the isolated reviewer was relocated to a tree under TMPDIR",
);
assert(
  isolated.failOpen === undefined,
  "an isolated reviewer is not told it was left in the reviewed tree",
);

// ── Fail-open 1: HEAD does not resolve (a cwd that is not a repo).
const notARepo = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rev-2352-norepo-")));
const headless = await capture("code-review-specialist", notARepo);
assert(headless.cwd === notARepo, "HEAD that will not resolve leaves the child in the reviewed cwd");
assert(
  headless.failOpen === true,
  "the fail-open marks that child's spec, so the spawn can stamp it",
);

// ── Fail-open 2: the operator's opt-out (git is never asked for a tree).
process.env.PI_ENSEMBLE_REVIEWER_ISOLATION = "0";
try {
  const opted = await capture("adversarial-developer", main);
  assert(opted.cwd === main, "the opt-out leaves the child in the reviewed tree");
  assert(opted.failOpen === true, "and that fail-open marks the spec too");
} finally {
  delete process.env.PI_ENSEMBLE_REVIEWER_ISOLATION;
}

// ── A non-reviewer role is nobody's business here: untouched spec.
const plain = await capture("developer", main);
assert(
  plain.cwd === main && plain.failOpen === undefined,
  "a non-reviewer's spec is passed through unchanged",
);

// ── The stamp itself: the name the guard reads, and the value it reads.
assert(
  UNISOLATED === "PI_ENSEMBLE_REVIEWER_UNISOLATED",
  "the marker's name is the one the guard reads",
);
assert(
  /childEnv\[UNISOLATED_CHILD_ENV\] = "1"/.test(
    await Bun.file(path.resolve(import.meta.dirname, "..", "src", "spawn-child-env.ts")).text(),
  ),
  "buildChildEnv is the site that writes it onto the child's env",
);

process.exit(exit);
