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
 * So this file pins four things, each on the surface where it can actually be
 * falsified:
 *
 *   (a) the ARGV. With the switch on, the branch refspec carries no leading `+` and
 *       the keeping-ref refspec keeps its; with the switch off, the whole argv is
 *       compared ARRAY FOR ARRAY against the pre-fix argv — prefix, verb, lease
 *       argument, remote, both refspecs, in that order. An off arm that also renamed
 *       the keeping-ref or reordered the refspecs is still caught by that equality,
 *       which an absence check would not be. Both halves were observed red on a
 *       mutant that put the `+` back unconditionally, so neither is a tautology.
 *   (b) the moved branch the run's clone cannot supply: the rewind must report nothing
 *       shipped, origin's branch must stand at the stranger, and no keeping-ref may be
 *       written. The reason it prints is git's own (`the rewind push failed`, naming the
 *       head origin holds), not the lease's — git builds the pack from the refspecs
 *       before it compares the lease, so an object this clone lacks is refused first and
 *       the lease is never reached. The existing (f) in
 *       `test-lean-verified-handback-rewind.ts` pins that same distinction; this arm
 *       reclaims it under the fix, where the push git refused is no longer one git would
 *       have obeyed.
 *   (b2) the arm the fix is for: the objects ARE present, on both sides, and origin's
 *       branch has moved. Same repo shape driven twice, differing only in the leading
 *       `+`: with the switch on the unforced push is authorised by its lease, rewinds
 *       the branch non-fast-forward, and keeps the head it displaced under
 *       `refs/lean/unverified/<issue>`; with the switch off the forced push rewrites a
 *       branch this step merely read. The defect is therefore pinned as the difference
 *       between two arms, and the on arm is simultaneously the control that keeps (b)
 *       from being a pass which only proves the rule stopped working — git's
 *       `Everything up-to-date` exit-0 no-op, which the code comment used to cite as the
 *       reason the `+` was necessary, is not what an authorised rewind prints.
 *
 * The three strangers the rig offers are not interchangeable, and each case says which it
 * used:
 *
 *   - `strangerOnTop` pushes from a scratch repo, so the branch moved and this clone was
 *       never told and never got the objects. That is (b)'s shape, and what
 *       `test-lean-verified-handback-rewind.ts` (f) drives.
 *   - `moveOriginBehindClone` makes the commit IN this clone, carries its objects to
 *       origin on a side ref the rewind never names, and repoints the branch by ref file.
 *       Origin has moved, holds the objects, and this clone can supply them — but the step
 *       reads that value, so the lease it binds is the accepting one. That is (b2)'s shape.
 *   - `pendingStranger` (below) is `strangerOnTop`'s construction stopped one push short, so
 *       the push lands inside a case's own window. That is (c)'s shape — the only one where
 *       origin moved AFTER this step read it.
 *
 * (c) is the case the whole fix is for, and it is the only one that drives the race the
 * lease exists to close: the step reads `held` = A off origin, and only THEN does a stranger
 * move the branch to S. Every case above moves origin BEFORE the step is called, so the
 * step's own `ls-remote` reads the stranger and binds a lease that MATCHES — and a lease that
 * matches is a lease that accepts, so no refusal of any kind happens there. In (c) the push's
 * refspecs name only V and A, both of which this clone holds, so there is no `bad object` to
 * hide behind and the lease `<ref>:A` against origin's S is the ONLY thing left to decide.
 * The move is made from inside the executor, at the instant it sees the push, so the race is
 * raced rather than assumed.
 *
 * Two things about that race were measured here on git 2.53.0 rather than taken on trust.
 * The stranger has to REACH origin over a transport (a scratch repo pushes it, from inside
 * the window): a stranger that only ever appears in origin's ref store makes origin name
 * bytes it never received, and the push dies with `bad object` before the lease is read —
 * (b)'s arm, which is what the first draft of this case silently pinned. And a push without
 * `--atomic` is refused per ref, not as a whole: on git 2.53.0 the leased branch ref was
 * refused while the UNLEASED keeping-ref still landed, so the refusal left `refs/lean/
 * unverified/<issue>` naming a head the branch never held here. That partial refusal is what
 * acceptance criterion 2 forbids, and (c) pins its opposite — the keeping-ref is ABSENT —
 * which holds only while the on-arm push carries `--atomic`. The off arm has no `--atomic`
 * and still writes that ref; (a2) pins that argv byte for byte, so the leak staying there is
 * the switch doing its job, not a gap in the fix.
 * With the switch on the rewind ships nothing and says `the lease refused the rewind`; with
 * it off the same race moves origin to V, which is the defect pinned as the difference.
 *
 * The env is pinned only through `lib/env-scope.ts`, which restores exactly what was
 * there: every lean smoke file runs in one bun process, so a leaked `"0"` here would
 * silently disarm the rule in the files sorted after it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rewindToVerified, unverifiedRef } from "../src/lean/handback-rewind.ts";
import type { Rewind } from "../src/lean/handback-rewind.ts";
import { NO_HOOKS } from "../src/lean/specify-reset.ts";
import { leanRewindLeaseBinds } from "../src/lean/rewind-lease-switch.ts";
import type { VerifyExec } from "../src/lean/verify-types.ts";
import { BRANCH, ISSUE, ROOTS, exec } from "./lib/lean-verified-handback-fixture.ts";
import { gitEnv } from "./lib/lean-review-fixtures.ts";
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

/**
 * A stranger commit that is NOT yet on origin, plus the one call that puts it there.
 *
 * `strangerOnTop` makes the commit and pushes it in the same breath; the race case needs
 * those two moments separated, because what the case is about is origin moving in the
 * window between the step's read and its push. So this is the same construction — a
 * scratch repo, so the run's clone never sees the objects and the tracking ref never
 * moves — stopped one push short, and the caller pushes it from inside that window.
 */
function pendingStranger(
  repo: { repoRoot: string; origin: string; branchHeadSha: string },
  message: string,
): { sha: string; pushTo: () => void } {
  const other = mkdtempSync(path.join(tmpdir(), "lean-handback-race-"));
  ROOTS.push(other);
  const at = (dir: string, ...args: string[]): string => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: gitEnv(),
    });
    if (r.status !== 0)
      throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
    return (r.stdout ?? "").trim();
  };
  at(other, "init", "-q", "-b", BRANCH);
  at(other, "fetch", "-q", repo.repoRoot, repo.branchHeadSha);
  at(other, "checkout", "-q", "-B", BRANCH, "FETCH_HEAD");
  at(other, "commit", "-q", "--allow-empty", "-m", message);
  const sha = at(other, "rev-parse", "HEAD");
  // The push names origin by PATH, and goes over a transport: that is what makes origin
  // HOLD the stranger's objects rather than merely name them, which is the difference
  // between this case's lease refusal and case (b)'s `bad object`. See the case.
  const pushTo = (): void => {
    at(other, "push", "-q", "--force", repo.origin, `HEAD:refs/heads/${BRANCH}`);
  };
  return { sha, pushTo };
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
    "--atomic",
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
    args.includes("--atomic"),
    `(a1) and the push is --atomic, so a refusal of either ref moves neither (${args.join(" ")})`,
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

// ── (b) a moved branch is refused, both by the lease and by what the clone holds ──
{
  // Somebody else pushed to the branch after lean's head and the run's clone has never
  // seen the stranger — the state a resumed run is really in, and the only shape
  // `strangerOnTop` produces. The rewind must refuse it, leave origin where the stranger
  // left it, and write no keeping-ref for a move that never happened.
  //
  // The reason it must print is `the rewind push failed`, NOT `the lease refused`, and
  // the difference is a fact about git rather than a preference: git builds the pack
  // from the refspecs before it compares the lease, so a sha whose objects this clone
  // cannot supply dies naming the object and the lease is never reached. That is
  // `test-lean-verified-handback-rewind.ts` (f), and this repeats the claim here because
  // it is the same push. What the fix changes, on this arm, is that the push git refused
  // is no longer one git would have obeyed had the objects been there — see (b2).
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
  assert(
    (rewind.reason ?? "").includes("the rewind push failed") &&
      (rewind.reason ?? "").includes(stranger.slice(0, 12)),
    `(b) the record names git's own reason and the head origin holds (${String(rewind.reason)})`,
  );
  assert(
    !(rewind.reason ?? "").includes("the lease refused"),
    `(b) and does not blame a lease git never reached (${String(rewind.reason)})`,
  );

  // ── (b2) the arm the fix is actually for: the objects ARE there, so only the lease
  // stands between this push and somebody else's commit. Origin holds them, the clone
  // holds them, and the step's `ls-remote` names the sha origin really holds — so the
  // lease matches what origin holds and git, with no `+`, still has to decide the move on
  // the lease alone. The two arms differ in the leading `+` and in nothing else, which is
  // what makes this the defect pinned as a difference rather than as one arm's silence.
  const on = repoWithFixHead();
  const onStranger = commitOnTop(on.repoRoot, on.branchHeadSha, "someone else's work, object-complete");
  moveOriginBehindClone(on, onStranger);
  const { exec: onSpy, pushes: onPushes } = capturingExec();
  const onRewind = await rewinder(onSpy, on.repoRoot)(on.baseSha);
  const onArgv = pushArgv(onPushes);
  assert(
    onArgv !== undefined && !onArgv.some((a) => a.startsWith("+")),
    `(b2) the on-arm push carried no forced refspec (${JSON.stringify(onArgv ?? null)})`,
  );
  assert(
    onRewind.shipped === true && originBranchSha(on.origin) === on.baseSha,
    `(b2) with the lease matching origin's own value, the unforced rewind is authorised and lands (${JSON.stringify([onRewind.shipped, onRewind.reason])})`,
  );

  const off = repoWithFixHead();
  const offStranger = commitOnTop(off.repoRoot, off.branchHeadSha, "someone else's work, object-complete");
  // Origin is moved to the stranger BEFORE the off-arm rewind, so the step reads the
  // stranger as origin's value exactly as the on arm above did: same shape, same lease
  // value, the `+` the only difference.
  moveOriginBehindClone(off, offStranger);
  const offBefore = originBranchSha(off.origin);
  const { exec: offSpy, pushes: offPushes } = capturingExec();
  let offRewind: Rewind | undefined;
  await withSwitch("0", async () => {
    offRewind = await rewinder(offSpy, off.repoRoot)(off.baseSha);
  });
  const offArgv = pushArgv(offPushes);
  assert(
    offArgv !== undefined && offArgv.includes(`+${off.baseSha}:refs/heads/${BRANCH}`),
    `(b2) off arm: the forced refspec is back in the argv (${JSON.stringify(offArgv ?? null)})`,
  );
  assert(
    offRewind?.shipped === true &&
      originBranchSha(off.origin) === off.baseSha &&
      offBefore === offStranger,
    `(b2) off arm: and that is the arm that rewrites a branch it only read — the lease git never consulted (${JSON.stringify([offRewind?.shipped, originBranchSha(off.origin), offBefore])})`,
  );
}

// ── (c) the race the lease exists for: origin moves between the step's read and its push ──
{
  // Every case above moves origin BEFORE the rewind is called, so the step's `ls-remote`
  // reads the stranger and the lease it binds MATCHES — and a lease that matches is a lease
  // that accepts. The refusal the rule promises lives in the other window: the step reads
  // origin's head A, a stranger repoints the branch at S, and the push then arrives naming
  // V and A. Both objects sit in this clone and in origin, so git has nothing to complain
  // about in the transport — the lease `<ref>:A` against origin's S is the last thing left
  // to decide. The move is therefore made from inside the executor, at the instant it sees
  // the push, which is the only way to be sure the race was raced.
  //
  // The stranger must REACH origin over a transport, and must do so INSIDE the window.
  // Both halves were measured on git 2.53.0: a stranger that only ever appears in origin's
  // ref store (`update-ref` / `forceOriginRef` from the wrapper) makes origin name bytes it
  // never received, and the push then dies naming the object (`bad object`) with the lease
  // never evaluated — that is case (b)'s arm, not this one; and a stranger pushed BEFORE
  // the call is case (b2), where the lease matches what the step read. So the scratch repo
  // pushes it from inside the window, and the assertion that origin really moved is what
  // tells the three apart.
  const repo = repoWithFixHead();
  const scratch = pendingStranger(repo, "moved after the step read origin");
  let moved = false;
  // The real executor with one thing added: the stranger lands the moment before the push
  // would run. Substituting an executor that merely failed would pin the reason string
  // without ever asking git, and a lease git was never asked about is not a pinned lease.
  const racing = ((cmd: string, opts?: Parameters<VerifyExec>[1]) => {
    if (cmd === "git" && opts?.argv?.includes("push") === true) {
      // Once only: a step that pushed twice would move origin again, and the second push
      // would be refused for a reason this case does not claim.
      if (moved) throw new Error("the rewind pushed twice, so the second refusal proves nothing");
      moved = true;
      scratch.pushTo();
      if (originBranchSha(repo.origin) === repo.branchHeadSha)
        throw new Error("the stranger did not move origin before the push, so the race was not raced");
    }
    return exec(cmd, opts);
  }) as VerifyExec;
  const stranger = scratch.sha;
  const rewind = await rewinder(racing, repo.repoRoot)(repo.baseSha);
  assert(moved, `(c) the race was raced: origin moved between this step's read and its push`);
  assert(
    rewind.shipped === false,
    `(c) a branch moved after this step read it is not this step's to rewind (${JSON.stringify([rewind.shipped, rewind.reason])})`,
  );
  assert(
    (rewind.reason ?? "").includes("the lease refused the rewind"),
    `(c) and the record says the LEASE refused it, not the transport — this is the refusal the fix exists for (${String(rewind.reason)})`,
  );
  assert(
    originBranchSha(repo.origin) === stranger,
    `(c) origin's branch still holds the stranger (${String(originBranchSha(repo.origin))} vs ${stranger})`,
  );
  // The keeping-ref must not exist. A push without `--atomic` is refused per ref, and on
  // git 2.53.0 that is exactly what it did: the leased branch ref came back `! [rejected]
  // … (stale info)` while the unleased keeping-ref landed as `* [new reference]`, so origin
  // ended up naming a head no gate certified under the name this step reserves for heads it
  // displaced — with the branch itself still at the stranger. `--atomic` on the on arm is
  // what makes git apply all refs or none, so this row is the ref-side half of acceptance
  // criterion 2 ("refused, with origin unchanged and no keeping-ref written"): the refspec
  // rows above pin that the option is on the argv, this one pins that git honoured it.
  const keptAfterRefusal = originRefSha(repo.origin, unverifiedRef(ISSUE));
  assert(
    keptAfterRefusal === undefined,
    `(c) and a refused rewind wrote NO keeping-ref on origin — origin unchanged, as the acceptance criterion demands (${String(keptAfterRefusal)})`,
  );

  // The off arm is the same race, and it MOVES origin to the verified head: git forced the
  // ref without consulting the lease and a stranger's commit was thrown off the branch by a
  // step that had read origin before they pushed. The defect is pinned as this difference.
  const off = repoWithFixHead();
  const offScratch = pendingStranger(off, "moved after the step read origin");
  let offMoved = false;
  const offRacing = ((cmd: string, opts?: Parameters<VerifyExec>[1]) => {
    if (cmd === "git" && opts?.argv?.includes("push") === true && !offMoved) {
      offMoved = true;
      offScratch.pushTo();
    }
    return exec(cmd, opts);
  }) as VerifyExec;
  let offRewind: Rewind | undefined;
  await withSwitch("0", async () => {
    offRewind = await rewinder(offRacing, off.repoRoot)(off.baseSha);
  });
  assert(
    offMoved,
    `(c) off arm: the same race was raced (${String(offMoved)})`,
  );
  assert(
    offRewind?.shipped === true && originBranchSha(off.origin) === off.baseSha,
    `(c) off arm: and the forced push moved origin to the verified head over the stranger's commit — the defect, in the arm that never had a lease consulted (${JSON.stringify([offRewind?.shipped, originBranchSha(off.origin), off.baseSha])})`,
  );
}

for (const dir of ROOTS.splice(0)) rmSync(dir, { recursive: true, force: true });

process.exit(exit);
