/**
 * test-lean-rewind-lease-binds — the rewind's push argv, and the lease actually
 * binding against a real origin.
 *
 * `src/lean/handback-rewind.ts` builds one push and reads origin back. Until this
 * file nothing captured that argv at all (`lib/lean-publish-fixture.ts` records
 * publish's lease; the rewind had no equivalent), so the refspec it carried could —
 * and did — defeat the very option sitting beside it: `git push` skips the
 * `--force-with-lease` check for a refspec it was told to force with a leading
 * `+`, which means a branch somebody else moved was force-updated anyway while the
 * comment beside the code said origin was the arbiter. Verified against a real bare
 * origin on git 2.53.0: `+<verified>:<ref>` with a stale lease exits 0 and moves the
 * branch; the same push without the `+` prints `! [rejected] … (stale info)`, exits
 * 1, and leaves origin exactly where the stranger left it.
 *
 * So this file pins three things, each on the surface where it can actually be
 * falsified:
 *
 *   (a) the ARGV. With the switch on, the branch refspec carries no leading `+` and
 *       the keeping-ref refspec keeps its; with the switch off, the whole argv is
 *       compared ARRAY FOR ARRAY against the pre-fix argv — prefix, verb, lease
 *       argument, remote, both refspecs, in that order. An off arm that also renamed
 *       the keeping-ref or reordered the refspecs is still caught by that equality,
 *       which an absence check would not be.
 *   (b) the git CONTRACT. A stranger moves origin after the lease value was read,
 *       and its objects are reachable from the run's clone, so the only thing that
 *       can refuse is the lease: the rewind must report nothing shipped, origin's
 *       branch must stand at the stranger, and no keeping-ref may be written — and
 *       the reason must name the lease, since `bad object` would be a different
 *       refusal with a different operator action.
 *   (c) the CONTROL on the other side of that line, which is what keeps (b) from
 *       being a case that passes for the wrong reason: the same rewind with a lease
 *       that matches origin still lands, non-fast-forward, and the head it displaced
 *       reaches origin under `refs/lean/unverified/<issue>`. If dropping the `+`
 *       turned every rewind into git's `Everything up-to-date` exit-0 no-op, (b)
 *       would look like a pass while the rule stopped working entirely.
 *
 * The two strangers the rig offers are not interchangeable and the case says which
 * it used: `strangerOnTop` pushes from a scratch repo, so the run's clone never sees
 * the objects and git dies in transport before the lease is evaluated;
 * `moveOriginBehindClone` moves origin by ref file after making the stranger IN the
 * run's clone, so the objects are supplyable and a refusal can only be the lease's.
 * (b) and (c) use the latter; `test-lean-verified-handback-rewind.ts` (f) pins the
 * former.
 *
 * The env is pinned only through `lib/env-scope.ts`, which restores exactly what was
 * there: every lean smoke file runs in one bun process, so a leaked `"0"` here would
 * silently disarm the rule in the files sorted after it.
 */

import { rmSync } from "node:fs";
import { rewindToVerified, unverifiedRef } from "../src/lean/handback-rewind.ts";
import { NO_HOOKS } from "../src/lean/specify-reset.ts";
import { leanRewindLeaseBinds } from "../src/lean/rewind-lease-switch.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
import { BRANCH, ISSUE, ROOTS, exec } from "./lib/lean-verified-handback-fixture.ts";
import { stepGitEnv } from "./lib/lean-review-fixtures.ts";
import {
  cloneHolds,
  commitOnTop,
  moveOriginBehindClone,
  originBranchSha,
  originRefSha,
  repoWithFixHead,
} from "./lib/lean-verified-handback-repo.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The switch's own reader, asserted alongside every argv claim. */
async function withSwitch(value: string | undefined, body: () => Promise<void>): Promise<void> {
  await withEnv({ PI_ENSEMBLE_LEAN_REWIND_LEASE_BINDS: value }, body);
}

/**
 * An executor that records the rewind's push argv verbatim and otherwise IS the
 * fixture's real executor.
 *
 * Recording (rather than substituting) is the point: origin still decides, so the
 * argv assertions and the ref assertions below describe one and the same push.
 */
function capturingExec(): { exec: VerifyExec; pushes: string[][] } {
  const pushes: string[][] = [];
  const spy = ((cmd: string, opts?: Parameters<VerifyExec>[1]) => {
    if (cmd === "git" && opts?.argv?.includes("push") === true) pushes.push([...opts.argv]);
    return exec(cmd, opts);
  }) as VerifyExec;
  return { exec: spy, pushes };
}

/** The rewind seam under observation: real rewind, real origin, production `net`. */
function rewinder(executor: VerifyExec, repoRoot: string) {
  return (verifiedHead: string) =>
    rewindToVerified(executor, { repoRoot, issue: ISSUE, run: { branch: BRANCH } } as never, verifiedHead, {
      net: true,
    });
}

/** The push argv the rewind ran with, or `undefined` when it pushed nothing. */
function pushArgv(pushes: string[][]): string[] | undefined {
  return pushes.find((a) => a.includes("push"));
}

// ── (a1) the switch ON: no `+` on the branch refspec, nothing else changed ──
{
  if (leanRewindLeaseBinds() !== true)
    throw new Error("the operator's env has the lease switch off, so the ON arm measures nothing");
  const repo = repoWithFixHead();
  const { exec: spy, pushes } = capturingExec();
  const rewind = await rewinder(spy, repo.repoRoot)(repo.baseSha);

  const argv = pushArgv(pushes);
  assert(argv !== undefined, `(a1) the rewind ran one push (${JSON.stringify(argv ?? null)})`);
  const args = argv ?? [];
  const branchRefspec = `refs/heads/${BRANCH}`;
  const onArm = [
    ...NO_HOOKS,
    "push",
    `--force-with-lease=${branchRefspec}:${repo.branchHeadSha}`,
    "origin",
    `${repo.baseSha}:${branchRefspec}`,
    `${repo.branchHeadSha}:${unverifiedRef(ISSUE)}`,
  ];
  const refspecAt = args.indexOf(`${repo.baseSha}:${branchRefspec}`);
  assert(
    refspecAt >= 0,
    `(a1) the branch refspec is the unforced '<verified>:<ref>' (${args.join(" ")})`,
  );
  assert(
    !args.some((a) => a.startsWith("+")),
    `(a1) and NO refspec carries a leading '+' — the forced form is what made git skip the lease (${args.join(" ")})`,
  );
  assert(
    args.includes(`${repo.branchHeadSha}:${unverifiedRef(ISSUE)}`),
    `(a1) the keeping-ref refspec is still there, unforced as before (${args.join(" ")})`,
  );
  assert(
    args.includes(`--force-with-lease=${branchRefspec}:${repo.branchHeadSha}`),
    `(a1) the lease argument is the same expected-value lease as before (${args.join(" ")})`,
  );
  // The byte-identical-off guarantee has an on-arm half: the switch moves the `+`
  // and NOTHING else — no --porcelain, no new option, same prefix, same remote, same
  // refspec order. Every element is compared against the on-arm argv written out in
  // full below, so a claim that only the `+` moved is checked rather than asserted.
  assert(
    args.length === onArm.length && args.every((a, i) => a === onArm[i]),
    `(a1) the argv is exactly the pre-fix argv with the branch refspec's leading '+' gone (${args.join(" ")})`,
  );
  assert(
    args.includes("push") && args.includes("origin"),
    `(a1) and it is still the same push to origin (${args.join(" ")})`,
  );
  assert(
    rewind.shipped && originBranchSha(repo.origin) === repo.baseSha,
    `(a1) unforced, the rewind still lands: origin holds the verified head (${String(originBranchSha(repo.origin))})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === repo.branchHeadSha,
    `(a1) and the head it displaced is kept under ${unverifiedRef(ISSUE)} (${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
}

// ── (a2) the switch OFF: argv array-for-array identical to the pre-fix argv ──
{
  const repo = repoWithFixHead();
  const { exec: spy, pushes } = capturingExec();
  await withSwitch("0", async () => {
    await rewinder(spy, repo.repoRoot)(repo.baseSha);
  });
  const argv = pushArgv(pushes);
  // The pre-fix argv, written out here rather than derived from the code under test:
  // a comparison against the same expression the fix builds would move with it.
  const PRE_FIX = [
    ...NO_HOOKS,
    "push",
    `--force-with-lease=refs/heads/${BRANCH}:${repo.branchHeadSha}`,
    "origin",
    `+${repo.baseSha}:refs/heads/${BRANCH}`,
    `${repo.branchHeadSha}:${unverifiedRef(ISSUE)}`,
  ];
  assert(
    JSON.stringify(argv) === JSON.stringify(PRE_FIX),
    `(a2) with the switch off the rewind's push argv is the pre-fix argv, element for element in order (got ${JSON.stringify(argv)})`,
  );
}

// ── (b) the lease binds: origin moved behind lean's back by a stranger the clone CAN supply ──
{
  const repo = repoWithFixHead();
  // The stranger is made IN this clone, travels to origin by a real push (so its
  // objects are there for the rewind's own push to supply), and origin is then
  // repointed at it WITHOUT this clone's remote-tracking ref following — see
  // `moveOriginBehindClone`, whose doc says why `git update-ref` cannot do the last
  // half on a bare repo that does not hold the sha yet.
  const stranger = commitOnTop(repo.repoRoot, repo.branchHeadSha, "someone else's work, object-complete");
  // The tracking ref is read BEFORE the rig moves anything: the rig's own push carries
  // the objects into origin, and a case that read this afterwards would be reading
  // whatever the rig last did to this clone rather than the state the lease is judged
  // against — the fact the case rests on is that this clone was never told.
  const tracked = await exec("git", {
    argv: ["rev-parse", "--verify", `refs/remotes/origin/${BRANCH}`],
    cwd: repo.repoRoot,
    timeout: 60_000,
    env: stepGitEnv(),
  }).catch(() => undefined);
  moveOriginBehindClone(repo, stranger);
  // The two preconditions that make this the LEASE case rather than the transport
  // case pinned by test-lean-verified-handback-rewind.ts (f). Checked, not assumed:
  // either one silently missing turns this into a different refusal that passes for
  // the wrong reason.
  assert(
    cloneHolds(repo.repoRoot, stranger),
    "(b) precondition: the run's clone holds the stranger's objects, so transport cannot be what refuses",
  );
  assert(
    tracked?.stdout.trim() === repo.branchHeadSha,
    `(b) precondition: this clone was never told of the move, so its tracking ref still names the head the run pushed and the lease really is the mismatched one (${String(tracked?.stdout.trim())})`,
  );

  const before = originBranchSha(repo.origin);
  const { exec: spy, pushes } = capturingExec();
  const rewind = await rewinder(spy, repo.repoRoot)(repo.baseSha);
  assert(
    rewind.shipped === false,
    `(b) a branch somebody else moved is not this run's to rewrite, so the rewind ships nothing (${JSON.stringify([rewind.shipped, rewind.reason])})`,
  );
  assert(
    originBranchSha(repo.origin) === before && before === stranger,
    `(b) and origin's branch did not move (${String(originBranchSha(repo.origin))} vs ${stranger})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === undefined,
    `(b) and a refused rewind wrote no keeping-ref either (${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
  const argv = pushArgv(pushes);
  assert(
    argv !== undefined && !argv.some((a) => a.startsWith("+")),
    `(b) the push that was refused carried no forced refspec (${JSON.stringify(argv ?? null)})`,
  );
  // The diagnosis matters as much as the refusal: git reached the lease here, so the
  // record says the lease refused, and (b)'s whole point is that this is the case
  // where that sentence is TRUE.
  assert(
    (rewind.reason ?? "").includes("the lease refused"),
    `(b) the record blames the lease, which is the thing that refused (${String(rewind.reason)})`,
  );
}

// ── (c) control: a matching lease still rewinds, non-fast-forward ───────────
{
  // If git refused every unforced non-fast-forward, (b) would be a pass that says
  // nothing — every rewind would print a lease refusal and the rule would be dead.
  // So the same shape with a lease that MATCHES origin must still land.
  const repo = repoWithFixHead();
  const stranger = commitOnTop(repo.repoRoot, repo.branchHeadSha, "a head origin was moved to legitimately");
  // Origin's value is made to equal the sha the step will read off it, so the lease
  // matches; the rewind below is still a non-fast-forward move.
  moveOriginBehindClone(repo, stranger);
  const rewind = await rewinder(exec, repo.repoRoot)(repo.baseSha);
  assert(
    rewind.shipped === true,
    `(c) control: with a matching lease the rewind lands even though it is non-fast-forward (${JSON.stringify([rewind.shipped, rewind.reason])})`,
  );
  assert(
    originBranchSha(repo.origin) === repo.baseSha,
    `(c) control: origin's branch stands at the verified head (${String(originBranchSha(repo.origin))})`,
  );
  assert(
    originRefSha(repo.origin, unverifiedRef(ISSUE)) === stranger,
    `(c) control: and the displaced head is kept on origin, not dropped (${String(originRefSha(repo.origin, unverifiedRef(ISSUE)))})`,
  );
}

for (const dir of ROOTS.splice(0)) rmSync(dir, { recursive: true, force: true });

process.exit(exit);
