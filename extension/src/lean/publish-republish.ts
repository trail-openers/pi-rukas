/*
 * lean/publish-republish — may `lean/publish` rewrite a branch origin already holds?
 *
 * `publish.ts` reads origin, pushes under a lease, and opens or reuses the PR; this
 * module holds the one decision that sits between those two facts — whether an
 * UNSETTLED PR row on the branch is a reason to refuse, or the run looking at its own
 * PR. `pushLeaseTarget` is the only caller.
 *
 * The reading of PR STATE is fail-closed — a lowercase `"open"`, an empty string or a
 * missing head branch is a row this step has not cleared, and it blocks. A row may be
 * exempted only after three independent reads agree: origin's ref,
 * the run's own step log, and the forge's row list.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import type { NormalizedPullRequest } from "../forge-types.ts";
import type { PublishDeps, PublishForge } from "./publish-deps.ts";
import { PublishInfraError } from "./publish-deps.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { type Step, newestDecided } from "./state.ts";

/** What the run's newest DECIDED `publish` recorded about the branch it wrote. */
export interface OwnPublishRecord {
  prUrl: string;
  publishedHead: string;
}

/** The forge's open PRs for `branch`, or infrastructure. The list is scoped by
 *  `sourceBranch`, so every row in it is a row about THIS branch.
 *
 * Looking and failing is not the same as finding nothing: pushing or creating
 * without the answer is how a resumed run rewrites a branch under review, or ends
 * up with two PRs for one issue. */
export async function listOpenPrs(
  f: PublishForge,
  branch: string,
): Promise<NormalizedPullRequest[]> {
  const open = await f.prList({ state: "open", sourceBranch: branch }).catch((err: unknown) => {
    throw new PublishInfraError(
      `could not list open PRs for ${branch}: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  return open ?? [];
}

/** States that are not under review, and therefore do not hold a rewrite back. */
const SETTLED_STATES: readonly string[] = ["CLOSED", "MERGED"];
const isSettled = (s: unknown) => typeof s === "string" && SETTLED_STATES.includes(s.toUpperCase());

/**
 * What origin's branch points at, as the lease's expected value: `""` when the ref is
 * absent, `head` when it already matches (the push is then skipped).
 *
 * Any OTHER sha means this step is about to rewrite a branch, so it first asks the
 * forge whether that branch is under review — and the check FAILS CLOSED: the list
 * was asked for THIS branch, so ANY row it returns blocks unless its state positively
 * reads CLOSED or MERGED once uppercased, whatever its `headRefName`.
 *
 * `readRemote` is the caller's origin read, passed in rather than re-asked: the lease
 * must bind to the value the forge check was about, so the two reads have to be one
 * read. `own` is what the run's newest DECIDED `publish` recorded (`ownPublishRecord`),
 * and `undefined` — a first publish, a publish that never decided — means no exemption
 * is even considered.
 */
export async function pushLeaseTarget(
  deps: PublishDeps,
  f: PublishForge,
  wt: string,
  head: string,
  branch: string,
  readRemote: () => Promise<string | undefined>,
  own: OwnPublishRecord | undefined,
): Promise<string> {
  // The ref is read first and the forge is asked second, so the lease is bound to
  // the value the forge check was about. A move after this read fails the lease
  // at push time, which is the window the lease exists to close.
  const remote = (await readRemote()) ?? "";
  if (remote === "" || remote === head) return remote;
  // Not having looked is no licence to rewrite a branch somebody may be reading.
  const unsettled = (await listOpenPrs(f, branch)).filter((pr) => !isSettled(pr.state));
  // The forge is asked on the exempt arm too — the row's identity is READ, never
  // inferred from the record, and this is the same list `openPr` reuses below.
  if (await ownOpenPrExemption(deps, wt, branch, head, remote, own, unsettled)) return remote;
  // The refusal is byte-identical on every arm: with no record to compare against, or
  // with a row that is not this run's own.
  const blocking = unsettled[0];
  if (blocking !== undefined)
    throw new PublishInfraError(
      `refusing to rewrite ${branch}: the forge returned an unsettled PR row (${blocking.url || "(no URL returned)"})`,
    );
  return remote;
}

/**
 * The head this run's own record says origin should be holding, or `undefined`.
 *
 * `newestDecided` — not the last publish ENTRY: a write-ahead entry has no outcome and
 * says nothing. Both of publish's arms record what origin holds after the step (the
 * pushing arm leaves origin at `head`; `already on origin` means origin already was),
 * so no write-marker is needed. A first publish, or a resumed run whose publish never
 * decided, has no record and gets no exemption.
 */
export function ownPublishRecord(steps: Step[]): OwnPublishRecord | undefined {
  const o = newestDecided(steps, "publish")?.outcome;
  const prUrl = o?.prUrl;
  const publishedHead = o?.publishedHead;
  if (typeof prUrl !== "string" || prUrl === "") return undefined;
  if (typeof publishedHead !== "string" || !isFullCommitSha(publishedHead)) return undefined;
  return { prUrl, publishedHead };
}

/**
 * Whether the ONLY reason this branch is blocked is the PR this very run opened, or
 * `undefined` when it is not. `undefined` is today's refusal, so the predicate fails
 * closed on every half of it.
 *
 * All of these must hold, each read from a source the step cannot wish away:
 *
 *   - the run's newest DECIDED `publish` recorded both a `prUrl` and a 40-hex
 *     `publishedHead` (`ownPublishRecord`);
 *   - origin holds EXACTLY that recorded sha — so nothing else has moved the branch
 *     since this run wrote it;
 *   - that sha is an ANCESTOR of the head about to be pushed, so this push is a
 *     fast-forward over the run's own history rather than a rewrite of someone's;
 *   - the forge returned EXACTLY ONE unsettled row for the branch, its `url` is
 *     byte-for-byte the recorded `prUrl`, and it is the row `openPr` will reuse
 *     (`headRefName === branch`) — so a second open row, or a row `openPr` would
 *     resolve instead, keeps the refusal.
 *
 * The ancestry read fails CLOSED as infrastructure: git's own exit 1 is the definitive
 * "not a fast-forward" and refuses, while any other non-zero outcome — a kill, a
 * timeout, an unresolvable rev — is a `PublishInfraError` naming both shas. A read
 * that could not answer is never a quiet `undefined` that reads as "no".
 */
async function ownOpenPrExemption(
  deps: PublishDeps,
  wt: string,
  branch: string,
  head: string,
  remote: string,
  own: OwnPublishRecord | undefined,
  unsettled: readonly NormalizedPullRequest[],
): Promise<boolean> {
  if (own === undefined) return false;
  // Two unsettled rows on one branch have no single identity for "this run's own PR".
  if (unsettled.length !== 1) return false;
  const row = unsettled[0];
  if (row === undefined) return false;
  if (row.url !== own.prUrl) return false;
  // Not the row `openPr` reuses is not the row this run opened.
  if (row.headRefName !== branch) return false;
  if (remote !== own.publishedHead) return false;
  return headDescendsFrom(deps, wt, own.publishedHead, head, branch);
}

/**
 * Is `ancestor` an ancestor of `descendant`, asked of git in the run's worktree
 * (`merge-base --is-ancestor`, the three-valued probe the driver's own lease code
 * uses). Both revs are named as arguments, never as one rev-range string, so a sha
 * git cannot resolve is this call's failure rather than a match against something else.
 */
async function headDescendsFrom(
  deps: PublishDeps,
  wt: string,
  ancestor: string,
  descendant: string,
  branch: string,
): Promise<boolean> {
  const ran = await deps
    .exec("git", {
      argv: [...NO_HOOKS, "merge-base", "--is-ancestor", ancestor, descendant],
      cwd: wt,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    .then(() => ({ code: 0 as number | undefined, why: undefined }))
    .catch((err: unknown) => ({
      code: (err as { code?: unknown })?.code as number | undefined,
      why: String((err as { message?: unknown })?.message ?? err).slice(0, 200),
    }));
  if (ran.code === 0) return true;
  // git's own definitive NO: origin does not hold this run's history, so the push
  // would rewrite somebody else's commits.
  if (ran.code === 1) return false;
  // Anything else — an exit that is neither of git's two answers, a child that died,
  // a kill, a call that threw before it ran — is a read that never answered, and a
  // read that never answered is never read as "no".
  throw new PublishInfraError(
    `could not tell whether ${descendant.slice(0, 12)} descends from ${ancestor.slice(0, 12)} on ${branch} (git merge-base --is-ancestor ${ran.code === undefined ? `failed: ${ran.why ?? "no reason given"}` : `exited ${String(ran.code)}`})`,
  );
}
