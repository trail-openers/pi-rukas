/**
 * lean/handback-rewind — move origin's branch back to the last verified head.
 *
 * A `fixed` review pushed the fixer's head onto origin's branch and the run
 * then ended before its re-verification ran, so origin holds bytes no gate
 * certified. The handback's answer is one ref move, made before the comment is
 * written: keep the unverified head reachable under a ref of its own, then
 * rewind the branch to the newest green `verify`'s head.
 *
 * The move is a lease-pinned push — `--force-with-lease=<branch>:<unverified
 * head>` — so it happens only while origin still holds exactly the head this
 * run pushed. A branch somebody else moved is not this run's to rewrite; the
 * lease refuses and nothing is moved. The same lease `publish` uses, for the
 * same reason: a forced update is legitimate only because it is bound to a sha
 * this step read.
 *
 * The branch it moves is state-file data too, so it gets the same guard the
 * run's two other force-push sites apply before they build an argv —
 * `assertPublishableBranch`. Legality is not enough: `main` is a legal ref, and
 * a `+<head>:refs/heads/main` is exactly what a hand-edited state file turns a
 * rewind into. A refusal of that kind moves nothing and says so in the record,
 * like every other refusal here.
 *
 * Two reads make the claim honest and neither is porcelain: origin is read
 * BEFORE the push (that read is what the lease is bound to, and what the record
 * names as the unshipped head), and origin is read AGAIN after it. Success is
 * origin holding the verified head, whatever git printed; a refusal says why in
 * the record's own words, and a handback whose rewind refused still reports.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { traceWarn } from "../trace.ts";
import { netGitEnv, netRefProblem } from "../work-driver-net-git.ts";
import type { HandlerCtx } from "./engine.ts";
import { PublishInfraError, assertPublishableBranch } from "./publish-deps.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { specifyBranch } from "./specify-tree.ts";
import type { VerifyExec } from "./verify-types.ts";

/** What one rewind attempt settled on. Every member names what origin holds now. */
export interface Rewind {
  /** True only when origin's branch was read back at the verified head. */
  shipped: boolean;
  /**
   * The head the run pushed that this step's own push moved off — set only where
   * the rewind moved it, and left unset on an arm that moved nothing. The caller
   * reads it as "the unverified head the run left behind", never as a snapshot of
   * origin at any moment: an arm that pushed nothing has no such head to name.
   */
  unshippedHead?: string;
  /** Why nothing moved, in the record's own words, when `shipped` is false. */
  reason?: string;
  /**
   * The HEAD RULE's words for why there was no head to move, carried on the arm that
   * had none. Distinct from `reason` because the two answer different questions:
   * `reason` explains a push that did not happen, and this explains the FINDING that
   * there was nothing to push to. The record quotes this one — an operator reading a
   * handed-back run is asking why what they were sent is not what the gate approved,
   * and the rule that judged the log is the authority on that.
   */
  noHeadReason?: string;
  /**
   * The head the run pushed is ALREADY the head origin holds — the outcome the rule
   * wants, produced by an earlier step rather than by this one. Distinguishable from
   * a refusal precisely because no head was displaced: the caller must not print the
   * head it ships as unverified, nor name a head this step never moved off.
   */
  alreadyAtVerified?: boolean;
}

/** Origin's own value for the run's branch, or `undefined` when it cannot be read. */
export async function originBranchHead(
  exec: VerifyExec,
  ctx: Pick<HandlerCtx, "repoRoot" | "issue" | "run">,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  const ref = `refs/heads/${specifyBranch(ctx.run.branch, ctx.issue)}`;
  const ran = await exec("git", {
    argv: [...NO_HOOKS, "ls-remote", "origin", ref],
    cwd: ctx.repoRoot,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  }).catch(() => undefined);
  const out = (ran?.stdout ?? "").trim();
  if (ran === undefined || out === "") return undefined;
  const [sha = ""] = out.split(/\s+/);
  return isFullCommitSha(sha) ? sha : undefined;
}

/** Nothing to move: the rule fired and the log named no head to go back to. */
export const NO_HEAD: Rewind = {
  shipped: false,
  reason: "no verified head was recorded, so nothing was moved",
};

/** A rewind that never ran because the operator switched the rule off. */
export const SWITCHED_OFF: Rewind = { shipped: false };

/**
 * The ref that holds the head the rewind moved off, so it is not lost to a GC.
 *
 * Namespaced under `refs/lean/` rather than `refs/heads/` so it is not a branch:
 * it names no PR and no merge target, and a reader of origin's branches cannot
 * mistake it for one.
 */
export function unverifiedRef(issue: number): string {
  return `refs/lean/unverified/${String(issue)}`;
}

/**
 * Whether git said the words a lease refusal says.
 *
 * `--force-with-lease` is enforced on the client: when origin's value for the
 * leased ref is not what this push expected, the porcelain prints `stale info`
 * (and the `! [rejected] … (stale info)` row beside it). That wording is the one
 * this project has observed — `test-lean-verified-handback-rewind.ts` drives a
 * lease that does not match — and it is the ONLY wording admitted. Anything else
 * that made the push fail (an unreachable object, an unpack failure, a transport
 * drop) never reached that check, and labelling it a lease refusal would send the
 * operator to look for someone who moved their branch when the fix is a fetch.
 */
function leaseRefused(stderr: string): boolean {
  return /stale info/i.test(stderr);
}

/** The first non-empty line of git's complaint, bounded for one comment line. */
function firstLine(stderr: string): string {
  const line =
    stderr
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "no reason was reported";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

/** Run one git command and report failure as `undefined` rather than throwing. */
async function quiet(
  exec: VerifyExec,
  cwd: string,
  argv: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const ran = await exec("git", {
    argv: [...NO_HOOKS, ...argv],
    cwd,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    ...(env === undefined ? {} : { env }),
  }).catch(() => undefined);
  const out = (ran?.stdout ?? "").trim();
  return ran === undefined ? undefined : out;
}

/**
 * Does this clone hold `sha` as a commit — yes, no, or could git not be asked?
 *
 * The narrowest question that answers it: `git cat-file -e <sha>^{commit}` answers on
 * its RESULT, not on an exit code the caller has to go looking for — the executor
 * RESOLVES for an object and REJECTS for an absent one (`lean/base-proof.ts` reads the
 * same pair, inverted: there a rejection is the expectation). So a resolved call is
 * `true`, full stop, and the exit code is read only on the rejection shape.
 *
 * `undefined` is the third answer, and it is separate on purpose: "no such object" is a
 * reason to move nothing and say so, while "git did not answer" — never started, timed
 * out, killed, or rejected with no exit information at all — is not evidence about the
 * object, and collapsing the two is how a locked index or a hung git becomes a
 * confident wrong claim about a head.
 *
 * The `^{commit}` peel is what makes a blob or a tree at that oid answer `false`.
 */
async function holdsCommit(
  exec: VerifyExec,
  cwd: string,
  sha: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean | undefined> {
  try {
    await exec("git", {
      argv: [...NO_HOOKS, "cat-file", "-e", "--end-of-options", `${sha}^{commit}`],
      cwd,
      timeout: 60_000,
      maxBuffer: 8 * 1024,
      ...(env === undefined ? {} : { env }),
    });
    return true;
  } catch (err) {
    const e = err as { code?: unknown; killed?: unknown; signal?: unknown };
    // Only a git that RAN and refused may say `false`. A rejection carrying no exit
    // information at all is an executor that could not be called, and a killed or
    // signalled git carried no answer — both are `undefined`, never absence.
    if (typeof e?.code !== "number" || e.killed === true || e.signal != null) return undefined;
    return false;
  }
}

/** Origin's own value for one ref, read through `ls-remote`, or `undefined`. */
async function originRef(
  exec: VerifyExec,
  cwd: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const out = await quiet(exec, cwd, ["ls-remote", "origin", ref], env);
  if (out === undefined || out === "") return undefined;
  const [sha = ""] = out.split(/\s+/);
  return isFullCommitSha(sha) ? sha : undefined;
}

/**
 * Rewind origin's branch to `verifiedHead` and keep the head it held.
 *
 * `dir` is any clone of origin — the handback's `repoRoot` is one, and the
 * move names both shas on the command line rather than reading a working tree,
 * so no tree has to be clean for it to be correct. Every refusal is a `Rewind`
 * with `shipped: false`, never a throw: the reporting step's contract is that
 * it always answers, and a run whose rewind failed still ends with a comment
 * that says the shipped head is unverified and why. The one refusal that is not
 * an unverified head is `alreadyAtVerified` — origin held the certified head
 * before this step ran, so what it ships needs no caveat.
 */
export async function rewindToVerified(
  exec: VerifyExec,
  ctx: Pick<HandlerCtx, "repoRoot" | "issue" | "run">,
  verifiedHead: string,
  opts: { env?: NodeJS.ProcessEnv; net?: boolean } = {},
): Promise<Rewind> {
  const branch = specifyBranch(ctx.run.branch, ctx.issue);
  const ref = `refs/heads/${branch}`;
  // The push is the one call that leaves the clone, so it is the one call given the
  // non-interactive net env, exactly as `publish`'s push is; the reads that only
  // ask origin for a sha keep the caller's env unless `net` says otherwise.
  const netEnv = opts.net === true ? netGitEnv(process.env, ctx.repoRoot) : undefined;
  const pushEnv = opts.env ?? netEnv;
  // A branch name is state-file data, and `assertSafeRef` only says it is
  // a legal git name — `+x` and `a:b` are too, which git reads as a force or a
  // refspec. The same check `publish`'s push makes before its argv.
  const unsafe = netRefProblem(ref);
  if (unsafe !== undefined)
    return { shipped: false, reason: `the branch is not pushable: ${unsafe}` };
  // Legality is one thing and permission another: `netRefProblem` says the name
  // is a ref git will take, which `main` is. The branch this push FORCES is
  // `specifyBranch(run.branch, …)` — state-file data — so it gets `publish`'s and
  // `review`'s own guard, not a third rule: a rewind is a force-push to the run's
  // branch, and it is the one such site that shipped without it. The guard throws
  // `PublishInfraError` at its callers; here the refusal is a `Rewind`, because
  // this step's contract is that it always answers — and the run whose state file
  // names the mainline still gets a comment saying so. `held` is read AFTER the
  // refusal on purpose: a step that moved nothing has no head to name as the one
  // it left behind, which is the same rule `alreadyAtVerified` exists to keep.
  const pushable = await assertPublishableBranch(ctx.repoRoot, branch).then(
    () => undefined,
    (err: unknown) =>
      err instanceof PublishInfraError ? err.message : String((err as Error)?.message ?? err),
  );
  if (pushable !== undefined)
    return { shipped: false, reason: `the branch is not pushable: ${pushable}` };
  // A head that is not a sha is not a rewind, but it is still the case the
  // operator came to read: the rule fired, so the run has an unverified head on
  // origin and there was nothing verified to move to. `held` is therefore read
  // BEFORE the sha check — the record names it, and a read that cannot answer is
  // still not a licence to claim a head was shipped.
  const held = await originRef(exec, ctx.repoRoot, ref, opts.env ?? netEnv);
  if (held === undefined)
    return {
      shipped: false,
      reason: `could not read origin's ${branch}, so nothing was moved`,
    };
  if (!isFullCommitSha(verifiedHead))
    return {
      shipped: false,
      unshippedHead: held,
      reason: `the recorded verified head ${verifiedHead.slice(0, 12)} is not a full commit sha, so nothing was moved`,
    };
  // Shape is not existence — the boundary `commit-sha.ts` states and
  // `lean/base-proof.ts` exists to close. `verifiedHead` arrives from a child's
  // `verify` verdict and round-trips through the on-disk state file, so this clone
  // may hold no such object. Every arm that MOVES origin would have git resolve it
  // (a push cannot supply bytes the clone lacks), but the arm below that pushes
  // nothing when origin already holds it would otherwise certify an object nobody
  // can read as the head the gate approved. So the object is asked of git first.
  const holdsVerified = await holdsCommit(exec, ctx.repoRoot, verifiedHead, opts.env ?? netEnv);
  if (holdsVerified === undefined)
    return {
      shipped: false,
      unshippedHead: held,
      reason: `could not ask git whether this clone holds the verified head ${verifiedHead.slice(0, 12)}, so nothing was moved`,
    };
  if (!holdsVerified)
    return {
      shipped: false,
      unshippedHead: held,
      reason: `the recorded verified head ${verifiedHead.slice(0, 12)} is not a commit this clone has, so nothing was moved`,
    };

  // Origin already holds the head the rule would have moved it to. That is the
  // outcome the rule wants, but this step did not produce it: no push, no keep,
  // and a record that said `shipped: true` would claim a move this step never
  // made. So it answers `shipped: false` — and says WHY by name, in
  // `alreadyAtVerified`, rather than leaving the caller to tell this arm from a
  // refusal by its shape alone: the head this step ships IS the certified one, and
  // `unshippedHead` repeats it only so the record still answers "what is on the
  // branch" — the caller's own rule for hiding a head that was never displaced
  // (`headFacts` in handback.ts) is what stops it printing as an unshipped one.
  //
  // Every other `shipped: false` arm sets `alreadyAtVerified` at most to undefined,
  // which reads as "not verified": those arms hold a head no gate ever certified.
  if (held === verifiedHead)
    return {
      shipped: false,
      alreadyAtVerified: true,
      unshippedHead: held,
      reason: `origin already holds the verified head ${held.slice(0, 12)}, so this step moved nothing`,
    };

  // One push, two refspecs: the branch moves back to the verified head AND the
  // head it moved off gains its keeping-ref on origin — on BOTH sides of the wire,
  // because a ref written in the clone alone dies with the run's worktree and a
  // head nobody names is a head a GC removes. They must be ONE transaction: a
  // separate keep push would land whatever it did, since the rewind's lease is bound
  // to the head this step read and by the time a second push ran that lease was
  // already spent, so a refused rewind could still leave a ref on origin naming a
  // head nothing moved. Git refuses the whole push when the lease does not match,
  // so neither ref moves and the record says so.
  //
  // There is deliberately no local `update-ref` before this push. A ref can only be
  // written from an object this clone holds, and on the refusal path the head origin
  // holds may be one it has never seen — so the local write would fail first and
  // the record would blame the keeping-ref for what was the lease's refusal. The
  // head is named on the command line instead, and origin is what decides.
  //
  // The branch refspec is FORCED (`+`) because a rewind is a non-fast-forward move
  // by definition, and an unforced refspec to a branch that has moved ahead is a
  // NO-OP that exits 0: git prints `Everything up-to-date`, pushes nothing, and a
  // reader of the exit code alone would record a head origin never received.
  //
  // The lease carries its EXPECTED value (`<ref>:<held>`). The bare form compares
  // origin against this clone's remote-tracking ref, which only a `fetch` refreshes:
  // on a clone that has not fetched since the fix wave it still names the head this
  // run pushed, and it would accept a rewind of a branch somebody else moved — the
  // exact rewrite V2 forbids. Binding the lease to the sha this step read off origin
  // makes origin the arbiter, from the same `ls-remote` the record reports.
  const pushArgv = [
    ...NO_HOOKS,
    "push",
    `--force-with-lease=${ref}:${held}`,
    "origin",
    `+${verifiedHead}:${ref}`,
    `${held}:${unverifiedRef(ctx.issue)}`,
  ];
  // A push that git rejected comes back as the stderr it printed; a push that ran
  // comes back as `undefined`. `execp` rejects with the exec error shape, which
  // carries the captured stderr, and `killGroup`'s group-kill rejection does too.
  const pushStderr = await exec("git", {
    argv: pushArgv,
    cwd: ctx.repoRoot,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    killGroup: true,
    ...(pushEnv === undefined ? {} : { env: pushEnv }),
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      const e = err as { stderr?: unknown; message?: unknown };
      const why = String(e?.stderr ?? e?.message ?? err);
      traceWarn(`lean handback: the rewind of ${branch} failed — ${why.slice(0, 200)}`);
      return why;
    });
  if (pushStderr !== undefined) {
    // git said no. The lease is not the only reason a push says no: this clone may
    // simply not hold an object the refspecs name (a resumed run whose clone never
    // fetched a third party's head fails with `bad object` / `unpacker error`), and
    // git never reached the lease check at all. The two need different operator
    // actions — one is "someone else moved your branch", the other is "fetch and
    // retry" — so the line is chosen from git's own stderr, and origin stays the
    // arbiter of what the branch holds.
    const refused = await originRef(exec, ctx.repoRoot, ref, opts.env ?? netEnv);
    const where = `origin still holds ${refused === undefined ? "an unreadable head" : refused.slice(0, 12)}`;
    return {
      shipped: false,
      unshippedHead: held,
      reason:
        refused === verifiedHead
          ? `origin holds the verified head ${verifiedHead.slice(0, 12)}, though ${unverifiedRef(ctx.issue)} is not readable there`
          : leaseRefused(pushStderr)
            ? `${where} — the lease refused the rewind`
            : `${where} — the rewind push failed: ${firstLine(pushStderr)}`,
    };
  }

  // Origin decides, never the porcelain: read back and compare. BOTH names are
  // checked, because a rewind that moved the branch and lost the keeping-ref
  // would have thrown the unverified head away — the one thing this step exists
  // not to do.
  const [after, keptOnOrigin] = await Promise.all([
    originRef(exec, ctx.repoRoot, ref, opts.env ?? netEnv),
    originRef(exec, ctx.repoRoot, unverifiedRef(ctx.issue), opts.env ?? netEnv),
  ]);
  if (after === verifiedHead && keptOnOrigin === held)
    return { shipped: true, unshippedHead: held };
  return {
    shipped: false,
    unshippedHead: held,
    reason:
      after !== verifiedHead
        ? `origin still holds ${after === undefined ? "an unreadable head" : after.slice(0, 12)} — the lease refused the rewind`
        : `${held.slice(0, 12)} is not reachable on origin under ${unverifiedRef(ctx.issue)}, so the branch was not moved`,
  };
}
