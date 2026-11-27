/**
 * lean/handback-rewind — move origin's branch back to the last verified head.
 *
 * A run can end with origin holding a head no gate certified. The answer is one ref move before the handback
 * comment: keep the unverified head under a ref of its own, then rewind the branch to the newest green
 * `verify`'s head.
 *
 * The move is a lease-pinned atomic push — `--atomic`, `--force-with-lease=<branch>:<held>`, an UNFORCED
 * branch refspec, where `<held>` is the head this step read off origin, not the one the run pushed. The lease
 * guards one window: a branch that moved between the read and the push is refused and nothing moves.
 *
 * Being unforced makes the lease real: `git push` does not consult the lease for a refspec with a leading
 * `+`, and a rewind is a non-fast-forward move the lease alone authorises.
 *
 * The branch is state-file data, so it gets `assertPublishableBranch`. Origin is read BEFORE the push (the
 * lease binds to that read) and AGAIN after it; success is origin holding the verified head, whatever git
 * printed. Every refusal is a `Rewind` with a reason, never a throw.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { traceWarn } from "../trace.ts";
import { netGitEnv, netRefProblem, runNetGit } from "../work-driver-net-git.ts";
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
   * The head the run pushed that this step moved off — set only where the rewind moved it; the caller
   * reads it as "the unverified head the run left behind".
   */
  unshippedHead?: string;
  /** Why nothing moved, in the record's own words, when `shipped` is false. */
  reason?: string;
  /**
   * The HEAD RULE's words for why there was no head to move. Distinct from `reason`, which explains a push
   * that did not happen; this explains the finding that there was nothing to push to.
   */
  noHeadReason?: string;
  /**
   * Origin already held the certified head — the outcome the rule wants, from an earlier step. The caller
   * must not print the head it ships as unverified.
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
  // One origin read, one shape: {@link originRead} is the only call this file makes.
  return originRead(exec, ctx.repoRoot, ref);
}

/** Nothing to move: the rule fired and the log named no head to go back to. */
export const NO_HEAD: Rewind = {
  shipped: false,
  reason: "no verified head was recorded, so nothing was moved",
};

/**
 * The ref holding the head the rewind moved off, so it is not lost to a GC. Under `refs/lean/` rather than
 * `refs/heads/` so it is not a branch: it names no PR and no merge target.
 */
export function unverifiedRef(issue: number): string {
  return `refs/lean/unverified/${String(issue)}`;
}

/**
 * Whether git said the words a lease refusal says.
 *
 * `--force-with-lease` is enforced client-side: when origin's value for the leased ref is not what this
 * push expected, the porcelain prints `stale info`. That is the ONLY wording admitted — anything else that
 * failed the push never reached the lease check, and calling it a lease refusal would send the operator to
 * hunt who moved their branch when the fix is a fetch.
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

/**
 * Does this clone hold `sha` as a commit — yes, no, or could git not be asked?
 *
 * `git cat-file -e <sha>^{commit}` answers on its RESULT, not an exit code the caller hunts: the executor
 * RESOLVES for an object and REJECTS for an absent one. The `^{commit}` peel makes a blob or tree at that
 * oid answer `false`.
 *
 * `undefined` is the third answer and stays separate from `false`: "git did not answer" is not evidence.
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
    // Only a git that RAN and refused may say `false`: a rejection with no exit information is an executor
    // that could not be called, and a killed or signalled git carried no answer.
    if (typeof e?.code !== "number" || e.killed === true || e.signal != null) return undefined;
    return false;
  }
}

/** One `ls-remote` reply's sha, or `undefined` when the read did not answer with one. */
function readSha(stdout: string | undefined): string | undefined {
  const out = (stdout ?? "").trim();
  if (out === "") return undefined;
  const [sha = ""] = out.split(/\s+/);
  return isFullCommitSha(sha) ? sha : undefined;
}

/**
 * The read this clone makes of one origin ref, as a network git call.
 *
 * An origin read is asked over the transport the push itself uses, so it goes through the network wrapper:
 * the non-interactive env (a credential prompt fails instead of reading /dev/tty), the process-group kill
 * (a plain call is cut only at its direct child, so an ssh grandchild holding stdout outlives the ceiling)
 * and the wrapper's own bound.
 */
async function originRead(exec: VerifyExec, cwd: string, ref: string): Promise<string | undefined> {
  const ran = await runNetGit(exec, "git", {
    argv: [...NO_HOOKS, "ls-remote", "origin", ref],
    cwd,
    timeoutMs: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(() => undefined);
  return readSha(ran?.stdout);
}

/**
 * Rewind origin's branch to `verifiedHead` and keep the head it held.
 *
 * `dir` is any clone of origin — the move names both shas on the command line rather than reading a
 * working tree. Every refusal is a `Rewind` with `shipped: false`, never a throw: the reporting step always
 * answers.
 */
export async function rewindToVerified(
  exec: VerifyExec,
  ctx: Pick<HandlerCtx, "repoRoot" | "issue" | "run">,
  verifiedHead: string,
  opts: { env?: NodeJS.ProcessEnv; net?: boolean } = {},
): Promise<Rewind> {
  const branch = specifyBranch(ctx.run.branch, ctx.issue);
  const ref = `refs/heads/${branch}`;
  // The push is the one call that leaves the clone, so it gets the non-interactive net env.
  const netEnv = opts.net === true ? netGitEnv(process.env, ctx.repoRoot) : undefined;
  const pushEnv = opts.env ?? netEnv;
  // A branch name is state-file data, and `netRefProblem` only says it is a legal git name — `+x` and
  // `a:b` are legal too, and git reads them as a force or a refspec.
  const unsafe = netRefProblem(ref);
  if (unsafe !== undefined)
    return { shipped: false, reason: `the branch is not pushable: ${unsafe}` };
  // Legality is one thing, permission another: the guard throws `PublishInfraError` at its callers; here
  // the refusal is a `Rewind`.
  const pushable = await assertPublishableBranch(ctx.repoRoot, branch, exec).then(
    () => undefined,
    (err: unknown) =>
      err instanceof PublishInfraError ? err.message : String((err as Error)?.message ?? err),
  );
  if (pushable !== undefined)
    return { shipped: false, reason: `the branch is not pushable: ${pushable}` };
  // `held` is read BEFORE the sha check: a read that cannot answer is no licence to claim a head shipped.
  const held = await originRead(exec, ctx.repoRoot, ref);
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
  // Shape is not existence: `verifiedHead` round-trips through the on-disk state file, so this clone may
  // hold no such object.
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

  // Origin already holds the certified head but this step did not produce that: no push, no keep, and
  // `shipped: true` would claim a move never made. `headFacts` in handback.ts is what stops the `unshippedHead`
  // this arm also carries from printing as unshipped.
  if (held === verifiedHead)
    return {
      shipped: false,
      alreadyAtVerified: true,
      unshippedHead: held,
      reason: `origin already holds the verified head ${held.slice(0, 12)}, so this step moved nothing`,
    };

  // One push, two refspecs: the branch moves back to the verified head and the head it moved off gains its
  // keeping-ref on origin — on BOTH sides of the wire, since a ref written in the clone alone dies with the
  // worktree. They must be ONE transaction: git applies each ref on its own by default, so `--atomic` is
  // the only reading of "nothing of it is moved".
  //
  // Deliberately no local `update-ref` first: a ref can only be written from an object this clone holds,
  // and on the refusal path origin's head may be one it has never seen.
  //
  // The lease carries its EXPECTED value (`<ref>:<held>`) — the bare form compares origin against this
  // clone's remote-tracking ref, which only a `fetch` refreshes. The branch refspec must NOT be forced:
  // git skips the lease for a leading `+`, and a rewind is a non-fast-forward move by definition, so the
  // lease names the one value this step read off origin that authorises it.
  const pushArgv = [
    ...NO_HOOKS,
    "push",
    "--atomic",
    `--force-with-lease=${ref}:${held}`,
    "origin",
    `${verifiedHead}:${ref}`,
    `${held}:${unverifiedRef(ctx.issue)}`,
  ];
  // A push git rejected comes back as the stderr it printed; one that ran as `undefined`.
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
    // The lease is not the only reason a push says no: a clone that never fetched a third party's head
    // fails with `bad object` / `unpacker error`, and the two need different operator actions.
    const refused = await originRead(exec, ctx.repoRoot, ref);
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

  // Origin decides, never the porcelain: compare BOTH names, since a rewind that moved the branch and lost
  // the keeping-ref would have thrown the unverified head away.
  const [after, keptOnOrigin] = await Promise.all([
    originRead(exec, ctx.repoRoot, ref),
    originRead(exec, ctx.repoRoot, unverifiedRef(ctx.issue)),
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
