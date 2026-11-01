/**
 * lean/ci — the step that OBSERVES the pipeline: required checks plus the full tier.
 *
 * A child's prose ("CI looks fine") is not an outcome here. `green` is granted
 * only when two executed things agree about one named commit:
 *
 *   1. the forge's own required-check verdict — `gh pr view`'s
 *      `mergeStateStatus` (which already encodes the repo's required-check
 *      rules) plus `gh pr checks`' rows, both read at the PR head;
 *   2. the project's FULL-tier verify command, run locally in the run's own
 *      worktree at the head the run's gate certified.
 *
 * The second half is the reason `land` may trust `ci` at all: a run must not
 * reach the merge on the fast tier plus the frozen tests alone. With no full
 * tier configured this step returns `red` naming that gap — it fails closed
 * rather than reporting a green it did not observe.
 *
 * A red is a verdict and the machine routes it (one fix round, then handback).
 * A throw is infrastructure — an unreadable `gh`, a killed or un-startable
 * tier — which the engine turns into handed-back rather than a build round,
 * because a result nobody observed is not evidence that the code is wrong.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { type CiDeps, ghReads } from "./ci-deps.ts";
import { DEFAULT_BUDGETS } from "./config.ts";
import type { HandlerCtx } from "./engine.ts";
import { neverStarted, wasKilled } from "./specify-proof.ts";
import { specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import { oneLine } from "./text-fence.ts";
import { VerifyInfraError } from "./verify-types.ts";

/** The last lines of a tier's output — the part that says what actually broke. */
const TIER_TAIL_LINES = 40;

/** Check states that are not a pass. `skipped`/`neutral` are here on purpose:
 *  GitHub counts them as success and a `paths-ignore:` gate then always reads
 *  green, which is a gate that cannot fail. */
const NOT_PASSING = [
  "fail",
  "failure",
  "cancelled",
  "timed_out",
  "error",
  "pending",
  "queued",
  "in_progress",
  "waiting",
  "skipped",
  "skipping",
  "neutral",
];

/** The newest decided `verify`'s full head, which is what CI must run against. */
function verifiedHead(ctx: HandlerCtx): string | undefined {
  for (let i = ctx.steps.length - 1; i >= 0; i--) {
    const step = ctx.steps[i];
    if (step?.state !== "verify" || step.outcome === undefined) continue;
    const head = step.outcome.verifiedHead;
    return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
  }
  return undefined;
}

/** The PR number, out of the publish step's recorded URL (never out of prose). */
function prNumberFromLog(ctx: HandlerCtx): number | undefined {
  for (let i = ctx.steps.length - 1; i >= 0; i--) {
    const step = ctx.steps[i];
    if (step?.state !== "publish" || step.outcome?.prUrl === undefined) continue;
    const m = step.outcome.prUrl.match(/\/pull\/(\d+)\/?$/);
    return m === null || m[1] === undefined ? undefined : Number.parseInt(m[1], 10);
  }
  return undefined;
}

/** Run one CLI read, or throw — an unreadable forge is never a verdict. */
async function cli(deps: CiDeps, repoRoot: string, cmd: string, why: string): Promise<string> {
  const ran = await deps
    .exec(cmd, { cwd: repoRoot, timeout: 60_000, maxBuffer: 512 * 1024 })
    .catch(() => undefined);
  if (ran === undefined) throw new VerifyInfraError(`${why}: the command did not run`);
  return ran.stdout ?? "";
}

/** Parse a `gh --json` reply, or throw — an unreadable reply is not a verdict. */
function json(text: string, why: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new VerifyInfraError(`${why}: the reply was not JSON`);
  }
}

/**
 * The forge's required-check verdict for this PR, or a red reason.
 *
 * `mergeStateStatus` is the authoritative word (it encodes the repo's own
 * branch protection); the check rows only name what is wrong. An empty rows
 * list refuses too — "no checks reported" is the absence of evidence, not
 * evidence of green.
 */
async function checksRedReason(
  deps: CiDeps,
  repoRoot: string,
  prNumber: number,
  verified: string,
): Promise<string | undefined> {
  const reads = ghReads(prNumber);
  const view = json(
    await cli(deps, repoRoot, reads.view, "could not read the PR state"),
    "could not read the PR state",
  ) as { mergeStateStatus?: unknown; state?: unknown; headRefOid?: unknown };
  if (view.state !== "OPEN") return `the PR is ${String(view.state)}, not OPEN`;
  // The head the CI verdict was observed at comes from the SAME read as the
  // verdict: two reads of a moving PR are two moments, and a green about another
  // head is no evidence about this one.
  const prHead = typeof view.headRefOid === "string" ? view.headRefOid : undefined;
  if (prHead === undefined || !isFullCommitSha(prHead))
    throw new VerifyInfraError(
      "the forge gave no full head OID for the PR the checks were read at",
    );
  if (prHead !== verified)
    return `the PR head ${prHead.slice(0, 12)} is not the verified head ${verified.slice(0, 12)}`;
  const status = typeof view.mergeStateStatus === "string" ? view.mergeStateStatus : "";
  if (status !== "CLEAN") return `mergeStateStatus is ${status === "" ? "unreadable" : status}`;
  const rows = json(
    await cli(deps, repoRoot, reads.checks, "could not read the PR's checks"),
    "could not read the PR's checks",
  ) as { name?: unknown; state?: unknown; bucket?: unknown }[];
  if (!Array.isArray(rows) || rows.length === 0)
    return "no checks reported — refusing to read the absence of evidence as green";
  const bad = rows.filter((r) =>
    NOT_PASSING.includes(
      String(r.bucket ?? r.state ?? "")
        .toLowerCase()
        .trim(),
    ),
  );
  if (bad.length > 0)
    return `checks not passing: ${bad.map((r) => String(r.name ?? "(unnamed)")).join(", ")}`;
  return undefined;
}

/** Run the full tier in the worktree; a kill or an un-startable command throws. */
async function tierFailure(
  deps: CiDeps,
  cmd: string,
  wt: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const ran = await deps
    .exec(cmd, { cwd: wt, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, killGroup: true })
    .then((r) => ({ err: undefined as unknown, out: r }))
    .catch((err: unknown) => ({ err, out: undefined as unknown }));
  if (ran.err === undefined) return undefined;
  const e = ran.err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
  const out = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
  if (wasKilled(ran.err))
    throw new VerifyInfraError(
      `the ci full tier was killed or timed out at ${timeoutMs}ms: ${cmd}`,
    );
  if (neverStarted(ran.err))
    throw new VerifyInfraError(
      `the ci full tier could not be started: ${cmd}: ${oneLine(out, 300)}`,
    );
  const tail = out
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-TIER_TAIL_LINES)
    .join("\n");
  return `the full verify tier exited ${String(e.code)}: ${cmd}\n${tail}`;
}

/**
 * The `ci` step. Returns `green` | `red`; THROWS on infrastructure.
 *
 * The head it observes is the run's own: the newest decided `verify`'s
 * `verifiedHead`, which is also what `land` later compares to the PR head. A ci
 * green recorded over a tree nobody ran the full tier at is the shape this step
 * exists to make unreachable, so an absent head throws rather than falling back
 * to whatever the worktree happens to hold.
 */
export async function ciOutcome(ctx: HandlerCtx, deps: CiDeps): Promise<Outcome> {
  const verified = verifiedHead(ctx);
  if (verified === undefined)
    throw new VerifyInfraError("the step log records no verified head to run CI against");
  const prNumber = prNumberFromLog(ctx);
  if (prNumber === undefined)
    throw new VerifyInfraError("the step log records no PR to read CI for");

  const config = await deps.loadConfig(ctx.repoRoot, ctx.run.baseSha).catch((err: unknown) => {
    throw new VerifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const wt = specifyWorktreePath(ctx.repoRoot, ctx.issue);
  const configured = deps.readVerifyCmd
    ? await deps.readVerifyCmd(wt, verified).catch((err: unknown) => {
        throw new VerifyInfraError(
          `could not read .pi/verify-cmd: ${(err as Error)?.message ?? String(err)}`,
        );
      })
    : undefined;
  const full = (config.verify.full ?? configured ?? "").trim();
  if (full === "")
    return {
      kind: "red",
      reason: `no full verify tier is configured (.pi/work.json verify.full, or .pi/verify-cmd at ${verified.slice(0, 12)}): a run must not land on the fast tier plus the frozen tests alone`,
    };

  const checks = await checksRedReason(deps, ctx.repoRoot, prNumber, verified);
  if (checks !== undefined) return { kind: "red", reason: checks };

  const minutes = DEFAULT_BUDGETS.ci?.minutes ?? 30;
  const timeoutMs = deps.tierTimeoutMs ?? minutes * 60_000;
  const tier = await tierFailure(deps, full, wt, timeoutMs);
  if (tier !== undefined) return { kind: "red", reason: tier };

  return {
    kind: "green",
    reason: `required checks CLEAN and the full verify tier passed at ${verified}`,
  };
}
