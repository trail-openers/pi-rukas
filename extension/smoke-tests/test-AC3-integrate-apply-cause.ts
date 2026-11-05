#!/usr/bin/env bun
/**
 * AC3 (#2030) — what `causeFromIntegrateFailure` says when integrate() failed
 * while APPLYING the consolidation.
 *
 * `integrate()` already reports the structured discriminator `failure: "apply"`
 * for both the cherry-pick-conflict and the patch-apply arms, and the
 * `CommitPrFallbackCause` union already carries `"apply-conflict"`. The
 * classifier dropped the discriminator on the floor: every apply failure was
 * reported to the operator as `other`, so a conflict park blamed the change
 * rather than the pick.
 *
 * Fails today on the "apply" → "apply-conflict" arms (the union gains no new
 * member: an unreadable discriminator still answers "other").
 *
 * The second block pins the OTHER half of the mapping by behaviour: the
 * commit-message publish refusal has its own discriminator, `apply-publish`,
 * and must keep answering `other`. It drives the fast-forward arm of
 * `integrate()` end to end against a real repo whose commit message the hygiene
 * guard refuses — the shape that used to return `"apply"` there and so made a
 * refused message look to the operator like a cherry-pick conflict.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { causeFromIntegrateFailure } from "../src/work-driver-commit-helpers.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import type { IntegrateResult } from "../src/work-driver-integrate.ts";
import { withEnv } from "./lib/env-scope.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";

const FILE = "test-AC3-integrate-apply-cause.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL ${FILE}: ${msg}`);
    exit = 1;
  }
}

const apply = (failure: string): IntegrateResult =>
  ({ ok: false, reason: "cherry-pick conflict — the batch was aborted.", failure } as IntegrateResult);

assert(
  causeFromIntegrateFailure(apply("apply")) === "apply-conflict",
  `integrate() failure "apply" maps to cause "apply-conflict" (got ${JSON.stringify(causeFromIntegrateFailure(apply("apply")))})`,
);
assert(
  causeFromIntegrateFailure(apply("dirty-repoRoot")) === "dirty-repoRoot",
  "the existing dirty-repoRoot mapping is unchanged",
);
assert(
  causeFromIntegrateFailure(apply("push-refused")) === "push-refused",
  "the existing push-refused mapping is unchanged",
);
// A failure with no discriminator is not an apply failure: it stays "other",
// so this is a mapping, not a catch-all.
assert(
  causeFromIntegrateFailure({ ok: false, reason: "unreadable" } as IntegrateResult) === "other",
  "an unreadable discriminator still answers \"other\" (no new union member)",
);
assert(
  causeFromIntegrateFailure(apply("apply-publish")) === "other",
  `the publish refusal keeps its own cause "other", never "apply-conflict" (got ${JSON.stringify(causeFromIntegrateFailure(apply("apply-publish")))})`,
);

// ── the fast-forward arm, driven end to end ────────────────────────────────
// A real repo, a dirty worktree, `fastForward: true`, and a commit message
// carrying a term the scratch denylist refuses. The refusal is the ONLY
// failure this run can produce (nothing here conflicts), so its cause is the
// whole question.
const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/** A synthetic term: it appears only in this file and this scratch denylist. */
const TERM = ["example", "private", "host"].join("-");

const scratchRoot = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "ac3-ff-publish-"));
const denylistPath = path.join(scratchRoot, "denylist");
writeFileSync(denylistPath, `# synthetic list\n${TERM}\n`, "utf8");

async function ffFixture(name: string) {
  const base = path.join(scratchRoot, name);
  const repo = path.join(base, "repo");
  const scratch = path.join(base, "scratch");
  mkdirSync(scratch, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", path.join(base, "origin.git")]);
  await execFileP("git", ["init", "--initial-branch=main", repo], { cwd: scratchRoot });
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", path.join(base, "origin.git")]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: sha } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = sha.trim();
  await git(repo, ["checkout", "-q", "-B", "feature/ff"]);
  const wt = path.join(base, "wt-a");
  await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
  // Uncommitted work in the worktree: the fast-forward path stages and
  // commits it, which is the commit the hygiene guard must refuse first.
  writeFileSync(path.join(wt, "new.txt"), "work\n");
  return { repo, scratch, baseSha, worktrees: { a: wt } };
}

await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath }, async () => {
  resetDenylistCacheForTests();
  const f = await ffFixture("ff-publish-refusal");
  const r = await integrate(realExec, {
    repoRoot: f.repo,
    branchName: "feature/ff",
    baseSha: f.baseSha,
    worktrees: f.worktrees,
    scratchDir: f.scratch,
    commitTitle: `feat: mention ${TERM}`,
    commitBody: "body",
    mode: "followup",
    fastForward: true,
    issue: 2030,
  });
  assert(!r.ok, `the fast-forward publish refusal parks (got ${r.ok ? "ok" : `"${r.failure}"`})`);
  assert(
    !r.ok && r.failure === "apply-publish",
    `the fast-forward refusal carries its own discriminator (got ${JSON.stringify(r.ok ? undefined : r.failure)})`,
  );
  assert(
    !r.ok && causeFromIntegrateFailure(r) !== "apply-conflict",
    `a refused commit message is not reported to the operator as a conflict (got ${JSON.stringify(r.ok ? undefined : causeFromIntegrateFailure(r))})`,
  );
});

rmSync(scratchRoot, { recursive: true, force: true });

console.log(`\nexit ${exit}`);
process.exit(exit);
