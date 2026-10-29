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
 *   4. the push is non-forced and porcelain, so a rejection (a foreign commit
 *      already on the ref) is an error rather than a rewrite of history;
 *   5. the forge is asked for an OPEN PR on the branch FIRST and only then told
 *      to create one. A `prList` that throws aborts the step: creating without
 *      looking is how a resumed run opens a second PR for the same work.
 *
 * Everything the step cannot observe is a `PublishInfraError` — the engine turns
 * a throw into a handed-back run, which is the honest answer to "nobody looked".
 * The recorded outcome carries `prUrl` and nothing else: `state-outcome.ts`
 * refuses that field on any other step, so it stays the run's only evidence
 * that a PR exists at an address.
 */
import { existsSync } from "node:fs";
import { execp } from "../exec.ts";
import type { Forge, NormalizedPullRequest } from "../forge-types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import type { HandlerCtx } from "./engine.ts";
import { fetchIssueBody } from "./io.ts";
import { publishBody } from "./publish-body.ts";
import { parsePiSpec } from "./spec.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import { PR_URL, PR_URL_MAX_CHARS } from "./state-outcome.ts";
import type { Outcome, Step } from "./state.ts";
import { oneLine } from "./text-fence.ts";
import type { VerifyExec } from "./verify-types.ts";

/** Infrastructure: the step could not observe what it needed, so it did not act. */
export class PublishInfraError extends Error {
  override readonly name = "PublishInfraError";
}

/**
 * The executor this step needs: `ExecFn`'s argv form plus `execp`'s `killGroup`,
 * which the push carries so a hung `git push` cannot leave an ssh grandchild
 * holding the pipe open. Same intersection `verify-types.ts` documents.
 */
export type PublishExec = VerifyExec;

/** What the step reaches outside itself. */
export interface PublishDeps {
  exec: PublishExec;
  fetchBody: (repoRoot: string, issue: number) => Promise<string>;
  forge: (repoRoot: string) => PromiseLike<
    | {
        prList: Forge["prList"];
        prCreate: Forge["prCreate"];
      }
    | undefined
  >;
}

/** Production dependencies: the real executor, the real issue read, the real forge. */
export function publishDeps(): PublishDeps {
  return {
    // One executor for both shapes: `execp`'s own opts type declares every field
    // this step passes (`argv`, `cwd`, `timeout`, `maxBuffer`, `stdoutEncoding`,
    // `killGroup`), so the production seam is that executor rather than the
    // narrower `ExecFn` the worktree helpers declare (which has no `killGroup`).
    exec: (cmd, o) => execp(cmd, o ?? {}),
    fetchBody: fetchIssueBody,
    forge: forgeForPublish,
  };
}

/** The forge adapter in the publish shape, or undefined when there is none. */
async function forgeForPublish(
  repoRoot: string,
): Promise<{ prList: Forge["prList"]; prCreate: Forge["prCreate"] } | undefined> {
  const { detectForge } = await import("../forge-detect.ts");
  const { createForge } = await import("../forge.ts");
  if (process.env.PI_ENSEMBLE_FORGE === "none") return undefined;
  try {
    const det = await detectForge(repoRoot, {});
    if (det.forge === "unknown") return undefined;
    return createForge(det, { cwd: repoRoot });
  } catch {
    return undefined;
  }
}

/** The newest DECIDED step of one state — engine.ts's rule, copied for one reader. */
function newestDecided(steps: Step[], state: Step["state"]): Step | undefined {
  const decided = steps.filter((s) => s.state === state && s.outcome !== undefined);
  return decided[decided.length - 1];
}

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

/** Push the head to the branch on origin. Never forced; a rejection is fatal. */
async function pushHead(
  deps: PublishDeps,
  wt: string,
  head: string,
  branch: string,
): Promise<void> {
  const ran = (await deps
    .exec("git", {
      argv: [...NO_HOOKS, "push", "--porcelain", "origin", `${head}:refs/heads/${branch}`],
      cwd: wt,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      killGroup: true,
    })
    .catch((err: unknown) => {
      const e = err as { stderr?: unknown; message?: string };
      const why = String(e?.stderr ?? e?.message ?? err).slice(0, 500);
      throw new PublishInfraError(`could not push ${branch}: ${why}`);
    })) as { stdout?: string } | undefined;
  // Porcelain form. git prints a `To <remote>` header, one `<from> <to> <flag>`
  // line per ref, and a `Done` trailer — and for a brand-new ref it puts an
  // ASTERISK in the from/to columns (`* <sha> refs/heads/x\t[new branch]`), so
  // neither column is reliably a sha. The FLAG is git's own verdict: `[new
  // branch]`, `[up to date]`, `[fast-forward]` and `[forced update]` are the
  // successes and `[rejected]` is not — and the exit code stays 0 for the
  // rejection too, which is exactly why the exit code cannot be the check.
  const out = ran?.stdout ?? "";
  if (/\[rejected\]/.test(out))
    throw new PublishInfraError(`the push of ${branch} was rejected: ${out.slice(0, 500)}`);
  if (!/\[(?:new branch|up to date|fast-forward|forced update)\]/.test(out))
    throw new PublishInfraError(
      `the push of ${branch} reported no success flag: ${out.slice(0, 500)}`,
    );
}

/** Reuse an open PR on the branch, or create one. Never both. */
async function openPr(
  f: { prList: Forge["prList"]; prCreate: Forge["prCreate"] },
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
  if (found !== undefined) return found;
  return f.prCreate(`work-lean #${issue}: ${oneLineTitle(problem)}`, branch, body, { draft });
}

/** A PR title is one line, and the issue's problem statement is not. */
function oneLineTitle(problem: string): string {
  return oneLine(problem, 72);
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
  try {
    assertSafeRef(branch);
  } catch (err) {
    throw new PublishInfraError((err as Error).message);
  }
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
    spec.criteria.some((c) => c.verify === "manual");

  await pushHead(deps, wt, head, branch);

  const f = await deps.forge(repoRoot);
  if (f === undefined) throw new PublishInfraError("no forge adapter: cannot open the PR");
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
      ...(v?.outcome?.verifiedHead === undefined ? {} : { verifiedHead: v.outcome.verifiedHead }),
      ...(v?.outcome?.reason === undefined ? {} : { verifyReason: v.outcome.reason }),
      draft,
      version: ctx.run.version,
      models: ctx.run.models,
      baseSha: ctx.run.baseSha,
    }),
    draft,
  );

  const prUrl = pr?.url;
  if (prUrl === undefined || !PR_URL.test(prUrl))
    throw new PublishInfraError("the forge returned no usable PR URL");
  if (prUrl.length > PR_URL_MAX_CHARS)
    throw new PublishInfraError(
      `the forge returned a PR URL longer than ${PR_URL_MAX_CHARS} characters`,
    );

  return {
    kind: "ok",
    prUrl,
    reason: `published ${draft ? "draft " : ""}PR ${prUrl} at ${head.slice(0, 12)}`,
  };
}
