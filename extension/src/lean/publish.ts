/*
 * lean/publish — push the run's branch and open its PR.
 *
 * The step is the first one that writes OUTSIDE the clone, so its whole design
 * is "do not act on a claim you did not read". In order:
 *
 *   1. the tree is the run's, at a real commit, on its branch, and CLEAN — a
 *      dirty tree would be published as bytes no commit holds;
 *   2. the spec is re-read from the forge, because the body's criterion map is
 *      a claim about a contract that is editable while the run goes on;
 *   3. the newest DECIDED `verify` verdict is read from the step log, and a
 *      green that was decided about a different commit than the one about to be
 *      pushed is REFUSED before the push — "green" is a claim about a named
 *      tree, and pushing something else under it is the one lie this step
 *      cannot take back;
 *   4. origin is read first (`remoteBranchSha`), an OPEN PR on the branch is
 *      refused with its URL, and the push ALWAYS carries a lease bound to the
 *      sha that read returned — so a rewrite is legitimate only because it was
 *      bound to an observed sha and survived the PR check; success is decided
 *      afterwards by reading origin again, never by parsing porcelain;
 *   5. the forge is asked for an OPEN PR on the branch FIRST and only then told
 *      to create one. A `prList` that throws aborts the step: creating without
 *      looking is how a resumed run opens a second PR for the same work.
 *
 * Everything the step cannot observe is a `PublishInfraError` — the engine turns
 * a throw into a handed-back run, which is the honest answer to "nobody looked".
 * Once the push has landed, every such error names the head and says the push
 * succeeded, because a handoff that reads "could not open the PR" over a branch
 * origin now holds would send the next run to look in the wrong place.
 * The recorded outcome carries `prUrl` and nothing else: `state-outcome.ts`
 * refuses that field on any other step, so it stays the run's only evidence
 * that a PR exists at an address.
 *
 * The step's own preconditions read the run's persisted state, so the push
 * target is data rather than a decision — `assertPublishableBranch` in
 * `publish-deps.ts` is what refuses a branch that is not the run's to push.
 */
import { existsSync } from "node:fs";
import type { NormalizedPullRequest } from "../forge-types.ts";
import { netRefProblem } from "../work-driver-net-git.ts";
import { testsFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import { challengeBudgetFromLog, publishBody } from "./publish-body.ts";
import { type PublishDeps, PublishInfraError, assertPublishableBranch } from "./publish-deps.ts";
import type { PublishForge } from "./publish-deps.ts";
import { parsePiSpec } from "./spec.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import { PR_URL, PR_URL_MAX_CHARS } from "./state-outcome.ts";
import { type Outcome, newestDecided } from "./state.ts";
import { oneLine } from "./text-fence.ts";

/** Run git in `wt`, rejecting a read that cannot answer as infrastructure. */
async function gitIn(
  deps: PublishDeps,
  wt: string,
  argv: string[],
  why: string,
  timeout = 30_000,
): Promise<string> {
  const ran = await deps
    .exec("git", { argv: [...NO_HOOKS, ...argv], cwd: wt, timeout, maxBuffer: 4 * 1024 * 1024 })
    .catch((err: unknown) => {
      throw new PublishInfraError(`${why}: ${(err as Error)?.message ?? String(err)}`);
    });
  return (ran?.stdout ?? "").trim();
}

/** The run's head, and the claims the tree must satisfy before anything is pushed. */
async function assertTree(
  deps: PublishDeps,
  ctx: HandlerCtx,
  wt: string,
  branch: string,
): Promise<string> {
  const head = await gitIn(deps, wt, ["rev-parse", "HEAD"], `could not read HEAD in ${wt}`);
  if (!/^[0-9a-f]{40}$/.test(head))
    throw new PublishInfraError(`could not read HEAD in ${wt} (got ${head.slice(0, 40)})`);
  const on = await gitIn(
    deps,
    wt,
    ["symbolic-ref", "--short", "-q", "HEAD"],
    "could not read the worktree's branch",
  );
  if (on !== branch) throw new PublishInfraError(`the worktree is not on ${branch}`);
  const status = await gitIn(
    deps,
    wt,
    ["status", "--porcelain", "--untracked-files=all"],
    "could not check whether the tree is clean",
  );
  if (status !== "")
    throw new PublishInfraError(
      `the worktree ${wt} is not clean — refusing to publish uncommitted bytes: ${status.slice(0, 500)}`,
    );
  return head;
}

/**
 * What origin's branch points at, or `undefined` when absent. A read that
 * cannot answer is infrastructure, never "absent".
 */
async function remoteBranchSha(
  deps: PublishDeps,
  wt: string,
  branch: string,
): Promise<string | undefined> {
  const [ref, why] = [`refs/heads/${branch}`, `could not read origin's ${branch}`];
  const out = await gitIn(deps, wt, ["ls-remote", "--heads", "origin", ref], why, 60_000);
  if (out === "") return undefined;
  // One line `<sha>\t<ref>`; a reply not naming the ref asked for is refused,
  // not read as "absent".
  const [sha = "", gotRef = ""] = out.split(/\s+/);
  if (gotRef !== ref || !/^[0-9a-f]{40}$/.test(sha))
    throw new PublishInfraError(`${why} (got ${out.slice(0, 120)})`);
  return sha;
}

/**
 * The head pushed to origin's branch under a lease bound to `remote` — the sha
 * this step read from origin moments before, or `""` when the read said the
 * branch is absent (git then requires the ref to STILL not exist).
 *
 * A forced update is legitimate here for exactly one reason: the lease binds the
 * rewrite to the sha we observed and the open-PR check passed on that same
 * branch, so nothing moves that this step did not read and clear. Hence no
 * `--no-verify`, no unconditional `--force`, and no `rev-list` heuristic about
 * how many commits separate the two tips — a realistic stale branch is 2-6
 * commits deep, and a count gate that admits only 1 never replaces one.
 *
 * Success is origin, read back after the push — never porcelain. `git push
 * --porcelain` prints a fast-forward UNBRACKETED (`abc..def`), so flag regexes
 * have already been observed reporting a push that landed as "no success flag",
 * and a rejection exits 0. So origin decides: origin at head is success whatever
 * the porcelain says, and the porcelain travels only as a diagnostic when it
 * does not.
 *
 * The ref name is checked with the driver's own `netRefProblem` BEFORE the
 * command line: `branch` is state-file data, and `assertSafeRef` only says it is
 * a legal git name — `+x`, `a:b` and `-f` all are, and git parses them as a
 * refspec, a force, or an option (see `netRefProblem`, #1095).
 */
async function pushHead(
  deps: PublishDeps,
  wt: string,
  head: string,
  branch: string,
  remote: string,
): Promise<void> {
  const unsafe = netRefProblem(`refs/heads/${branch}`);
  if (unsafe !== undefined) throw new PublishInfraError(`refusing to push ${branch}: ${unsafe}`);
  const ran = await deps
    .exec("git", {
      argv: [
        ...NO_HOOKS,
        "push",
        "--porcelain",
        `--force-with-lease=refs/heads/${branch}:${remote}`,
        "origin",
        `${head}:refs/heads/${branch}`,
      ],
      cwd: wt,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      killGroup: true,
    })
    .catch((err: unknown) => {
      const e = err as { stderr?: unknown; message?: string };
      const why = String(e?.stderr ?? e?.message ?? err).slice(0, 500);
      throw new PublishInfraError(`could not push ${branch}: ${why}`);
    });
  // Origin is read FIRST: if it holds this head the push landed whatever the
  // porcelain says, so the two rejection shapes git prints for one (`! [rejected]
  // …` and any `!`-flagged ref line) cannot refute an observed fact.
  const after = await remoteBranchSha(deps, wt, branch);
  if (after === head) return;
  // Only a ref that did NOT move is judged on its output, and then the porcelain
  // is a diagnostic appended to the refusal, never the reason for it.
  const out = typeof ran?.stdout === "string" ? ran.stdout : "";
  const porcelain =
    /\[rejected\]/.test(out) || /^\s*!/m.test(out)
      ? `; porcelain reported a rejection: ${out.slice(0, 500)}`
      : "";
  throw new PublishInfraError(
    `origin's ${branch} is ${after === undefined ? "absent" : after} after the push, expected ${head}${porcelain}`,
  );
}

/** States that are not under review, and therefore do not hold a rewrite back. */
const SETTLED_STATES: readonly string[] = ["CLOSED", "MERGED"];
const isSettled = (s: unknown) => typeof s === "string" && SETTLED_STATES.includes(s.toUpperCase());

/** Reuse an open PR on the branch, or create one. Never both. */
async function openPr(
  f: PublishForge,
  branch: string,
  issue: number,
  problem: string,
  body: string,
  draft: boolean,
): Promise<NormalizedPullRequest> {
  const open = await listOpenPrs(f, branch);
  const found = open.find((pr) => pr.headRefName === branch);
  if (found === undefined)
    return f.prCreate(`work-lean #${issue}: ${oneLineTitle(problem)}`, branch, body, { draft });
  // The PR is the PREVIOUS run's: `prCreate`'s `draft` option applies only to a
  // PR this step opens, so a reused one keeps whatever state it was left in. If
  // this run is not green, a ready PR must not stand behind an unverified head,
  // so it goes back to draft — and a `prDraft` that fails is infrastructure,
  // never a no-op: silently leaving it ready is the lie this step exists to
  // prevent. `gh pr list --json` carries no `isDraft`, so the state is read with
  // `prView` when the list did not say; a read that cannot answer is refused
  // rather than guessed at, because guessing "draft" is what would leave it ready.
  if (!draft) return found;
  if ((await draftStateOf(f, found)) === false) {
    await f.prDraft(found.number).catch((err: unknown) => {
      throw new PublishInfraError(
        `could not put the reused PR #${found.number} back to draft: ${(err as Error)?.message ?? String(err)}`,
      );
    });
    // A `prDraft` that returned without throwing is a CLAIM, not an observation:
    // the head is already pushed at this point, so a forge that accepted the call
    // and left the PR READY would hand back `ok` with a mergeable PR standing
    // behind unverified bytes — the exact lie the step exists to prevent. Read
    // it back; only `isDraft === true` is an answer that lets the run continue.
    const after = await f
      .prView(found.number)
      .then((v) => v?.isDraft)
      .catch(() => undefined);
    if (after !== true)
      throw new PublishInfraError(
        `the reused PR #${found.number} does not report itself a draft after prDraft, and a not-green run must not leave it ready`,
      );
  }
  return found;
}

/**
 * Whether a reused PR reports itself ready, asked of the forge when the list
 * reply did not carry the flag (`gh pr list --json` has no `isDraft`).
 *
 * Throws when neither reply said: a run that cannot tell must not decide the PR
 * is already a draft, because that decision is exactly what leaves an unverified
 * PR mergeable.
 */
async function draftStateOf(f: PublishForge, pr: NormalizedPullRequest): Promise<boolean> {
  if (pr.isDraft !== undefined) return pr.isDraft;
  // The rejection message is kept rather than swallowed: "could not tell" is
  // true either way, but an operator reading the handoff has to be able to tell
  // a forge that was unreachable from one that answered with neither field.
  let why: string | undefined;
  const viewed = await f
    .prView(pr.number)
    .then((v) => v?.isDraft)
    .catch((err: unknown) => {
      why = (err as Error)?.message ?? String(err);
      return undefined;
    });
  if (viewed !== undefined) return viewed;
  throw new PublishInfraError(
    `could not tell whether the reused PR #${pr.number} is a draft, and a not-green run must not leave it ready${why === undefined ? "" : ` (${why})`}`,
  );
}

/** A PR title is one line, and the issue's problem statement is not. */
function oneLineTitle(problem: string): string {
  return oneLine(problem, 72);
}

/**
 * The forge's open PRs for `branch`, or infrastructure. The list is scoped by
 * `sourceBranch`, so every row in it is a row about THIS branch.
 *
 * Looking and failing is not the same as finding nothing: pushing or creating
 * without the answer is how a resumed run rewrites a branch under review, or ends
 * up with two PRs for one issue.
 */
async function listOpenPrs(f: PublishForge, branch: string): Promise<NormalizedPullRequest[]> {
  const open = await f.prList({ state: "open", sourceBranch: branch }).catch((err: unknown) => {
    throw new PublishInfraError(
      `could not list open PRs for ${branch}: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  return open ?? [];
}

/**
 * What origin's branch points at, as the lease's expected value: `""` when the
 * ref is absent, `head` when it already matches (the push is then skipped).
 *
 * Any OTHER sha means this step is about to rewrite a branch, so it first asks
 * the forge whether that branch is under review — and the check FAILS CLOSED:
 * the list was asked for THIS branch, so ANY row it returns blocks unless its
 * state positively reads CLOSED or MERGED once uppercased, whatever its
 * `headRefName`. A lowercase `"open"`, an empty string or a missing head branch
 * must refuse, not read as "no PR": `mapPrListReply` in `forge-list.ts`
 * synthesises `state: ""` for a forge that answered with one bare number, and an
 * exact `=== "OPEN"` comparison — or a head-branch match this step cannot rely
 * on — would force-push over a branch somebody is reviewing.
 */
async function pushLeaseTarget(
  deps: PublishDeps,
  f: PublishForge,
  wt: string,
  head: string,
  branch: string,
): Promise<string> {
  // The ref is read first and the forge is asked second, so the lease is bound to
  // the value the forge check was about. A move after this read fails the lease
  // at push time, which is the window the lease exists to close.
  const remote = (await remoteBranchSha(deps, wt, branch)) ?? "";
  if (remote === "" || remote === head) return remote;
  // Not having looked is no licence to rewrite a branch somebody may be reading.
  const blocking = (await listOpenPrs(f, branch)).find((pr) => !isSettled(pr.state));
  if (blocking !== undefined)
    throw new PublishInfraError(
      `refusing to rewrite ${branch}: the forge returned an unsettled PR row (${blocking.url || "(no URL returned)"})`,
    );
  return remote;
}

/**
 * The `publish` step. Returns `ok` with `prUrl`; THROWS on infrastructure.
 *
 * `deps.forge` is the seam a test drives: production resolves the real adapter
 * and a case hands in a recorder, so the push assertions stay against a real
 * bare origin while the forge calls stay observable.
 */
export async function publishOutcome(ctx: HandlerCtx, deps: PublishDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const branch = specifyBranch(ctx.run.branch, issue);
  // Before a single git read, let alone a push: the branch is state-file data,
  // and `assertSafeRef` inside the guard only says it is a legal ref — `main`
  // is. The guard lives in publish-deps so the step's decisions stay separate
  // from what it asks the outside world.
  await assertPublishableBranch(repoRoot, branch);
  const wt = specifyWorktreePath(repoRoot, issue);
  if (!existsSync(wt)) throw new PublishInfraError(`the worktree ${wt} does not exist`);

  const head = await assertTree(deps, ctx, wt, branch);

  const fetched = await deps.fetchBody(repoRoot, issue).catch((err: unknown) => {
    throw new PublishInfraError(
      `could not read the issue: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  const parsed = parsePiSpec(fetched);
  if (!parsed.ok) throw new PublishInfraError(`the issue's spec is unusable: ${parsed.reason}`);
  const spec = parsed.spec;

  // Resolved ONCE: the stale-branch check and the PR check are two questions of
  // one adapter, and resolving twice is two chances to get two different answers.
  const f = await deps.forge(repoRoot);

  const v = newestDecided(ctx.steps, "verify");
  const verifyKind =
    v?.outcome?.kind === "green" || v?.outcome?.kind === "red" ? v.outcome.kind : undefined;
  if (verifyKind === "green" && v?.outcome?.verifiedHead !== head)
    throw new PublishInfraError("HEAD moved since verify");

  const draft =
    ctx.run.counters.draft === true ||
    verifyKind !== "green" ||
    spec.criteria.some((c) => c.verify === "manual") ||
    // A `command` criterion the gate could not run is a criterion nobody checked,
    // and a ready PR behind an unchecked criterion is the claim this step exists to
    // refuse — so it holds the PR as a draft exactly as a `manual` criterion does.
    spec.criteria.some((c) => c.verify === "command" && !v?.outcome?.commandCriteria?.[c.id]);

  // Read origin, clear the branch against the forge, then push under a lease
  // bound to that read. A move between the read and the push makes the lease
  // refuse, which is the race the lease exists to close. When origin already holds
  // this head there is nothing to write, and the step says so rather than pushing
  // a no-op it cannot verify.
  if (f === undefined)
    throw new PublishInfraError(`no forge adapter: cannot check ${branch} is in review`);
  const remote = await pushLeaseTarget(deps, f, wt, head, branch);
  const wrote = remote !== head;
  if (wrote) await pushHead(deps, wt, head, branch, remote);
  // From here on the head is OUTSIDE the clone. Every refusal below is a
  // handback over a pushed branch, so it says so — an error that reads only
  // "could not open the PR" hides the one fact the operator needs first. When
  // origin already held this head nothing was written, so the text says so.
  const pushed = (what: string) =>
    new PublishInfraError(
      `${wrote ? `pushed ${head.slice(0, 12)} to ${branch}` : `${branch} is already on origin`}, but ${what}`,
    );

  if (f === undefined) throw pushed("no forge adapter: cannot open the PR");
  const pr = await openPr(
    f,
    branch,
    issue,
    spec.problem,
    publishBody({
      issue,
      spec,
      tests: testsFromLog(ctx.steps),
      verifyKind,
      // `verifiedHead` is the green verdict's subject. A red record's head (or
      // one left over from an older green) printed under a red verdict would
      // read as "this commit passed", so it travels with a green only.
      ...(verifyKind === "green" && v?.outcome?.verifiedHead !== undefined
        ? { verifiedHead: v.outcome.verifiedHead }
        : {}),
      ...(v?.outcome?.reason === undefined ? {} : { verifyReason: v.outcome.reason }),
      ...(v?.outcome?.commandCriteria === undefined
        ? {}
        : { commandCriteria: Object.keys(v.outcome.commandCriteria) }),
      ...(v?.outcome?.commandNotRunnable === undefined
        ? {}
        : { commandNotRunnable: v.outcome.commandNotRunnable }),
      // The optional adversary round that ran out of its own ceiling, read off
      // the log rather than out of a closure, so a resumed run prints the same
      // line a live one would. The reader's object IS the pair (`{limit, value}`)
      // and is WRAPPED here, never spread: spreading it would hand `publishBody`
      // two fields it never reads and drop the line without a sound. `undefined`
      // under the key is the same absence to the renderer as no key at all.
      challengeBudget: challengeBudgetFromLog(ctx.steps),
      draft,
      version: ctx.run.version,
      models: ctx.run.models,
      baseSha: ctx.run.baseSha,
    }),
    draft,
  ).catch((err: unknown) => {
    // `openPr` already raises PublishInfraErrors whose text names the failure
    // (a rejected list, a refused re-draft); the prefix says what the operator
    // must know first — the push landed.
    if (err instanceof PublishInfraError) throw pushed(err.message);
    throw pushed(`the forge could not open the PR: ${(err as Error)?.message ?? String(err)}`);
  });

  const prUrl = pr?.url;
  if (prUrl === undefined || !PR_URL.test(prUrl))
    throw pushed("the forge returned no usable PR URL");
  if (prUrl.length > PR_URL_MAX_CHARS)
    throw pushed(`the forge returned a PR URL longer than ${PR_URL_MAX_CHARS} characters`);

  return {
    kind: "ok",
    prUrl,
    reason: `${wrote ? "published" : "already on origin, published"} ${draft ? "draft " : ""}PR ${prUrl} at ${head.slice(0, 12)}`,
  };
}
