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
 * that says the shipped head is unverified and why.
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

  // Origin already holds the head the rule would have moved it to. That is the
  // outcome the rule wants, but this step did not produce it: no push, no keep,
  // and a record that said `shipped: true` would claim a move this step never
  // made. It answers `shipped: false` with the reason that says origin already
  // holds it, and leaves `unshippedHead` UNSET — origin holds one head and this
  // step moved nothing, so there is no head the run pushed that it displaced.
  //
  // `unshippedHead` means exactly one thing throughout this module: the head this
  // step's own push moved off. That is why the refusal arms below DO set it (the
  // step pushed, and origin is still holding that head) while this arm does not.
  if (held === verifiedHead)
    return {
      shipped: false,
      reason: `origin already holds the verified head ${held.slice(0, 12)}, so nothing was moved`,
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
  // lease is bound to the head this step read, and by the time a second push ran
  // that lease was already spent, so a refused rewind could still leave a ref on
  // origin naming a head nothing moved. Git refuses the whole push when the lease
  // does not match, so neither ref moves and the record says so.
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
  const ran = await exec("git", {
    argv: [
      ...NO_HOOKS,
      "push",
      `--force-with-lease=${ref}:${held}`,
      "origin",
      `+${verifiedHead}:${ref}`,
      `${held}:${unverifiedRef(ctx.issue)}`,
    ],
    cwd: ctx.repoRoot,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    killGroup: true,
    ...(pushEnv === undefined ? {} : { env: pushEnv }),
  }).catch((err: unknown) => {
    const e = err as { stderr?: unknown; message?: unknown };
    traceWarn(
      `lean handback: the rewind of ${branch} failed — ${String(e?.stderr ?? e?.message ?? err).slice(0, 200)}`,
    );
    return undefined;
  });
  if (ran === undefined) {
    // git refused, or never got as far as refusing. Either way origin is the
    // arbiter of what the record says: re-read the branch, and let its value name
    // the outcome. A push that failed for a reason nobody predicted would otherwise
    // print a lease refusal the operator could not check, and a branch that
    // nevertheless arrived at the verified head would be reported as unmoved.
    const refused = await originRef(exec, ctx.repoRoot, ref, opts.env ?? netEnv);
    return {
      shipped: false,
      unshippedHead: held,
      reason:
        refused === verifiedHead
          ? `origin holds the verified head ${verifiedHead.slice(0, 12)}, though ${unverifiedRef(ctx.issue)} is not readable there`
          : `origin still holds ${refused === undefined ? "an unreadable head" : refused.slice(0, 12)} — the lease refused the rewind`,
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
