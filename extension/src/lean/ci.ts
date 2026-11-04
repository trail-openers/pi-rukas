/**
 * lean/ci — the step that OBSERVES the pipeline: required checks plus the full tier.
 *
 * A child's prose ("CI looks fine") is not an outcome here. `green` is granted
 * only when two executed things agree about one named commit:
 *
 *   1. the forge's own required-check verdict — `gh pr view`'s
 *      `mergeStateStatus` (which already encodes the repo's required-check
 *      rules) plus `gh pr checks`' rows, both read at the PR head. Both are
 *      re-read every minute while a row is still running: a check that has not
 *      finished is not a check that failed, and grading one as red spends a
 *      build round on code that is not broken;
 *   2. the project's FULL-tier verify command, run locally in the run's own
 *      worktree at the head the run's gate certified.
 *
 * The second half is the reason `land` may trust `ci` at all: a run must not
 * reach the merge on the fast tier plus the frozen tests alone. With no full
 * tier configured this step returns `red` naming that gap — it fails closed
 * rather than reporting a green it did not observe.
 *
 * A red is a verdict and the machine routes it (one fix round, then handback).
 * A throw is infrastructure — an unreadable `gh`, a killed or un-startable tier,
 * checks that never finished inside the wait's bound, a worktree that is no
 * longer the tree the gate certified — which the engine turns into handed-back
 * rather than a build round, because a result nobody observed is not evidence
 * that the code is wrong.
 *
 * **The architectural bound, stated plainly.** Between `build`/`verify` and this
 * handler nothing is pushed, so the code the run produced exists ONLY in this
 * worktree, and `ci` necessarily executes its full tier FROM DISK. "The full
 * tier ran at the frozen head" is therefore NOT achievable by this shape — no
 * frozen checkout ever happens here, and this step does not pretend otherwise
 * (it never calls `checkout`, `switch`, `reset`, `clean` or `stash`). What IS
 * achievable, and is what the green below actually claims, is that **the disk
 * still matches the head the record says was built**: before the tier runs, the
 * worktree's HEAD is re-read against the newest decided `verify`'s
 * `verifiedHead`, HEAD must still sit on the run's branch, and the tree must
 * pass lean's single clean-tree gate (`assertTreeClean` in `verify-recheck.ts`,
 * the same porcelain the build/verify gate used). Anything else throws. So a
 * `git checkout` of another commit, a detached HEAD, or bytes written into the
 * tree between the build gate and this handler cannot produce a green — the
 * step refuses, rather than reporting a green for code it never ran. Proving
 * the disk matches the head it claims is the deliverable; a frozen checkout is
 * not something this shape can do.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import { verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { type CiDeps, ghReads } from "./ci-deps.ts";
import { ciTierBudgetMs } from "./ci-tier-budget.ts";
import { DEFAULT_BUDGETS, type WorkConfig } from "./config.ts";
import { MINUTE_MS, deadlineStopsSteps } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";
import { neverStarted, wasKilled } from "./specify-proof.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { Outcome } from "./state.ts";
import { budgetFor } from "./step-budget.ts";
import { oneLine } from "./text-fence.ts";
import { assertTreeClean } from "./verify-recheck.ts";
import { VerifyInfraError } from "./verify-types.ts";

/** The last lines of a tier's output — the part that says what actually broke. */
const TIER_TAIL_LINES = 40;

/** How long to wait between two reads of the forge while its checks run. */
export const CI_POLL_MS = 60_000;

/**
 * `gh pr checks` exits **8** while checks are still pending (`gh pr checks
 * --help`, gh 2.103.3: `8: Checks pending`). The shared executor rejects on any
 * non-zero exit, so without this the pending reply — which is the whole point of
 * the poll — would read as an infra throw and a poll could never observe the
 * waiting state it exists for. stdout still carries the JSON rows, so the exit
 * is a signal about WHERE the checks are, not about whether the read worked.
 */
const GH_CHECKS_PENDING_EXIT = 8;

/** A row's grade, read the way the driver's merge gate reads one: gh's bucket
 *  first, the raw check state only as the fallback. */
const PENDING_ROWS = ["pending", "queued", "in_progress", "waiting"];
const RED_ROWS = ["fail", "failure", "cancelled", "cancel", "timed_out", "error"];
/** GitHub counts these as success and this step does not: a `paths-ignore:`
 *  gate then always reads green, which is a gate that cannot fail. */
const NOT_PASSING_ROWS = ["skipped", "skipping", "neutral"];

/**
 * The `ci` budget's minutes for one loaded config. One number feeds BOTH bounds
 * of the step — the forge wait and the full tier — so neither can drift from the
 * other or from what `.pi/work.json` says; `DEFAULT_BUDGETS` is the fallback
 * only where the config carries no `ci` row at all.
 *
 * A `0` here is the shipped default, not a bound of zero: elsewhere in a budget
 * `0` means "no bound", and for the other states `armBudget` turns it into
 * exactly that (no wall clock at all). Here the same number is a timeout handed
 * to the forge wait and to the tier, so `0` would read as "expire immediately"
 * and every run would hand back at once — the opposite of what a generous
 * setting means everywhere else. So `<= 0` takes the shipped number.
 */
function ciMinutes(cfg: WorkConfig): number {
  const configured = budgetFor(cfg, "ci")?.minutes ?? 0;
  return configured > 0 ? configured : (DEFAULT_BUDGETS.ci?.minutes ?? 30);
}

/** One row's grade. Anything in no list is neither pending nor red — it waits,
 *  and an expired wait hands the run back rather than blaming the code. */
type RowGrade = "pending" | "red" | "not-passing" | "unknown";

/** One poll's read of the forge: the PR's own verdict plus its check rows. */
interface ForgeRead {
  /** The PR state verbatim (`OPEN`, `MERGED`, …). */
  state: unknown;
  /** `mergeStateStatus` verbatim, or `""` when the forge gave no word. */
  mergeStateStatus: string;
  /** The PR head this verdict was observed at. */
  prHead: string | undefined;
  /** The check rows, or `undefined` when the reply was not an array. */
  rows: { name?: unknown; state?: unknown; bucket?: unknown }[] | undefined;
}

/** A row's grade, or `undefined` when the row is simply passing. */
function gradeRow(row: { state?: unknown; bucket?: unknown }): RowGrade | undefined {
  const v = String(row.bucket ?? row.state ?? "")
    .toLowerCase()
    .trim();
  // An empty or absent bucket AND state says nothing, and "nothing said" is not
  // a pass: graded passing it would be waited on by nobody and the step would
  // merge on it. Graded `unknown` it waits, and an expired wait hands the run
  // back — the same answer as a row in a state this file has never seen.
  if (v === "pass" || v === "success" || v === "none") return undefined;
  if (PENDING_ROWS.includes(v)) return "pending";
  if (RED_ROWS.includes(v)) return "red";
  if (NOT_PASSING_ROWS.includes(v)) return "not-passing";
  return "unknown";
}

/**
 * The names shown to a human for rows graded in `want`. Both bounds exist
 * because these strings come from the forge: a handback line that quotes them
 * must not grow with however many rows (or however long a name) a repo runs.
 */
const HANDBACK_NAME_CHARS = 80;
const HANDBACK_NAMES = 10;

function namesOf(
  rows: { name?: unknown; state?: unknown; bucket?: unknown }[],
  want: RowGrade,
): string[] {
  return rows
    .filter((r) => gradeRow(r) === want)
    .slice(0, HANDBACK_NAMES)
    .map((r) => oneLine(String(r.name ?? "(unnamed)"), HANDBACK_NAME_CHARS));
}

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
async function cli(
  deps: CiDeps,
  repoRoot: string,
  cmd: string,
  why: string,
  /** Exit codes whose rejection still carries a usable stdout (see
   *  {@link GH_CHECKS_PENDING_EXIT}). A pending reply is DATA, not a failed read. */
  okExitCodes: readonly number[] = [],
): Promise<string> {
  const ran = await deps
    .exec(cmd, {
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 512 * 1024,
      // The driver's own forge read, so the host env: a project tier is scrubbed
      // of driver knobs, but this `gh` is the driver's own host-channel call and
      // keeps the one knob such a cycle reads (see `verifyHostEnv`).
      env: verifyHostEnv(),
    })
    .then((r) => ({ err: undefined as unknown, out: r as { stdout?: string } | undefined }))
    .catch((err: unknown) => ({ err, out: undefined as { stdout?: string } | undefined }));
  if (ran.err !== undefined) {
    const e = ran.err as { code?: unknown; stdout?: unknown };
    const pending =
      typeof e.code === "number" &&
      okExitCodes.includes(e.code) &&
      typeof e.stdout === "string" &&
      e.stdout.trim() !== "";
    if (!pending) throw new VerifyInfraError(`${why}: the command did not run`);
    return String(e.stdout);
  }
  return ran.out?.stdout ?? "";
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
 * One read of the forge: the PR's own verdict and its check rows, from the SAME
 * moment. The head the verdict is about comes out of the same `gh pr view` as
 * the verdict itself — two reads of a moving PR are two moments, and a green
 * about another head is no evidence about this one.
 */
async function readForge(deps: CiDeps, repoRoot: string, prNumber: number): Promise<ForgeRead> {
  const reads = ghReads(prNumber);
  const view = json(
    await cli(deps, repoRoot, reads.view, "could not read the PR state"),
    "could not read the PR state",
  ) as { mergeStateStatus?: unknown; state?: unknown; headRefOid?: unknown };
  const rows = json(
    await cli(deps, repoRoot, reads.checks, "could not read the PR's checks", [
      GH_CHECKS_PENDING_EXIT,
    ]),
    "could not read the PR's checks",
  );
  return {
    state: view.state,
    mergeStateStatus: typeof view.mergeStateStatus === "string" ? view.mergeStateStatus : "",
    prHead: typeof view.headRefOid === "string" ? view.headRefOid : undefined,
    rows: Array.isArray(rows) ? (rows as ForgeRead["rows"]) : undefined,
  };
}

/**
 * The forge's required-check verdict for this PR, POLLED until the checks are
 * terminal, the bound expires, or the run's cycle deadline arrives.
 *
 * A still-running CI makes `mergeStateStatus` UNSTABLE, and a step that reads
 * once right after publish grades that as red and spends a build round on code
 * that is not broken. So a pending (or unrecognised) row is WAITED, and red is
 * reserved for a row that actually failed. Every iteration re-issues BOTH reads
 * — including the head — so a PR that moves off the verified head mid-wait is
 * caught on the iteration that sees it, with no further poll. An empty rows list
 * stays an immediate red: "no checks reported" is the absence of evidence, not
 * evidence of green, and a loop that waited for it would poll a forge that said
 * nothing for the whole budget.
 *
 * The two bounds are SEQUENTIAL and separate: this wait gets the `ci` budget's
 * minutes (the caller's one `ciMinutes` read), and the full tier keeps its own
 * bound of the same size afterwards — clamped to the time the cycle's deadline
 * still leaves, which is what {@link ciTierBudgetMs} does. Still pending when the
 * wait expires is a handback (`VerifyInfraError`), never a red, because nobody
 * observed the code being wrong.
 */
async function checksRedReason(
  deps: CiDeps,
  ctx: HandlerCtx,
  repoRoot: string,
  prNumber: number,
  verified: string,
  ciMinutes: number,
): Promise<string | undefined> {
  const start = deps.now();
  const waitMs = deps.waitTimeoutMs ?? ciMinutes * 60_000;
  for (;;) {
    const read = await readForge(deps, repoRoot, prNumber);
    if (read.state !== "OPEN") return `the PR is ${String(read.state)}, not OPEN`;
    if (read.prHead === undefined || !isFullCommitSha(read.prHead))
      throw new VerifyInfraError(
        "the forge gave no full head OID for the PR the checks were read at",
      );
    if (read.prHead !== verified)
      return `the PR head ${read.prHead.slice(0, 12)} is not the verified head ${verified.slice(0, 12)}`;
    if (read.rows === undefined || read.rows.length === 0)
      return "no checks reported — refusing to read the absence of evidence as green";
    const red = [...namesOf(read.rows, "red"), ...namesOf(read.rows, "not-passing")];
    if (red.length > 0) return `checks not passing: ${red.join(", ")}`;
    // A row in no list at all is not evidence of a pass either: it waits, and
    // an expired wait hands back — an unreadable forge state never becomes red.
    const waiting = [...namesOf(read.rows, "pending"), ...namesOf(read.rows, "unknown")];
    if (waiting.length > 0) {
      // The caller's whole-cycle arm is consulted on every WAIT, not only
      // between steps: a poll that ignores it can outlive the host's deadline
      // and the run dies with no document. The answer is `work`'s and lean's
      // own boundary predicate — `deadlineStopsSteps` — read on the handler
      // context's injected clock, so the poll and the engine cannot disagree
      // about where step work ends. Inside the handoff allowance the answer is
      // a handback naming the cycle deadline.
      const cycle = ctx.run.deadlineMs;
      if (deadlineStopsSteps(cycle, ctx.now(), "ci"))
        throw new VerifyInfraError(
          `the ci wait stopped with ${Math.max(0, Math.round((cycle ?? 0) - ctx.now()) / MINUTE_MS)} min left of the cycle deadline: the run is inside its handoff allowance`,
        );
      if (deps.now() - start >= waitMs)
        throw new VerifyInfraError(
          `CI checks still pending after ${Math.round(waitMs / 60_000)} min: ${waiting.join(", ")}`,
        );
      await deps.sleep(CI_POLL_MS);
      continue;
    }
    // Every row terminal and none failed: the forge's own word is the last
    // authority, because it encodes the repo's branch protection. A row gh
    // reports as passing does not override a BLOCKED/DIRTY verdict.
    if (read.mergeStateStatus !== "CLEAN")
      return `mergeStateStatus is ${read.mergeStateStatus === "" ? "unreadable" : read.mergeStateStatus}`;
    return undefined;
  }
}

/**
 * Is the disk still the head this run was certified at?
 *
 * `ci` runs its full tier as a shell command IN the worktree, so the tree it
 * judges is whatever is on disk when the handler starts. Nothing is pushed
 * between the build/verify gate and here, so the only way to make "the full
 * tier ran at the verified head" honest is to PROVE the disk still holds that
 * head — which is what this does, with the same reads `verify-recheck.ts` makes
 * after every tier:
 *
 *   - HEAD is re-read and must equal `verified` — a `git checkout` of anything
 *     else (or a commit made since the gate) is refused here rather than graded;
 *   - HEAD must still sit on the run's own branch — `git checkout --detach`
 *     leaves the same sha on no branch, and everything after this step pushes
 *     the branch, not the sha;
 *   - the tree must be clean, through lean's single clean-tree gate
 *     ({@link assertTreeClean}) — a rewritten or untracked file means the tier
 *     would run over bytes no commit holds.
 *
 * Every refusal throws. This is the machine having moved, not the code being
 * wrong, so the engine hands the run back rather than spending a fix round on
 * bytes nobody committed.
 */
async function assertDiskAtVerifiedHead(
  deps: CiDeps,
  wt: string,
  verified: string,
  branch: string,
): Promise<void> {
  const read = async (argv: string[], why: string): Promise<string> => {
    const ran = await deps
      .exec("git", {
        argv: [...NO_HOOKS, ...argv],
        cwd: wt,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
      .catch(() => undefined);
    if (ran === undefined)
      throw new VerifyInfraError(`could not re-read ${why} in ${wt} before the full tier`);
    return (ran.stdout ?? "").trim();
  };
  const head = await read(["rev-parse", "HEAD"], "HEAD");
  if (head !== verified)
    throw new VerifyInfraError(
      `the worktree ${wt} is at ${head === "" ? "no readable head" : head.slice(0, 12)}, not the verified head ${verified.slice(0, 12)} — the full tier would run over a tree this run never certified`,
    );
  // `symbolic-ref -q` exits 1 with no output when HEAD is detached; any other
  // failure is a git that would not answer, and is never blamed on the run.
  const symbolic = await deps
    .exec("git", {
      argv: [...NO_HOOKS, "symbolic-ref", "--short", "-q", "HEAD"],
      cwd: wt,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    .catch((err: unknown) => {
      const e = err as { code?: unknown; stderr?: unknown };
      if (e?.code === 1 && String(e.stderr ?? "").trim() === "") return { stdout: "" };
      throw new VerifyInfraError(`could not re-read the branch in ${wt} before the full tier`);
    });
  if ((symbolic.stdout ?? "").trim() !== branch)
    throw new VerifyInfraError(
      `the worktree ${wt} is not on the run's branch ${branch} — the full tier would run on a tree taken off the ref everything after this step pushes`,
    );
  await assertTreeClean(deps.exec, wt, "ci");
}

/**
 * The project config, read ONCE per step by `ciOutcome` and passed down.
 *
 * Three halves of this step want it — the configured full tier, the wait bound
 * and the tier's bound — and all three read it through this one call, so they
 * cannot disagree about which commit's `.pi/work.json` they obeyed.
 */
async function ciConfig(deps: CiDeps, ctx: HandlerCtx): Promise<WorkConfig> {
  return await deps.loadConfig(ctx.repoRoot, ctx.run.baseSha).catch((err: unknown) => {
    throw new VerifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
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
 * to whatever the worktree happens to hold — and so does a worktree that has
 * moved off it since (`assertDiskAtVerifiedHead`).
 */
export async function ciOutcome(ctx: HandlerCtx, deps: CiDeps): Promise<Outcome> {
  const verified = verifiedHead(ctx);
  if (verified === undefined)
    throw new VerifyInfraError("the step log records no verified head to run CI against");
  const prNumber = prNumberFromLog(ctx);
  if (prNumber === undefined)
    throw new VerifyInfraError("the step log records no PR to read CI for");

  const wt = specifyWorktreePath(ctx.repoRoot, ctx.issue);
  // The project config is read ONCE here and passed to everything that wants
  // it: the configured full tier, the wait bound and the tier's bound all come
  // from this one read of the run's base commit.
  const cfg = await ciConfig(deps, ctx);
  const configured = deps.readVerifyCmd
    ? await deps.readVerifyCmd(wt, verified).catch((err: unknown) => {
        throw new VerifyInfraError(
          `could not read .pi/verify-cmd: ${(err as Error)?.message ?? String(err)}`,
        );
      })
    : undefined;
  const full = (cfg.verify.full ?? configured ?? "").trim();
  if (full === "")
    return {
      kind: "red",
      reason: `no full verify tier is configured (.pi/work.json verify.full, or .pi/verify-cmd at ${verified.slice(0, 12)}): a run must not land on the fast tier plus the frozen tests alone`,
    };

  const checks = await checksRedReason(deps, ctx, ctx.repoRoot, prNumber, verified, ciMinutes(cfg));
  if (checks !== undefined) return { kind: "red", reason: checks };

  // The disk is read AGAIN, immediately before the tier, because the tier runs
  // from disk: see `assertDiskAtVerifiedHead` for the bound this proves (and the
  // bound it cannot). Placed after the forge reads so a PR that is not the
  // verified head stays a RED about the forge rather than becoming an
  // infrastructure fault about the worktree — the two have different owners.
  await assertDiskAtVerifiedHead(deps, wt, verified, specifyBranch(ctx.run.branch, ctx.issue));

  // The tier's bound is its OWN, sequential after the wait, and of the same
  // size: waiting out 18 minutes of CI must not leave the full tier a minute.
  // When the run carries a cycle deadline it is clamped to what that deadline
  // still leaves, and the tier never starts when it leaves nothing — see
  // {@link ciTierBudgetMs}.
  const timeoutMs = ciTierBudgetMs(ctx, deps.tierTimeoutMs, ciMinutes(cfg));
  const tier = await tierFailure(deps, full, wt, timeoutMs);
  if (tier !== undefined) return { kind: "red", reason: tier };

  return {
    kind: "green",
    reason: `required checks CLEAN and the full verify tier passed at ${verified}`,
  };
}
