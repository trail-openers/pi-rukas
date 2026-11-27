/*
 * lean/publish — push the run's branch and open its PR.
 *
 * The step is the first one that writes OUTSIDE the clone, so its whole design is
 * "do not act on a claim you did not read". In order:
 *
 *   1. the tree is the run's, at a real commit, on its branch, and CLEAN — a dirty
 *      tree would be published as bytes no commit holds;
 *   2. the spec is re-read from the forge, because the body's criterion map is a
 *      claim about a contract that is editable while the run goes on;
 *   3. the newest DECIDED `verify` verdict is read from the step log, and a green
 *      decided about a different commit than the one about to be pushed is REFUSED
 *      before the push: "green" is a claim about a named tree.
 *   4. origin is read first (`remoteBranchSha`), an OPEN PR on the branch is
 *      refused with its URL, and the push ALWAYS carries a lease bound to the sha
 *      that read returned — so a rewrite is legitimate only because it was bound to
 *      an observed sha and survived the PR check; success is decided afterwards by
 *      reading origin again, never by parsing porcelain. The one unsettled row this
 *      run opened itself may be exempted, but only against all three reads at once
 *      (origin's ref, this run's own step log, and the forge's rows), in
 *      `publish-republish.ts`.
 *   5. the forge is asked for an OPEN PR on the branch FIRST and only then told to
 *      create one. A `prList` that throws aborts the step: creating without looking
 *      is how a resumed run opens a second PR for the same work.
 *
 * Everything the step cannot observe is a `PublishInfraError` — the engine turns a
 * throw into a handed-back run. Once the push has landed, every such error names the
 * head and says the push succeeded, so a handoff never sends the next run looking in
 * the wrong place. The recorded outcome carries `prUrl` and nothing else:
 * `state-outcome.ts` refuses that field on any other step, so it stays the run's only
 * evidence that a PR exists at an address.
 */
import { existsSync } from "node:fs";
import type { NormalizedPullRequest } from "../forge-types.ts";
import { specBlockProblem } from "../issue-spec-block.ts";
import { netRefProblem } from "../work-driver-net-git.ts";
import { testsFromLog } from "../lean-log.ts";
import type { HandlerCtx } from "./engine.ts";
import { challengeBudgetFromLog, challengeSkipReasonFromLog, publishBody } from "./publish-body.ts";
import { type PublishDeps, PublishInfraError, assertPublishableBranch } from "./publish-deps.ts";
import type { PublishForge } from "./publish-deps.ts";
import { createdDraftState, reusedDraftState } from "./publish-draft.ts";
import { listOpenPrs, ownPublishRecord, pushLeaseTarget } from "./publish-republish.ts";
import { specFor, specSource } from "./spec-for.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import { PR_URL, PR_URL_MAX_CHARS } from "./state-outcome.ts";
import { type Outcome, newestDecided } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

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
 * The head pushed to origin's branch under a lease bound to `remote` — the sha this
 * step read from origin moments before, or `""` when the read said the branch is
 * absent (git then requires the ref to STILL not exist).
 *
 * A forced update is legitimate here for exactly one reason: the lease binds the
 * rewrite to the sha we observed and the open-PR check passed on that same branch,
 * so nothing moves that this step did not read and clear. Hence no `--no-verify`, no
 * unconditional `--force`, and no `rev-list` heuristic about how far apart the tips
 * are — a realistic stale branch is 2-6 commits deep, and a count gate admitting only
 * 1 never replaces one.
 *
 * Success is origin, read back after the push — never porcelain. `git push
 * --porcelain` prints a fast-forward UNBRACKETED (`abc..def`), so flag regexes have
 * been observed reporting a landed push as "no success flag", and a rejection exits 0.
 * Origin decides; the porcelain travels only as a diagnostic.
 *
 * The ref name is checked with the driver's own `netRefProblem` BEFORE the command
 * line: `branch` is state-file data, and `assertSafeRef` only says it is a legal git
 * name — `+x`, `a:b` and `-f` all are, and git parses them as a refspec, a force, or
 * an option.
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

/**
 * Reuse an open PR on the branch, or create one. Never both.
 *
 * A created PR is titled with the issue's WHOLE title, never cut, as the classic driver's PR and the lean
 * squash subject are: a cut title is a sentence that stops. It is an argv value, not markdown, so nothing in
 * it is escaped; only whitespace runs fold, because a title is one line.
 */
async function openPr(
  f: PublishForge,
  branch: string,
  issue: number,
  body: () => Promise<string>,
  draft: boolean,
): Promise<NormalizedPullRequest> {
  const open = await listOpenPrs(f, branch);
  const found = open.find((pr) => pr.headRefName === branch);
  if (found === undefined) {
    const title = (await f.issueView(issue)).title.replace(/\s+/g, " ").trim();
    if (title === "")
      throw new PublishInfraError(`issue #${issue} has no title to open the PR with`);
    const created = await f.prCreate(
      `work-lean #${issue}: ${title}`,
      branch,
      // Built only here: a reused PR keeps its creation body, so nothing is paid for it.
      await body(),
      { draft },
    );
    return { ...created, isDraft: await createdDraftState(f, created) };
  }
  return reusedDraftState(f, found, draft);
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
  // from what it asks the outside world. The step's OWN executor is handed to the
  // guard so the probes it makes go the way the push goes — the same seam a suite
  // drives, and the same transport origin will be asked over.
  await assertPublishableBranch(repoRoot, branch, deps.exec);
  const wt = specifyWorktreePath(repoRoot, issue);
  if (!existsSync(wt)) throw new PublishInfraError(`the worktree ${wt} does not exist`);

  const head = await assertTree(deps, ctx, wt, branch);

  const fetched = await deps.fetchBody(repoRoot, issue).catch((err: unknown) => {
    throw new PublishInfraError(
      `could not read the issue: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  // The accessor: this step prints the contract onto the PR, so the body must
  // describe the criteria the run was built and verified against — for a derived
  // run those live on the record, not on the issue.
  const read = specFor(fetched, ctx.run);
  if (!read.ok) throw new PublishInfraError(`the issue's spec is unusable: ${read.reason}`);
  const spec = read.spec;
  const approved = await deps.issueSpec(issue).catch((err: unknown) => {
    throw new PublishInfraError(
      `could not read the issue: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  const dispatches: DispatchUsageRow[] = [];

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
  // The record of the run's OWN last push (its newest DECIDED publish) travels to the
  // lease check as data: the exemption it can grant is read against origin, the step
  // log and the forge's row list together, never from this record alone.
  const remote = await pushLeaseTarget(
    deps,
    f,
    wt,
    head,
    branch,
    () => remoteBranchSha(deps, wt, branch),
    ownPublishRecord(ctx.steps),
  );
  const wrote = remote !== head;
  if (wrote) await pushHead(deps, wt, head, branch, remote);
  // From here on the head is OUTSIDE the clone. Every refusal below is a
  // handback over a pushed branch, so it says so — an error that reads only
  // "could not open the PR" hides the one fact the operator needs first. When
  // origin already held this head nothing was written, so the text says so.
  // The rows ride on the error too: a spec-check child that ran before the refusal still spent its tokens.
  const pushed = (what: string) =>
    Object.assign(
      new PublishInfraError(
        `${wrote ? `pushed ${head.slice(0, 12)} to ${branch}` : `${branch} is already on origin`}, but ${what}`,
      ),
      { dispatches },
    );

  if (f === undefined) throw pushed("no forge adapter: cannot open the PR");
  const pr = await openPr(
    f,
    branch,
    issue,
    async () => {
      // The host's block: each requirement judged at this head by one read-only child.
      const block = approved?.block === 1 ? await deps.specBlock(approved, wt, head) : undefined;
      dispatches.push(...(block?.dispatches ?? []));
      const text = publishBody({
        issue,
        spec,
        // Provenance off the RECORD, so a resumed run reports it too.
        specSource: specSource(ctx.run),
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
        // The tiers the gate excused over the base commit, from the record — the body
        // renders its disclosure from this and never from the reason prose. BOTH steps
        // that can excuse a tier are read: `ci` excuses the project's FULL tier under
        // its own key, and a body that read only `verify` would print a clean PR for a
        // run whose full tier exited non-zero and was let go on the base commit's
        // colour. A newer `ci` verdict with no disclosure replaces an older one — the
        // newest decided step of each kind is the claim that stands, as it is for
        // `verifyKind`.
        ...(() => {
          const excused = {
            ...(v?.outcome?.preexistingFailures ?? {}),
            ...(newestDecided(ctx.steps, "ci")?.outcome?.preexistingFailures ?? {}),
          };
          return Object.keys(excused).length === 0 ? {} : { preexistingFailures: excused };
        })(),
        // Read off the log, not a closure, so a resumed run prints the same line a live one would.
        // The readers' objects are WRAPPED here, never spread: spreading would hand `publishBody`
        // fields it never reads and drop the line without a sound.
        challengeBudget: challengeBudgetFromLog(ctx.steps),
        challengeSkipped: challengeSkipReasonFromLog(ctx.steps),
        draft,
        version: ctx.run.version,
        models: ctx.run.models,
        baseSha: ctx.run.baseSha,
        ...(block === undefined ? {} : { specBlock: block.text }),
      });
      const problem = block && specBlockProblem(text);
      if (problem)
        throw new PublishInfraError(`the PR body's spec block is unreadable: ${problem}`);
      return text;
    },
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
    // The FULL head this step pushed, not the 12-char prefix the reason line
    // prints. `prUrl` alone says a PR exists; this says which commit stands under
    // it, which is the half the host's `prState` compares to the green verify's
    // `verifiedHead` — and `verifiedHead` is a `verify` field, so there is no
    // other place a later reader could get this from. Recorded from the same
    // `head` the push carried (`assertTree` proved it 40-hex before anything was
    // written), so `ready` never rests on prose.
    publishedHead: head,
    ...(dispatches.length === 0 ? {} : { dispatches }),
    // The state as the forge REPORTED it, never as this run asked for it: the
    // create path read the new PR back through `draftStateOf`, so a forge that
    // left a requested draft mergeable is recorded `false`; a reply that
    // already carried the flag is trusted as-is. A recorded `true` over a ready
    // PR is the lie the read-back exists to prevent, and guessing the requested
    // value would be the same lie in the other direction.
    ...(pr?.isDraft === undefined ? {} : { draft: pr.isDraft }),
    reason: `${wrote ? "published" : "already on origin, published"} ${draft ? "draft " : ""}PR ${prUrl} at ${head.slice(0, 12)}`,
  };
}
