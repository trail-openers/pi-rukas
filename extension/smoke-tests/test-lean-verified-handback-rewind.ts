/**
 * test-lean-verified-handback-rewind — the rewind alone, against a real origin.
 *
 * These three cases are the git contract of `src/lean/handback-rewind.ts`, with no
 * step, no comment and no record in the way: does a landed rewind move the branch to
 * the verified head AND keep the head it moved off, does a lease bound to the head
 * this step read refuse a branch somebody else moved, and does a head that is not a
 * sha move nothing at all. Each assertion is read back off ORIGIN with `ls-remote`,
 * because the porcelain's exit code is exactly what a rewind can get right while
 * pushing nothing — git answers `Everything up-to-date` for a non-fast-forward
 * refspec it declined to force.
 *
 * The rule's reading of the log and the reporting step that prints the heads are
 * `test-lean-verified-handback.ts`; this file is the half that touches the wire.
 */

import {
  unverifiedRef,
  NO_HEAD,
  rewindToVerified,
} from "../src/lean/handback-rewind.ts";
import { rmSync } from "node:fs";
import {
  BRANCH,
  ISSUE,
  ROOTS,
  exec,
} from "./lib/lean-verified-handback-fixture.ts";
import {
  originBranchSha,
  originRefSha,
  repoWithFixHead,
  strangerOnTop,
} from "./lib/lean-verified-handback-repo.ts";
import type { Rewind } from "../src/lean/handback-rewind.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function show(r: Rewind): string {
  return JSON.stringify([r.shipped, r.unshippedHead ?? null, r.reason ?? null]);
}

/** The rewind seam the cases drive: the real rewind over the real origin. */
function rewinder(repoRoot: string): (verifiedHead: string) => Promise<Rewind> {
  return (verifiedHead) =>
    rewindToVerified(
      exec,
      { repoRoot, issue: ISSUE, run: { branch: BRANCH } } as never,
      verifiedHead,
    );
}

// ── the rewind lands: branch back, unverified head kept ─────────────────────
{
  const repo = repoWithFixHead();
  // The head the run pushed, read back BEFORE the move: that is the head the lease
  // is bound to and the head the keeping-ref must hold afterwards.
  const pushed = originBranchSha(repo.origin);
  const rewind = await rewinder(repo.repoRoot)(repo.baseSha);
  assert(rewind.shipped, `(e) the rewind reports it shipped (${show(rewind)})`);
  assert(
    originBranchSha(repo.origin) === repo.baseSha,
    `(e) origin's branch now holds the VERIFIED head (${String(originBranchSha(repo.origin))})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === pushed,
    `(e) the head the run pushed is kept under ${unverifiedRef(ISSUE)} (${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
  assert(
    rewind.unshippedHead === pushed,
    `(e) the record names the head it moved off (${String(rewind.unshippedHead)})`,
  );
}

// ── the lease refuses: origin moved behind lean's back ──────────────────────
{
  const repo = repoWithFixHead();
  // Somebody else pushed to the branch after lean's head, so origin no longer holds
  // what this run pushed. Rewinding it would rewrite their work — and the stranger
  // has to arrive from another clone, because a push made in THIS clone leaves its
  // remote-tracking ref in the state that makes the lease succeed.
  const stranger = strangerOnTop(repo, repo.branchHeadSha, "someone else's work");
  if (originBranchSha(repo.origin) !== stranger)
    throw new Error(
      `the stranger push did not land: origin holds ${String(originBranchSha(repo.origin))}, not ${stranger}`,
    );
  const rewind = await rewinder(repo.repoRoot)(repo.baseSha);
  assert(!rewind.shipped, `(f) a moved branch is not this run's to rewrite (${show(rewind)})`);
  assert(
    originBranchSha(repo.origin) === stranger,
    `(f) origin's branch did not move (${String(originBranchSha(repo.origin))} vs ${stranger})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    `(f) and a refused rewind wrote no keeping-ref either (${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
  assert(
    (rewind.reason ?? "").includes("the lease refused the rewind"),
    `(f) the record says the lease refused (${String(rewind.reason)})`,
  );
}

// ── no verified head: nothing moves ─────────────────────────────────────────
{
  const repo = repoWithFixHead();
  const before = originBranchSha(repo.origin);
  // The head the run pushed is what a refusal must still name, and it is the head
  // a move would have had to keep: read it before anything can move it.
  const pushed = before;
  const rewind = await rewinder(repo.repoRoot)("not-a-sha");
  assert(!rewind.shipped, `(g) a head that is not a sha moves nothing (${show(rewind)})`);
  assert(originBranchSha(repo.origin) === before, "(g) origin's branch is exactly where it was");
  assert(
    rewind.unshippedHead === pushed,
    `(g) and the record still names the unverified head it left there (${String(rewind.unshippedHead)})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    "(g) and no keeping-ref was written for a move that never happened",
  );
  assert(
    NO_HEAD.shipped === false && (NO_HEAD.reason ?? "").includes("no verified head"),
    `(g) the no-head answer is the one the step prints (${String(NO_HEAD.reason)})`,
  );
}

for (const dir of ROOTS.splice(0)) rmSync(dir, { recursive: true, force: true });

process.exit(exit);
