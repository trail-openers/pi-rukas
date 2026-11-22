/**
 * The `ci` step's two outside reads: the project's full verify tier, and the forge's own answer about
 * the PR/MR.
 *
 * Split out of `ci.ts` because the step grew a second question about a red tier — was every test it named
 * already red at the base — and the two have different owners. This file runs the tier and turns a failed
 * exec into an infra throw or a red reason; {@link fullTierExcuse} owns the base-commit question. The forge
 * half is here so `readForge` owns both forges' argv and row grading while `ci.ts` keeps the decision.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { ghJsonUnsupportedReason } from "../gh-json-unsupported.ts";
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
 * The project config, read ONCE per step and passed down, so the tier, the wait bound and the tier's bound
 * all obey the same commit's `.pi/work.json`.
 */
export async function ciConfig(deps: CiDeps, ctx: HandlerCtx): Promise<WorkConfig> {
  return await deps.loadConfig(ctx.repoRoot, ctx.run.baseSha).catch((err: unknown) => {
    throw new VerifyInfraError(`could not load the project config: ${(err as Error).message}`);
  });
}

/**
 * Run the full tier in the worktree.
 *
 * `undefined` is a pass. A kill, a timeout or a command that never started is an infrastructure fault —
 * the tier never got to answer, so the run hands back rather than taking a build round. Anything else
 * non-zero is a real red, with the reason a red step records, the stream the excuse parses, and the result
 * object `ciTierObserved` decides admissibility from.
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
  // The tail and bound are `verify`'s own: the step log is one JSON document and `build`'s re-entry pastes
  // a red reason into a prompt, so one long line must not carry a whole log into the record.
  const tail = tailLines(out, TIER_TAIL_LINES);
  return {
    reason: clipReason(`the full verify tier exited ${String(e.code)}: ${cmd}\n${tail}`),
    stream: out,
    ran: ran.err,
  };
}

/**
 * `gh pr checks` exits **8** while checks are pending (gh 2.103.3: `8: Checks pending`), and the shared
 * executor rejects on any non-zero exit — without this the pending reply, the whole point of the poll, would
 * read as an infra throw. stdout still carries the rows, so the exit is tolerated as a signal about WHERE the
 * checks are, not about whether the read worked. The tolerance is a `gh` contract and stays gh-only: `glab`
 * has no such code, so a failed glab read is the infra throw it is.
 */
const GH_CHECKS_PENDING_EXIT = 8;

/** The states the merge gate's read calls pending, queued or in progress. */
const PENDING_ROWS = ["pending", "queued", "in_progress", "waiting"];
const RED_ROWS = ["fail", "failure", "cancelled", "cancel", "timed_out", "error"];
/** GitHub counts these as success and this step does not: a `paths-ignore:` gate then always reads
 *  green, which is a gate that cannot fail. */
const NOT_PASSING_ROWS = ["skipped", "skipping", "neutral"];
/**
 * A row's grade, read the way the merge gate reads one: gh's bucket first, the raw state as fallback.
 * GitLab rows carry no bucket and use `glRowGrade`, the shared table in `forge-gl-grade.ts`, so neither
 * side drifts on whether `skipped` counts as green.
 */
type RowGrade = "pending" | "red" | "not-passing" | "unknown";

/** One poll's read of the forge: the PR's own verdict plus its check rows. */
interface ForgeRead {
  /** The PR state verbatim, or `undefined` for an MR — GitLab's state is cross-checked in readiness. */
  state: unknown;
  /** `mergeStateStatus` verbatim (or the composed GitLab readiness), or `""` when the forge was silent. */
  mergeStateStatus: string;
  /** The PR head this verdict was observed at. */
  prHead: string | undefined;
  /** The check rows, or `undefined` when the reply was not an array. */
  rows: { name?: unknown; state?: unknown; bucket?: unknown; blocking?: unknown }[] | undefined;
  /** The composition's own words for a GitLab verdict — every field it read.
   *  Undefined on GitHub, where `mergeStateStatus` is gh's own word and needs no
   *  gloss. */
  detail?: string;
  /** The `detailed_merge_status` the composition read, verbatim — the word an
   *  operator looks up, and the one an expired wait quotes. Undefined on GitHub. */
  status?: string;
}

/** A row's grade, or `undefined` when the row is simply passing. */
function gradeRow(
  row: { state?: unknown; bucket?: unknown; blocking?: unknown },
  gitlab: boolean,
): RowGrade | undefined {
  // GitLab rows have no bucket and their `status` words are not gh's, so the shared table decides them.
  if (gitlab) return glRowGrade({ state: row.state, blocking: row.blocking });
  const v = String(row.bucket ?? row.state ?? "")
    .toLowerCase()
    .trim();
  // "Nothing said" is not a pass: graded passing the step would merge on it. Graded `unknown` it waits,
  // and an expired wait hands the run back.
  if (v === "pass" || v === "success" || v === "none") return undefined;
  if (PENDING_ROWS.includes(v)) return "pending";
  if (RED_ROWS.includes(v)) return "red";
  if (NOT_PASSING_ROWS.includes(v)) return "not-passing";
  return "unknown";
}
/**
 * The names shown to a human for rows graded in `want`. Both bounds exist because the strings come from the
 * forge — a handback line that quotes them must not grow with however many rows a repo runs.
 */
const HANDBACK_NAME_CHARS = 80;
const HANDBACK_NAMES = 10;

function namesOf(
  rows: { name?: unknown; state?: unknown; bucket?: unknown; blocking?: unknown }[],
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
  /** Exit codes whose rejection still carries usable stdout ({@link GH_CHECKS_PENDING_EXIT}) — a pending
   *  reply is DATA, not a failed read. */
  okExitCodes: readonly number[] = [],
): Promise<string> {
  const read = (c: string) =>
    deps.exec(c, {
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 512 * 1024,
      // The driver's own forge read: this `gh` is a host-channel call, so it gets the host env.
      env: verifyHostEnv(),
    });
  const ran = await read(cmd)
    .then((r) => ({ err: undefined as unknown, out: r as { stdout?: string } | undefined }))
    .catch((err: unknown) => ({ err, out: undefined as { stdout?: string } | undefined }));
  if (ran.err !== undefined) {
    const e = ran.err as { code?: unknown; stdout?: unknown };
    const pending =
      typeof e.code === "number" &&
      okExitCodes.includes(e.code) &&
      typeof e.stdout === "string" &&
      e.stdout.trim() !== "";
    if (!pending) {
      const unsupported = await ghJsonUnsupportedReason(ran.err, cmd, (c) =>
        read(c).then((r) => String((r as { stdout?: unknown }).stdout ?? "")),
      );
      throw new VerifyInfraError(`${why}: ${unsupported ?? "the command did not run"}`);
    }
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
 * One read of the forge, from ONE moment: the verdict and the head it is about.
 *
 * GitHub: verdict, rows and head out of the same `gh pr view` — two reads of a moving PR are two
 * moments, and a green about another head is no evidence about this one.
 *
 * GitLab: readiness is composed from `detailed_merge_status` and its cross-checks, head from
 * `diff_refs.head_sha` of the same reply.
 */
async function readForge(
  deps: CiDeps,
  repoRoot: string,
  prNumber: number,
  gitlab: boolean,
  forge: GlForge,
): Promise<ForgeRead> {
  if (gitlab) {
    // Both reads are the adapter's own argv, so the command strings stay in its pinned glab form.
    const read = await glRead(forge, prNumber);
    return {
      state: undefined,
      mergeStateStatus: read.mergeStateStatus,
      prHead: read.prHead,
      rows: read.rows,
      detail: read.detail,
      status: read.status,
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
 * The forge's required-check verdict for this PR, POLLED until the checks are terminal, the bound
 * expires, or the run's cycle deadline arrives.
 *
 * A still-running CI makes `mergeStateStatus` UNSTABLE, so a step that read once after publish would grade
 * that as red and spend a build round on code that is not broken. A pending or unrecognised row is WAITED;
 * red is reserved for a row that actually failed. Every iteration re-issues BOTH reads — including the
 * head — so a PR that moves off the verified head mid-wait is caught. An empty rows list is an immediate
 * red: "no checks reported" is the absence of evidence.
 *
 * The two bounds are SEQUENTIAL and separate: the wait gets the `ci` budget's minutes and the full tier
 * keeps its own afterwards ({@link ciTierBudgetMs}). Still pending when the wait expires is a handback,
 * never a red.
 *
 * On GitLab the same arms serve the composed readiness of `forge-merge.ts`, keyed on the readiness VALUE
 * and never on one status word, so the retry covers the whole retryable group — `checking`, `unchecked`,
 * `preparing`, `approvals_syncing` and `ci_still_running` — rather than the single word this step once
 * knew. The arms, in the order they decide:
 *
 *   - a red or not-passing JOB ROW is red immediately, whatever the readiness says — including UNKNOWN.
 *     The rows are evidence about this commit and they have already answered; the readiness only says the
 *     forge has not finished deciding, and waiting on it would spend the `ci` budget on a build that is
 *     already red and hand back instead of routing a fix round;
 *   - no red row, and either a row still pending or a readiness that is not CLEAN: WAIT on this bound, and
 *     name in the reason what is being waited on — the pending rows, or `readiness <value>` with the
 *     composition's detail when only the readiness is undecided (an empty reason would be a handback
 *     nobody can act on);
 *   - a DIRTY readiness is a verdict, not a wait: red, quoting the composition's detail, because the value
 *     that blocked the merge (`not_approved`, `need_rebase`, …) is the actionable part of the refusal.
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
    // A row in no list is not evidence of a pass either: it waits, and an expired wait hands back — an
    // unreadable forge state never becomes red.
    const waiting = [
      ...namesOf(read.rows, "pending", gitlab),
      ...namesOf(read.rows, "unknown", gitlab),
    ];
    // GitLab's retryable readiness waits on the same bound as the rows: both mean the forge has not
    // finished deciding, and neither is a verdict. The arm asks the readiness VALUE, so every status the
    // composition calls UNKNOWN is waited whether or not this poll has seen that word before.
    // A DIRTY composition is NOT waited: the forge has already answered, and waiting on an answer that
    // cannot change turns a verdict into an expired wait — a handback where a red was due.
    const glDecided = gitlab && read.mergeStateStatus === "DIRTY";
    if (waiting.length > 0 || (gitlab && read.mergeStateStatus !== "CLEAN" && !glDecided)) {
      // The reason must name what is being waited on. When only the readiness is
      // undecided there is no pending row to list, and a reason quoting nothing
      // leaves an operator with a handback and nothing to act on. The quoted
      // value is the one the operator can look up: the
      // `detailed_merge_status` the composition read, not the readiness word it
      // mapped it to.
      const why =
        waiting.length > 0
          ? waiting.join(", ")
          : `readiness ${read.status ?? read.mergeStateStatus}${
              read.detail === undefined || read.detail === "" ? "" : ` (${read.detail})`
            }`;
      // The whole-cycle arm is consulted on every WAIT, not only between steps: a poll that ignores it can
      // outlive the host's deadline and the run dies with no document. Read on the context's injected
      // clock so poll and engine cannot disagree about where step work ends.
      const cycle = ctx.run.deadlineMs;
      if (deadlineStopsSteps(cycle, ctx.now(), "ci"))
        throw new VerifyInfraError(
          `the ci wait stopped with ${Math.max(0, Math.round((cycle ?? 0) - ctx.now()) / MINUTE_MS)} min left of the cycle deadline: the run is inside its handoff allowance`,
        );
      if (deps.now() - start >= waitMs)
        throw new VerifyInfraError(
          `CI checks still pending after ${Math.round(waitMs / 60_000)} min: ${why}`,
        );
      await deps.sleep(CI_POLL_MS);
      continue;
    }
    // Every row terminal and none failed: the forge's own word is the last authority, since it encodes
    // the repo's branch protection.
    if (read.mergeStateStatus !== "CLEAN")
      return `mergeStateStatus is ${read.mergeStateStatus === "" ? "unreadable" : read.mergeStateStatus}${
        read.detail === undefined || read.detail === "" ? "" : ` (${read.detail})`
      }`;
    return undefined;
  }
}
