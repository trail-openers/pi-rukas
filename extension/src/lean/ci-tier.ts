/**
 * The `ci` step's two outside reads: the project's full verify tier, and the
 * forge's own answer about the PR/MR.
 *
 * Split out of `ci.ts` because the step grew a second question to answer about a
 * red tier — was every test it named already red at the base commit, or not — and
 * the two questions have different owners. This file owns running the tier and
 * turning a failed exec into either an infrastructure throw or a red reason;
 * {@link fullTierExcuse} in `ci-excuse.ts` owns the base-commit question, and
 * `ci.ts` decides which answer the step records. The forge half lives here too for
 * the same reason and in the same shape: `readForge` is the step's other outside
 * read, it owns both forges' argv and row grading, and `ci.ts` keeps the
 * decision — what a red means, what is waited on, and what a green may claim.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { verifyHostEnv } from "../work-driver-verify-cmd.ts";
import type { CiDeps } from "./ci-deps.ts";
import { ghReads } from "./ci-deps.ts";
import { glRead, glRowGrade } from "./ci-forge-gl.ts";
import type { GlForge } from "./ci-forge-gl.ts";
import { CI_POLL_MS } from "./ci-poll.ts";
import type { WorkConfig } from "./config.ts";
import { MINUTE_MS, deadlineStopsSteps } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";
import { neverStarted, wasKilled } from "./specify-proof.ts";
import { oneLine } from "./text-fence.ts";
import { clipReason } from "./verify-deps.ts";
import { TIER_TAIL_LINES, tailLines } from "./verify-steps.ts";
import { VerifyInfraError } from "./verify-types.ts";

/**
 * The project config, read ONCE per step by `ciOutcome` and passed down.
 *
 * Three halves of this step want it — the configured full tier, the wait bound
 * and the tier's bound — and all three read it through this one call, so they
 * cannot disagree about which commit's `.pi/work.json` they obeyed.
 */
export async function ciConfig(deps: CiDeps, ctx: HandlerCtx): Promise<WorkConfig> {
  return await deps.loadConfig(ctx.repoRoot, ctx.run.baseSha).catch((err: unknown) => {
    throw new VerifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
}

/**
 * Run the full tier in the worktree.
 *
 * `undefined` is a pass. A kill, a timeout or a command that never started is an
 * infrastructure fault — the tier never got to answer a question about the code, so
 * the run hands back rather than taking a build round. Anything else that exits
 * non-zero is a real red, returned with both the reason (what a red step records),
 * the combined stream (what the baseline excuse parses test names from) and the
 * executor's own result object (what `ciTierObserved` decides the excuse's admissibility
 * from — the stream alone cannot tell a full run from one truncated at its buffer).
 */
export async function tierFailure(
  deps: CiDeps,
  cmd: string,
  wt: string,
  timeoutMs: number,
): Promise<{ reason: string; stream: string; ran: unknown } | undefined> {
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
  // The tail and the bound are `verify`'s own, not a second copy of them: the step
  // log is one JSON document and `build`'s re-entry pastes a red reason into a
  // prompt, so a tail bound alone still lets one very long line — a minified bundle
  // echoed by a failing diff — carry the whole log into the record.
  const tail = tailLines(out, TIER_TAIL_LINES);
  return {
    reason: clipReason(`the full verify tier exited ${String(e.code)}: ${cmd}\n${tail}`),
    stream: out,
    ran: ran.err,
  };
}

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
 * A row's grade, read the way the driver's merge gate reads one: gh's bucket
 * first, the raw check state only as the fallback. GitLab rows carry no bucket
 * and their states are NOT in these lists — they are graded by `glRowGrade`,
 * the shared table in `forge-gl-grade.ts`, so neither side can drift on whether
 * `skipped` counts as green.
 */
type RowGrade = "pending" | "red" | "not-passing" | "unknown";

/** One poll's read of the forge: the PR's own verdict plus its check rows. */
interface ForgeRead {
  /** The PR state verbatim (`OPEN`, `MERGED`, …), or `undefined` for an MR —
   *  GitLab's own state is cross-checked inside the readiness composition. */
  state: unknown;
  /** `mergeStateStatus` verbatim (or the composed GitLab readiness), or `""`
   *  when the forge gave no word. */
  mergeStateStatus: string;
  /** The PR head this verdict was observed at. */
  prHead: string | undefined;
  /** The check rows, or `undefined` when the reply was not an array. */
  rows: { name?: unknown; state?: unknown; bucket?: unknown }[] | undefined;
}

/** A row's grade, or `undefined` when the row is simply passing. */
function gradeRow(
  row: { state?: unknown; bucket?: unknown },
  gitlab: boolean,
): RowGrade | undefined {
  // GitLab's job rows have no bucket and their `status` words are not gh's, so
  // the shared table decides them; a word it has never seen waits, never passes.
  if (gitlab) return glRowGrade({ state: row.state });
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
  gitlab: boolean,
): string[] {
  return rows
    .filter((r) => gradeRow(r, gitlab) === want)
    .slice(0, HANDBACK_NAMES)
    .map((r) => oneLine(String(r.name ?? "(unnamed)"), HANDBACK_NAME_CHARS));
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
/**
 * One read of the forge, from ONE moment: the verdict and the head it is about.
 *
 * GitHub: the PR's own verdict and its check rows, the head coming out of the
 * same `gh pr view` as the verdict itself — two reads of a moving PR are two
 * moments, and a green about another head is no evidence about this one.
 *
 * GitLab: the adapter's readiness path composes `mergeStateStatus` from
 * `detailed_merge_status` and its three cross-checks, and the head is
 * `diff_refs.head_sha` read out of the same reply (`ci-forge-gl.ts`). An MR has
 * no `state` field for this step to read, and none is needed: the composition
 * already refuses an MR that is not `opened`.
 *
 * The gh exit-8 pending tolerance is a `gh` contract and stays on the gh path
 * alone — `glab api` has no such code, so a failed glab read is the infra throw
 * it is, never pending data with a plausible stdout.
 */
async function readForge(
  deps: CiDeps,
  repoRoot: string,
  prNumber: number,
  gitlab: boolean,
  forge: GlForge,
): Promise<ForgeRead> {
  if (gitlab) {
    // Both reads are the adapter's own argv, so the command strings the step
    // issued stay the adapter's pinned glab form and the test's witness is
    // `Ran.cmds`, not a claim in a comment.
    const read = await glRead(forge, prNumber);
    return {
      state: undefined,
      mergeStateStatus: read.mergeStateStatus,
      prHead: read.prHead,
      rows: read.rows,
    };
  }
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
 * A still-running CI makes `mergeStateStatus` UNSTABLE, and a step that reads once
 * right after publish grades that as red and spends a build round on code that is not
 * broken. So a pending (or unrecognised) row is WAITED, and red is reserved for a row
 * that actually failed. Every iteration re-issues BOTH reads — including the head — so
 * a PR that moves off the verified head mid-wait is caught on the iteration that sees
 * it. An empty rows list stays an immediate red: "no checks reported" is the absence of
 * evidence, not evidence of green.
 *
 * The two bounds are SEQUENTIAL and separate: this wait gets the `ci` budget's minutes,
 * and the full tier keeps its own bound of the same size afterwards — clamped to the
 * time the cycle's deadline still leaves, which is what {@link ciTierBudgetMs} does.
 * Still pending when the wait expires is a handback (`VerifyInfraError`), never a red.
 *
 * On GitLab the same arms serve the composed readiness: `UNKNOWN` (GitLab's
 * `checking`, the one retryable status) arrives as a word that is not `CLEAN`
 * and is waited on the same bound, so a status still being computed minutes after
 * publish is never a red spent on code that is not broken. `DIRTY` is red, with
 * the composition's own detail as the reason.
 */
export async function checksRedReason(
  deps: CiDeps,
  ctx: HandlerCtx,
  repoRoot: string,
  prNumber: number,
  verified: string,
  ciMinutes: number,
  gitlab: boolean,
  forge: GlForge,
): Promise<string | undefined> {
  const start = deps.now();
  const waitMs = deps.waitTimeoutMs ?? ciMinutes * 60_000;
  for (;;) {
    const read = await readForge(deps, repoRoot, prNumber, gitlab, forge);
    if (!gitlab && read.state !== "OPEN") return `the PR is ${String(read.state)}, not OPEN`;
    if (read.prHead === undefined || !isFullCommitSha(read.prHead))
      throw new VerifyInfraError(
        "the forge gave no full head OID for the PR the checks were read at",
      );
    if (read.prHead !== verified)
      return `the PR head ${read.prHead.slice(0, 12)} is not the verified head ${verified.slice(0, 12)}`;
    if (read.rows === undefined || read.rows.length === 0)
      return "no checks reported — refusing to read the absence of evidence as green";
    const red = [
      ...namesOf(read.rows, "red", gitlab),
      ...namesOf(read.rows, "not-passing", gitlab),
    ];
    if (red.length > 0) return `checks not passing: ${red.join(", ")}`;
    // A row in no list at all is not evidence of a pass either: it waits, and
    // an expired wait hands back — an unreadable forge state never becomes red.
    const waiting = [
      ...namesOf(read.rows, "pending", gitlab),
      ...namesOf(read.rows, "unknown", gitlab),
    ];
    // GitLab's retryable readiness waits with the rows, on the same bound: both
    // mean "the forge has not finished deciding", and neither is a verdict.
    if (waiting.length > 0 || (gitlab && read.mergeStateStatus !== "CLEAN")) {
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
