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
  /** Origin's branch as this step read it — the unverified head the run left there. */
  unshippedHead?: string;
  /** Why nothing moved, in the record's own words, when `shipped` is false. */
  reason?: string;
}

/** Nothing to move: the log said the rule applies but named no head. */
export const NO_HEAD: Rewind = {
  shipped: false,
  reason: "no verified head was recorded, so nothing was moved",
};

/** A rewind that never ran because the operator switched the rule off. */
export const SWITCHED_OFF: Rewind = { shipped: false };

/** The ref that holds the head the rewind moved off, so it is not lost to a GC. */
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
  const out = await quiet(exec, cwd, ["ls-remote", "--heads", "origin", ref], env);
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
  if (!isFullCommitSha(verifiedHead))
    return {
      shipped: false,
      reason: `the recorded verified head ${verifiedHead.slice(0, 12)} is not a full commit sha`,
    };

  // Read FIRST: the sha this read returns is both the lease's expected value
  // and the head the record names as unshipped. A read that cannot answer is
  // not "absent" — moving a branch on the strength of a read that failed is
  // exactly what the lease exists to refuse.
  const held = await originRef(exec, ctx.repoRoot, ref, opts.env ?? netEnv);
  if (held === undefined)
    return {
      shipped: false,
      reason: `could not read origin's ${branch}, so nothing was moved`,
    };
  if (held === verifiedHead) return { shipped: true, unshippedHead: held };

  // Keep the head the run pushed reachable before anything rewrites the branch
  // away from it. A ref-move failure here refuses the rewind: shipping a head
  // whose alternative would become unreachable is not a trade this step makes.
  const kept = await quiet(
    exec,
    ctx.repoRoot,
    ["update-ref", unverifiedRef(ctx.issue), held],
    opts.env,
  );
  if (kept === undefined)
    return {
      shipped: false,
      unshippedHead: held,
      reason: `could not keep ${held.slice(0, 12)} under ${unverifiedRef(ctx.issue)}, so nothing was moved`,
    };

  const ran = await exec("git", {
    argv: [
      ...NO_HOOKS,
      "push",
      `--force-with-lease=${ref}:${held}`,
      "origin",
      `${verifiedHead}:${ref}`,
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
  if (ran === undefined)
    return { shipped: false, unshippedHead: held, reason: `the push of ${branch} did not run` };

  // Origin decides, never the porcelain: read back and compare.
  const after = await originRef(exec, ctx.repoRoot, ref, opts.env ?? netEnv);
  if (after === verifiedHead) return { shipped: true, unshippedHead: held };
  return {
    shipped: false,
    unshippedHead: held,
    reason: `origin still holds ${after === undefined ? "an unreadable head" : after.slice(0, 12)} — the lease refused the rewind`,
  };
}
