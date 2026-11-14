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
 *   (b) the git CONTRACT, both arms of it. A stranger that the run's clone has never
 *       seen moves origin after the lease value was read: the rewind must report nothing
 *       shipped, origin's branch must stand at the stranger, no keeping-ref may be
 *       written, and the reason must name the lease. The same shape driven with the
 *       switch off — the leading `+` back in the argv — must force-update that very
 *       branch: the defect is pinned as the difference between two arms over the same
 *       repo shape, not as one arm's silence.
 *   (c) the CONTROL on the other side of that line, which is what keeps (b) from
 *       being a case that passes for the wrong reason: the same rewind with a lease
 *       that matches origin still lands, non-fast-forward, and the head it displaced
 *       reaches origin under `refs/lean/unverified/<issue>`. If dropping the `+`
 *       turned every rewind into git's `Everything up-to-date` exit-0 no-op, (b)
 *       would look like a pass while the rule stopped working entirely.
 *
 * The two strangers the rig offers are not interchangeable, and the case says which it
 * used. `--force-with-lease=<ref>:<expect>` compares <expect> to the value the push
 * itself reads from origin, so a refusal needs origin to hold something other than what
 * the step's `ls-remote` named — and a control that lands needs origin to hold something
 * it can supply:
 *
 *   - `strangerOnTop` pushes from a scratch repo, so the branch moved and this clone was
 *       never told and never got the objects. That is (b)'s shape, and it is what
 *       `test-lean-verified-handback-rewind.ts` (f) drives too — with the switch off its
 *       push force-updates, which is the point of the off arm here.
 *   - `moveOriginBehindClone` makes the commit IN this clone, carries its objects to
 *       origin on a side ref the rewind never names, and repoints the branch by ref file.
 *       Origin has moved, holds the objects, and the step's read names the stranger, so
 *       the lease matches. That is (c)'s shape.
 *
 * The env is pinned only through `lib/env-scope.ts`, which restores exactly what was
 * there: every lean smoke file runs in one bun process, so a leaked `"0"` here would
 * silently disarm the rule in the files sorted after it.
 */

import { rmSync } from "node:fs";
import { rewindToVerified, unverifiedRef } from "../src/lean/handback-rewind.ts";
import type { Rewind } from "../src/lean/handback-rewind.ts";
import { NO_HOOKS } from "../src/lean/specify-reset.ts";
import { leanRewindLeaseBinds } from "../src/lean/rewind-lease-switch.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
import { BRANCH, ISSUE, ROOTS, exec } from "./lib/lean-verified-handback-fixture.ts";
import {
  cloneHolds,
  commitOnTop,
  moveOriginBehindClone,
  originBranchSha,
  originRefSha,
  repoWithFixHead,
  strangerOnTop,
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

// ── (b) the lease binds: origin moved behind lean's back, and the refusal says so ──
{
  // Somebody else pushed to the branch after lean's head, and the run's clone has never
  // seen the stranger — the state a resumed run is really in. `strangerOnTop` is the
  // only rig that makes it: a stranger made in this clone would leave its objects here,
  // and the case would be measuring something else entirely.
  const repo = repoWithFixHead();
  const stranger = strangerOnTop(repo, repo.branchHeadSha, "someone else's work");
  if (originBranchSha(repo.origin) !== stranger)
    throw new Error(
      `the stranger push did not land: origin holds ${String(originBranchSha(repo.origin))}, not ${stranger}`,
    );
  if (cloneHolds(repo.repoRoot, stranger))
    throw new Error("the run's clone holds the stranger, so this is not the arm it claims to be");

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
  // The reason the lease now binds, stated as the mechanism rather than as a hope:
  // `--force-with-lease=<ref>:<expect>` compares <expect> to the value the push itself
  // just read from origin, so naming the sha this step read earlier is what makes a
  // move-over-somebody-else's-head a refusal at all. With the `+` back (the switch's off
  // arm, and the shape this file exists for) git never evaluates the lease and the same
  // push force-updates — which is why the two arms below are the whole case.
  assert(
    (rewind.reason ?? "").includes("the lease refused"),
    `(b) the record blames the lease, which is the thing that refused (${String(rewind.reason)})`,
  );
  // The converse half, on its own repo: the SAME push argv with the leading `+` put back
  // by the switch over the SAME shape of moved branch does rewrite origin. That is the
  // defect, pinned as a difference between two arms rather than as one arm's silence.
  const off = repoWithFixHead();
  const offStranger = strangerOnTop(off, off.branchHeadSha, "someone else's work");
  const offBefore = originBranchSha(off.origin);
  const { exec: offSpy, pushes: offPushes } = capturingExec();
  let offRewind: Rewind | undefined;
  await withSwitch("0", async () => {
    offRewind = await rewinder(offSpy, off.repoRoot)(off.baseSha);
  });
  const offArgv = pushArgv(offPushes);
  assert(
    offArgv !== undefined &&
      offArgv.includes(`+${off.baseSha}:refs/heads/${BRANCH}`),
    `(b) off arm: the forced refspec is back in the argv (${JSON.stringify(offArgv ?? null)})`,
  );
  assert(
    offRewind?.shipped === true &&
      originBranchSha(off.origin) === off.baseSha &&
      offBefore === offStranger,
    `(b) off arm: and that is exactly the arm that force-updates a branch somebody else moved — the defect this fix removes (${JSON.stringify([offRewind?.shipped, originBranchSha(off.origin), offBefore])})`,
  );
}

// ── (c) control: a matching lease still rewinds, non-fast-forward ───────────
{
  // If git refused every unforced non-fast-forward, (b) would be a pass that says
  // nothing — every rewind would print a lease refusal and the rule would be dead.
  // So the same shape with a lease that MATCHES origin must still land.
  const repo = repoWithFixHead();
  const stranger = commitOnTop(repo.repoRoot, repo.branchHeadSha, "a head origin was moved to");
  // The stranger reaches origin on a side ref the rewind never names, and the branch is
  // then repointed at it by ref file: origin holds the objects, the branch really moved,
  // and this clone was told nothing. The step's `ls-remote` therefore reads the stranger
  // and binds the lease to it — the lease matches, which is precisely what makes this
  // the accepting arm and (b) the refusing one.
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
