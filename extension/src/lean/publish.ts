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
 *   4. the push is porcelain, and its force is conditional: origin is read
 *      first (`remoteBranchSha`) and a stale `lean/` ref exactly one of our own
 *      commits behind is replaced under a lease bound to that sha; other pushes
 *      stay non-forced, and an OPEN PR's branch is refused with its URL;
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
import type { HandlerCtx } from "./engine.ts";
import { publishBody } from "./publish-body.ts";
import { type PublishDeps, PublishInfraError, assertPublishableBranch } from "./publish-deps.ts";
import type { PublishForge } from "./publish-deps.ts";
import { parsePiSpec } from "./spec.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import { PR_URL, PR_URL_MAX_CHARS } from "./state-outcome.ts";
import { type Outcome, type Step, newestDecided } from "./state.ts";
import { oneLine } from "./text-fence.ts";

/** The criterion -> tests map, unioned over every step that recorded one. */
export function testsFromLog(steps: Step[]): Record<string, string[]> {
  const tests: Record<string, string[]> = {};
  for (const step of steps) {
    if (step.outcome === undefined) continue;
    const decided =
      (step.state === "specify" && step.outcome.kind === "ok") ||
      (step.state === "challenge" && step.outcome.kind === "new-tests");
    if (!decided) continue;
    for (const [id, files] of Object.entries(step.outcome.tests ?? {})) {
      const seen = new Set(tests[id] ?? []);
      for (const f of files) seen.add(f);
      tests[id] = [...seen];
    }
  }
  return tests;
}

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
 * Porcelain push of the head to origin's branch, non-forced unless `replaceSha`
 * — the stale sha this run read from origin — earns the lease (rule below). The
 * ref name is checked with the driver's own `netRefProblem` BEFORE the command
 * line: `branch` is state-file data, and `assertSafeRef` only says it is a legal
 * git name — `+x`, `a:b` and `-f` all are, and git parses them as a refspec, a
 * force, or an option (see `netRefProblem`, #1095).
 */
async function pushHead(
  deps: PublishDeps,
  wt: string,
  head: string,
  branch: string,
  replaceSha?: string,
): Promise<void> {
  const unsafe = netRefProblem(`refs/heads/${branch}`);
  if (unsafe !== undefined) throw new PublishInfraError(`refusing to push ${branch}: ${unsafe}`);
  const [refspec, why] = [`${head}:refs/heads/${branch}`, `could not compare origin's ${branch}`];
  // The force is for ONE shape: origin holds the previous run's head and this
  // rerun's amend left exactly one commit between it and us — `rev-list --count
  // ^HEAD <remote>` == 1. Only that forces. `--count` exits 0 with "0" for a sha
  // this clone cannot resolve, so an unreadable foreign commit never buys a
  // force, and the sha is not fetched to make it readable: that would pull a
  // foreign commit's objects in to manufacture an answer git refused. And the
  // lease checks the tip only, so a foreign commit under the observed sha
  // satisfies it — binding it to that sha is what makes a moved ref fail.
  const force =
    replaceSha !== undefined &&
    replaceSha !== head &&
    (await gitIn(deps, wt, ["rev-list", "--count", "^HEAD", replaceSha], why, 30_000)) === "1";
  const forceArgv = force ? [`--force-with-lease=refs/heads/${branch}:${replaceSha}`] : [];
  const ran = await deps
    .exec("git", {
      argv: [...NO_HOOKS, "push", "--porcelain", ...forceArgv, "origin", refspec],
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
  // Porcelain form: a `To <remote>` header, one `<from> <to> <flag>` line per
  // ref, a `Done` trailer — and for a brand-new ref git puts an
  // ASTERISK in the from/to columns (`* <sha> refs/heads/x\t[new branch]`), so
  // neither column is reliably a sha. The FLAG is git's own verdict, and even a
  // rejection exits 0 — so these regexes are the check. A rewrite is the one
  // flag porcelain prints UNBRACKETED (`(abc...def (forced update)`), so it
  // cannot share the bracketed alternatives, and it counts ONLY for the push
  // that asked for the lease: otherwise something else forced the ref (a
  // `+refspec`, a hook) and this step may not rewrite outside the clone.
  const out = typeof ran?.stdout === "string" ? ran.stdout : "";
  if (/\[rejected\]/.test(out))
    throw new PublishInfraError(`the push of ${branch} was rejected: ${out.slice(0, 500)}`);
  if (/forced update/.test(out) && !force)
    throw new PublishInfraError(
      `the push of ${branch} reported a forced update, which this step never asks for: ${out.slice(0, 500)}`,
    );
  const okFlags = force
    ? /\[(?:new branch|up to date|fast-forward)\]|forced update/
    : /\[(?:new branch|up to date|fast-forward)\]/;
  if (!okFlags.test(out))
    throw new PublishInfraError(
      `the push of ${branch} reported no success flag: ${out.slice(0, 500)}`,
    );
}

/** Reuse an open PR on the branch, or create one. Never both. */
async function openPr(
  f: PublishForge,
  branch: string,
  issue: number,
  problem: string,
  body: string,
  draft: boolean,
): Promise<NormalizedPullRequest> {
  const open = await f.prList({ state: "open", sourceBranch: branch }).catch((err: unknown) => {
    // Looking and failing is not the same as finding nothing: creating here is
    // how a resumed run ends up with two PRs for one issue.
    throw new PublishInfraError(
      `could not list open PRs for ${branch}: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  const found = (open ?? []).find((pr) => pr.headRefName === branch);
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
 * The sha of a stale `lean/` ref this run may replace, or `undefined` when the
 * push stays non-forced: no ref on origin, a ref already at HEAD, or a ref an
 * OPEN PR points at (refused with its URL, never clobbered). Whether the sha is
 * ours to overwrite is `pushHead`'s call, not this one's.
 */
async function staleReplaceSha(
  deps: PublishDeps,
  repoRoot: string,
  wt: string,
  head: string,
  branch: string,
): Promise<string | undefined> {
  const remote = await remoteBranchSha(deps, wt, branch);
  if (remote === undefined || remote === head) return undefined;
  // Not having looked is no licence to rewrite a branch somebody may be reading.
  const f = await deps.forge(repoRoot);
  if (f === undefined)
    throw new PublishInfraError(`no forge adapter: cannot check ${branch} is in review`);
  const open = await f.prList({ state: "open", sourceBranch: branch }).catch((err: unknown) => {
    throw new PublishInfraError(
      `could not list open PRs for ${branch}: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  const blocking = (open ?? []).find((pr) => pr.headRefName === branch && pr.state === "OPEN");
  if (blocking !== undefined)
    throw new PublishInfraError(
      `an open PR already uses ${branch}: ${blocking.url ?? "(no URL returned)"}`,
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

  await pushHead(deps, wt, head, branch, await staleReplaceSha(deps, repoRoot, wt, head, branch));
  // From here on the head is OUTSIDE the clone. Every refusal below is a
  // handback over a pushed branch, so it says so — an error that reads only
  // "could not open the PR" hides the one fact the operator needs first.
  const pushed = (what: string) =>
    new PublishInfraError(`pushed ${head.slice(0, 12)} to ${branch}, but ${what}`);

  const f = await deps.forge(repoRoot);
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
    reason: `published ${draft ? "draft " : ""}PR ${prUrl} at ${head.slice(0, 12)}`,
  };
}
