/**
 * test-lean-verified-handback-rewind — the rewind alone, against a real origin.
 *
 * These cases are the git contract of `src/lean/handback-rewind.ts`, with no step,
 * no comment and no record in the way: does a landed rewind move the branch to the
 * verified head AND keep the head it moved off, does a lease bound to the head this
 * step read refuse a branch somebody else moved, does a head that is not a sha move
 * nothing at all, and does origin already holding the verified head leave a record
 * that says so rather than one that cries refusal. Each assertion is read back off
 * ORIGIN with `ls-remote`, because the porcelain's exit code is exactly what a rewind
 * can get right while pushing nothing — git answers `Everything up-to-date` for a
 * non-fast-forward refspec it declined to force.
 *
 * The two arms of a refused push are deliberately two arms. A stranger pushed from a
 * repo the run's clone never fetched makes git fail on OBJECTS (`bad object`) before
 * it ever evaluates the lease; a lease the client evaluated prints `stale info`. A
 * refusal must not print the lease sentence for the first, or an operator told "the
 * lease refused" when git could not read a commit will hunt for a branch-thief that
 * does not exist. (f) pins the object arm, with the precondition that makes it that
 * arm checked rather than assumed.
 *
 * (f2) is the control on the other side of that line, and it is a case that has to be
 * honest about its own shape: a stranger pushed FROM the run's clone leaves that
 * clone's remote-tracking ref satisfied, so the lease matches and the rewind LANDS
 * over somebody else's commit. Verified against a real origin on git 2.53 — this is
 * not a refusal, and a case that asserted one here would be watching a rewrite and
 * calling it a gate. What it pins instead is the property that makes such a move
 * survivable: the displaced head reaches origin under the keeping-ref in the same
 * transaction that moved the branch.
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
  cloneHolds,
  commitOnTop,
  originBranchSha,
  originRefSha,
  repoWithFixHead,
  strangerOnTop,
} from "./lib/lean-verified-handback-repo.ts";
import { stepGitEnv } from "./lib/lean-review-fixtures.ts";
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

/**
 * The rewind seam the cases drive: the real rewind over the real origin.
 *
 * `net: true`, because that is how production drives it — `report-handlers.ts`
 * passes the non-interactive network env to the one call that leaves the clone.
 * Without it a push that git would have made over the wire instead dies in the
 * transport, and the case pins an infrastructure failure it invented.
 */
function rewinder(repoRoot: string): (verifiedHead: string) => Promise<Rewind> {
  return (verifiedHead) =>
    rewindToVerified(
      exec,
      { repoRoot, issue: ISSUE, run: { branch: BRANCH } } as never,
      verifiedHead,
      { net: true },
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
  // what this run pushed. Rewinding it would rewrite their work.
  const stranger = strangerOnTop(repo, repo.branchHeadSha, "someone else's work");
  if (originBranchSha(repo.origin) !== stranger)
    throw new Error(
      `the stranger push did not land: origin holds ${String(originBranchSha(repo.origin))}, not ${stranger}`,
    );
  // The precondition that makes THIS case the object case: the run's clone has never
  // seen the stranger, so git dies naming the object before the lease is evaluated.
  // Without it this case would silently become (f2) and both refusals would pin one.
  if (cloneHolds(repo.repoRoot, stranger))
    throw new Error(
      "the run's clone already holds the stranger's objects, so this case would not exercise the object failure it pins",
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
  // The wrong diagnosis this case exists to prevent: git never reached the lease, so
  // the record must not blame the lease.
  assert(
    !(rewind.reason ?? "").includes("the lease refused"),
    `(f) and the record does not blame a lease git never evaluated (${String(rewind.reason)})`,
  );
  assert(
    (rewind.reason ?? "").includes("the rewind push failed"),
    `(f) it names the push failure instead (${String(rewind.reason)})`,
  );
  assert(
    (rewind.reason ?? "").includes(stranger.slice(0, 12)),
    `(f) and names the head origin still holds (${String(rewind.reason)})`,
  );
}

// ── a satisfied lease over a moved branch: the move must still be reversible ─
{
  // The other side of the lease: `--force-with-lease` is enforced by the CLIENT
  // against the clone's remote-tracking ref, which this clone's own push refreshes. So
  // a stranger made by pushing from the run's clone is NOT a lease refusal — git
  // force-updates the branch and exits 0. The property worth pinning about that move
  // is that the head it displaced survives, which is what the keeping-ref is for.
  const repo = repoWithFixHead();
  const stranger = commitOnTop(repo.repoRoot, repo.branchHeadSha, "a stranger this clone itself moved");
  const moved = await exec("git", {
    argv: ["push", "-q", "--force", "origin", `${stranger}:refs/heads/${BRANCH}`],
    cwd: repo.repoRoot,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: stepGitEnv(),
  }).catch((err: unknown) => {
    throw new Error(`the stranger push failed: ${String((err as { stderr?: string })?.stderr ?? err)}`);
  });
  if (moved === undefined) throw new Error("the stranger push reported nothing");
  if (originBranchSha(repo.origin) !== stranger)
    throw new Error(`the stranger push did not land: ${String(originBranchSha(repo.origin))}`);
  // Read BEFORE the rewind runs: the rewind's own push refreshes this ref too, so read
  // afterwards it would just name whatever the step moved the branch to and prove
  // nothing. Read now, it shows the fact the case rests on — this clone's tracking ref
  // names the stranger, because this clone is the hand that put it there, and that is
  // why the lease below can be satisfied rather than refused.
  const tracked = await exec("git", {
    argv: ["rev-parse", "--verify", `refs/remotes/origin/${BRANCH}`],
    cwd: repo.repoRoot,
    timeout: 60_000,
    env: stepGitEnv(),
  }).catch(() => undefined);
  assert(
    tracked !== undefined && tracked.stdout.trim() === stranger,
    `(f2) control: this clone's tracking ref names the stranger, so the lease is satisfiable — (f)'s outside stranger is the one it cannot be (${String(tracked?.stdout.trim())})`,
  );
  const rewind = await rewinder(repo.repoRoot)(repo.baseSha);
  // The point of the control: the lease was SATISFIED, so this is a rewind that
  // force-updates a branch somebody else moved. The only thing that makes that
  // survivable is the keeping-ref — the displaced head has to be on origin by the
  // time the step is done, or the run has rewritten a public branch and lost the
  // commits it overwrote.
  assert(
    rewind.shipped && originBranchSha(repo.origin) === repo.baseSha,
    `(f2) where the lease this clone holds matches, the rewind lands (${show(rewind)})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === stranger,
    `(f2) and the head it displaced is kept on origin, not dropped (${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
  // And the reason (f) is the real refusal while this one is a permitted move: the
  // lease compares against this clone's remote-tracking ref, and in (f) the stranger
  // arrived from outside, leaving that ref naming the head this run pushed — which is
  // exactly what makes origin's own value the arbiter. The two cases together are what
  // keeps either from quietly standing in for the other.
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

// ── origin already holds the verified head: a move this step did not make ───
{
  // Reachable when a run is resumed after its branch was already rewound: a rewind
  // that died between its push and its read-back replays the step, and the replay
  // finds origin where the first attempt left it. No push runs here, so the record
  // must claim none — and it must not read as a refusal either: the head this step
  // ships IS the one the gate certified.
  const repo = repoWithFixHead();
  const rewind = await rewinder(repo.repoRoot)(repo.branchHeadSha);
  assert(
    rewind.shipped === false && rewind.alreadyAtVerified === true,
    `(k) origin at the verified head is reported as already-there, not as a move (${JSON.stringify([rewind.shipped, rewind.alreadyAtVerified])})`,
  );
  assert(
    originBranchSha(repo.origin) === repo.branchHeadSha,
    "(k) origin's branch was not pushed to",
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    "(k) and no keeping-ref was written for a branch that never moved",
  );
  assert(
    !(rewind.reason ?? "").includes("refused"),
    `(k) the reason says nothing was refused (${String(rewind.reason)})`,
  );
}

for (const dir of ROOTS.splice(0)) rmSync(dir, { recursive: true, force: true });

process.exit(exit);
