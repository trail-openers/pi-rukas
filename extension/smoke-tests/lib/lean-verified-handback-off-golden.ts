/**
 * lib/lean-verified-handback-off-golden — the OFF arm of the handback, captured
 * before the rewind existed.
 *
 * The switch is a pure rollback: with it off the run reports what it would have
 * reported without the feature, so the assertion for that arm is byte equality
 * with a capture taken from the code before the rule — the record AND the comment
 * body, because a rewind that changed only the `needed:` line would still be a
 * behaviour change hiding behind a passing state check. The comment text is not
 * incidental: the review's reason names the fix head and the green's reason names
 * the verified head, so both shas are in the body the host reads and neither may
 * move.
 *
 * The JSON beside this file is produced by
 * `smoke-tests/fixtures/lean-state/capture-handback-off.ts`, which drives the verb
 * with the same {@link driveHandbackArm} used here; the driver asserts the shape
 * first, so an unrelated refactor cannot silently change what was captured — the
 * capture would stop matching and the case would go red rather than bless a new
 * value.
 *
 * `driveHandbackArm` is exported for `test-lean-verified-handback.ts`, which drives
 * BOTH arms through this function so the two records differ exactly where the rule
 * acts and nowhere else. It lives in `lib/` because the capture script is not a
 * test and `bun test` collects `smoke-tests/test-*.ts`: shared by a case and a
 * capture script, this is the only directory both can import from.
 *
 * The clock is the house {@link crossing} rig, keyed on `review`: the run walks on
 * `Date.now()` and is judged past its allowance at the boundary that decides
 * whether the re-verification may start, which is the one boundary the defect
 * lives behind. `handback` then runs only because the reporting states are exempt
 * from the stop.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flagBudgetMs, type CycleBudgetMs } from "../../src/work-driver-deadline.ts";
import type { LeanRunOutcome } from "../../src/lean/command.ts";
import { type LeanHandlers, runLean } from "../../src/lean/engine.ts";
import type { HandlerCtx, RunLeanResult } from "../../src/lean/engine.ts";
import type { Outcome } from "../../src/lean/state.ts";
import { handlersFor, leanSeed } from "../../src/lean/command.ts";
import { handbackOutcome } from "../../src/lean/handback.ts";
import { type Rewind } from "../../src/lean/handback-rewind.ts";
import { REPORT_STATES, leanLockFile, loadRun, saveRun, type LeanRun, type Step } from "../../src/lean/state.ts";
import { runWorkLeanVerb } from "../../src/headless/work-lean.ts";
import { runVerb } from "../headless-verb-harness.ts";
import { withEnv } from "./env-scope.ts";
import { crossing } from "./lean-host-contract-fixture.ts";
import {
  ARRIVE_GRACE_MS,
  FIXED_THEN_CROSSING,
  FIX_SHA,
  VERIFIED_SHA,
  postSpy,
  sleep,
  stopAtReverify,
  type StoppedDrive,
} from "./lean-verified-handback-fixture.ts";

/** The fixture the off arm is compared against. */
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "lean-state",
  "handback-off-v0.json",
);

/** What a drive reports: the record, the comment, and the outcome the verb returned. */
export interface OffGolden {
  state: string;
  code: number;
  reason?: string;
  steps: {
    key: string;
    state: string;
    attempt: number;
    outcome?: { kind: string; [field: string]: unknown };
  }[];
  /** Each reporting step's comment body, in log order. */
  reports: string[];
  /** How many times the forge post seam was reached: zero on the host channel. */
  posts: number;
  /** The head facts the handback step recorded, so the on arm can name them. */
  heads?: {
    shippedHead?: string;
    shippedVerified?: boolean;
    unshippedHead?: string;
    unshippedReason?: string;
  };
  /** Where origin's branch stood when the run reached its report, if a repo was wired. */
  origin?: { origin: string; branch: string; shaAtReport: string | undefined };
}

/** The host's whole-cycle arm: long enough that only the crossing stops the run. */
const BUDGET_MS = 240 * 60_000;

/** The rewind seam a case drives: a recorded answer, never a real push. */
export type RewindSeam = (verifiedHead: string) => Promise<Rewind>;

/** The `handback` handler the real wiring installs, with its post and rewind seams swapped. */
async function reportingHandlers(
  root: string,
  iss: number,
  post: (r: string, i: number, b: string) => Promise<void>,
  rewind: RewindSeam,
): Promise<LeanHandlers> {
  const wired = handlersFor(root, iss, { headless: true }, await leanSeed(root));
  if (wired.handback === undefined) throw new Error("the wiring has no handback handler to observe");
  return { ...wired, handback: (ctx: HandlerCtx) => handbackOutcome(ctx, post, rewind) };
}

/**
 * Drive the `review:fixed`-then-handback run and report what the record and the
 * comment say. `switchOff` sets `PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK=0` for the
 * duration; leaving it unset drives the shipped default. `rewind` is the seam the
 * handback moves origin with — a case's recorder, or a real push for the lease
 * tests.
 *
 * The drive is TWO passes over one record, because that is what the engine's own
 * shape requires. Pass one runs the walk to `review:fixed` and is routed into the
 * re-verification, whose entry the write-ahead puts on the log; the scripted queue
 * is empty there, so the handler parks and the file on disk holds exactly the
 * residue a killed process leaves. The harness reads that file, confirms the
 * pending re-verify sits behind a `fixed` review, and releases the parked drive.
 * Pass two — the house crossing clock, the same record — is the between-steps
 * deadline boundary a live run reaches a moment after its review returns: the
 * engine re-derives its position from the log, finds the `verify` entry with no
 * outcome, and the clock is what stops it from running it.
 */
export async function driveHandbackArm(
  issue: number,
  opts: { switchOff?: boolean; rewind?: RewindSeam; origin?: { repoRoot: string; origin: string } } = {},
): Promise<OffGolden> {
  const dir =
    opts.origin?.repoRoot ?? mkdtempSync(path.join(tmpdir(), `lean-handback-golden-${String(issue)}-`));
  const spy = postSpy();
  // ONE queue instance per pass, cloned from the same plan. A queue drained by the
  // first pass is a queue the second pass runs dry on at its FIRST step, which would
  // park the report pass at `ready` and never reach the boundary it exists for.
  const queue = () => stopAtReverify(FIXED_THEN_CROSSING, "verify", 1);
  // The pass the case is about, kept for `finally` so a thrown assertion never
  // leaves a parked handler holding the process's drive.
  let stopped = queue();
  const rewind =
    opts.rewind ??
    (async () => ({ shipped: false, reason: "no rewind wired" }) as Rewind);
  const env = {
    PI_ENSEMBLE_HANDOFF_CHANNEL: "host",
    PI_ENSEMBLE_FORGE: "none",
    ...(opts.switchOff === true ? { PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK: "0" } : {}),
  };
  const drive = (handlers: LeanHandlers, now: () => number) =>
    runLean({
      repoRoot: dir,
      issue,
      handlers,
      budgetMs: flagBudgetMs(BUDGET_MS) as CycleBudgetMs,
      now,
      seed: {
        version: "test",
        baseSha: "0123456789abcdef0123456789abcdef01234567",
        branch: `lean/issue-${String(issue)}`,
      },
    });
  // One working clock for both passes: the engine resolves its whole-cycle arm from
  // `now()` once and persists it, so a pass two that read a different scale would find
  // its own deadline years expired and stop before the boundary the case is about.
  // The working position is pinned at module evaluation, not at the first clock read:
  // pass one and pass two must resolve the SAME arm, and an arm re-derived between the
  // passes is a deadline the second pass has never seen.
  // The arm is the ONE epoch both passes resolve from, pinned here so a pass two
  // cannot re-resolve a deadline the first pass never had. `crossing` puts the run
  // past it at the boundary it judges, which is what stops the re-verification.
  const workingNow = Date.now();
  const working = (): number => workingNow;
  const wired = await reportingHandlers(dir, issue, spy.post, rewind);
  // The states this case is NOT about are answered from the script and the script
  // WINS: the real `ready` refuses a temp repo with no `pi-spec` block, and the real
  // `verify`, `publish` and `review` would make the drive about their outside world
  // rather than about the log. `handback` is the handler the case DOES care about and
  // is taken from the REAL wiring — only its post and rewind seams are the case's —
  // so the step under test is the one `runWorkLean` drives, host-channel stamp and
  // all.
  // Pass two's rig: ONE handler, for the pending re-verification, and it answers by
  // parking. Every other decided entry of the log is REPLAYED by `verifiedPosition`
  // without its handler running, and `handback` is the real reporting handler the case
  // observes — so the only handler this pass can reach is the undecided step the
  // deadline exists to stop. The harness releases it once the record on disk carries a
  // DECIDED `handback`: the exemption let the report through, which is the outcome the
  // case reads, and the released re-verify's own verdict lands afterwards on a run the
  // case never looks at.
  const passTwoRig = (): {
    handler: LeanHandlers;
    calls: string[];
    release: () => void;
  } => {
    const calls: string[] = [];
    let resolvePark: ((o: Outcome) => void) | undefined;
    const handler: LeanHandlers = {
      verify: (async () => {
        calls.push("verify");
        // Answered from the queue if the plan has one (it must NOT, for the pending
        // re-verify), and parked otherwise: the harness releases once the record shows
        // the run reached its report, so a run the clock stopped never runs it.
        return new Promise<Outcome>((resolve) => {
          resolvePark = resolve;
        });
      }) as never,
    };
    return { handler, calls, release: () => resolvePark?.({ kind: "red", reason: "released" }) };
  };

  try {
    const racing = drive({ ...wired, ...stopped.handlers }, working);
    // Parked at the re-verify: the record on disk is the killed process's residue.
    const reached = await raced(racing, stopped, dir, issue);
    if (!reached) {
      stopped.release();
      await racing;
      throw new Error(
        `the drive stopped at ${String(stopped.standingAt())} after ${stopped.calls.join(",")}, not at the re-verify`,
      );
    }
    // The lock the parked drive holds is removed here. A crashed process's lock is
    // exactly what `judgeOwner` clears for a run it can prove dead, so removing the
    // file is what the engine itself would do on the issue's next run — not a way
    // around the lock. The parked drive stays parked on its unresolved promise until
    // the release below, which is the point: its record is final at this moment.
    rmSync(leanLockFile(dir, issue), { force: true });
    const before = loadRun(dir, issue);
    assertPendingReverify(before?.steps ?? [], issue);

    // Release the parked handler so its promise settles; the released drive writes
    // ITS verdict into the file, so the harness restores the residue it read and
    // awaits the settled drive before starting pass two — no writer is left running
    // behind the second drive.
    stopped.release();
    await racing;
    saveRun(dir, before as LeanRun);
    rmSync(leanLockFile(dir, issue), { force: true });

    // Pass two: the same record, the clock crossing at the boundary the run stands
    // on, and the verb around it so the host-channel projection is the production one.
    let result: RunLeanResult | undefined;
    const clock = crossing({ at: "review", repoRoot: dir, issue });
    const pass2 = passTwoRig();
    await withEnv(env, () =>
      runVerb("work-lean", [String(issue)], dir, (argv, ctx) =>
        runWorkLeanVerb(argv, ctx, async (root, iss) => {
          const driving = drive({ ...wired, ...pass2.handler }, clock.now);
          const reported = await reportedThen(driving, dir, issue);
          if (!reported) {
            stopped.release();
            await driving;
            throw new Error(
              `the report pass never reached its report (re-verify calls: ${String(pass2.calls.length)}, clock crossed: ${String(clock.crossed())})`,
            );
          }
          pass2.release();
          result = await driving;
          return {
            summary: `work-lean #${String(iss)}: ${result.state} (exit ${String(result.code)})`,
            result,
          } satisfies LeanRunOutcome;
        }),
      ),
    );

    if (result === undefined) throw new Error("the second pass never reached the engine");
    const handback = [...result.run.steps].reverse().find((s) => s.state === "handback");
    const oc = handback?.outcome;
    const golden: OffGolden = {
      state: result.state,
      code: result.code,
      ...(result.run.result?.reason === undefined ? {} : { reason: result.run.result.reason }),
      steps: result.run.steps.map((step) => ({
        key: step.key,
        state: step.state,
        attempt: Number(step.key.slice(step.key.lastIndexOf(":") + 1)),
        ...(step.outcome === undefined
          ? {}
          : { outcome: structuredClone(step.outcome) as OffGolden["steps"][number]["outcome"] }),
      })),
      // One comment body per reporting step, read where the host channel puts it: the
      // step's own `report`. A run that ended in `decline` reports there instead, so
      // this reads both reporting states rather than only `handback`.
      reports: result.run.steps
        .filter((step) => REPORT_STATES.includes(step.state))
        .map((step) => String(step.outcome?.report ?? ""))
        .filter((body) => body !== ""),
      posts: spy.posts.length,
      ...(oc === undefined
        ? {}
        : {
            heads: {
              ...(oc.shippedHead === undefined ? {} : { shippedHead: oc.shippedHead }),
              ...(oc.shippedVerified === undefined
                ? {}
                : { shippedVerified: oc.shippedVerified }),
              ...(oc.unshippedHead === undefined ? {} : { unshippedHead: oc.unshippedHead }),
              ...(oc.unshippedReason === undefined ? {} : { unshippedReason: oc.unshippedReason }),
            },
          }),
    };
    assertHandbackShape(golden);
    if (!clock.crossed())
      throw new Error("the clock never crossed: the run reported while inside its allowance");
    return golden;
  } finally {
    stopped.release();
    if (opts.origin === undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Wait for the drive to park at the re-verify, and check the record it left.
 * True means the file on disk holds the shape the defect needs.
 */
async function raced(
  racing: Promise<unknown>,
  stopped: StoppedDrive,
  dir: string,
  issue: number,
): Promise<boolean> {
  const deadline = Date.now() + ARRIVE_GRACE_MS;
  for (;;) {
    if (stopped.standingAt() === "verify" && pendingReverify(loadRun(dir, issue)?.steps ?? [], issue))
      return true;
    // The drive settled on its own: it never parked, so the walk is broken.
    if (await settledWithin(racing, 25)) return false;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Wait for the report pass to park at its `handback`, then release it.
 *
 * The engine has already saved the record by the time the reporting handler runs, so
 * the file on disk holds the finished run at the moment the handler parks: releasing
 * there lets the drive return its own result without ever re-entering the re-verify.
 * False means the pass never parked where the case says it must.
 */
/**
 * Wait until the pass has written a DECIDED `handback` to its own record, which is
 * the moment the reporting exemption has done its work and the case can read the run.
 * The pending re-verify is still parked at that instant, so the release that follows
 * cannot race the report it is being read against.
 */
async function reportedThen(driving: Promise<unknown>, dir: string, issue: number): Promise<boolean> {
  const deadline = Date.now() + ARRIVE_GRACE_MS;
  for (;;) {
    const steps = loadRun(dir, issue)?.steps ?? [];
    const handback = [...steps].reverse().find((s) => s.state === "handback");
    if (handback?.outcome !== undefined) return true;
    if (await settledWithin(driving, 25)) return false;
    if (Date.now() >= deadline) return false;
  }
}

/** Did `p` settle within `ms`? (0 = has it settled already.) */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  const sentinel = Symbol("pending");
  const won = await Promise.race([p.then(() => true), sleep(ms).then(() => sentinel)]);
  return won === true;
}

/** The newest step of a given state, decided or not. */
function newest(steps: { state: string; outcome?: { kind: string } }[], state: string) {
  return [...steps].reverse().find((s) => s.state === state);
}

/**
 * Does this log stand at an undecided re-verification behind a `fixed` review?
 * That is the position the defect is, and the position the rule must answer.
 */
function pendingReverify(steps: Step[], issue: number): boolean {
  if (steps.length === 0) return false;
  const last = steps[steps.length - 1];
  if (last === undefined || last.state !== "verify" || last.outcome !== undefined) return false;
  if (last.key !== `${String(issue)}:verify:1`) return false;
  const review = steps[steps.length - 2];
  return review?.state === "review" && review.outcome?.kind === "fixed";
}

/** The same question as {@link pendingReverify}, as a failure rather than a boolean. */
function assertPendingReverify(steps: Step[], issue: number): void {
  if (pendingReverify(steps, issue)) return;
  const shape = steps.map((s) => `${s.key}=${s.outcome?.kind ?? "PENDING"}`).join(" ");
  throw new Error(
    `the parked drive left no pending re-verify behind a fixed review: ${shape === "" ? "no steps at all" : shape}`,
  );
}

/**
 * Assert the drive reproduced the defect's SHAPE, whatever the fields eventually say.
 *
 * The capture script refuses to write a fixture this fails, and the off-arm case runs
 * it on every test run. Without it a refactor could change what the drive produces
 * and the golden would simply be re-captured to match, which proves nothing about
 * either the capture or the rule.
 */
export function assertHandbackShape(golden: OffGolden): void {
  if (golden.state !== "handed-back")
    throw new Error(`the drive ended ${golden.state}, not handed-back`);
  if (golden.code !== 10) throw new Error(`the drive exited ${String(golden.code)}, not 10`);
  const review = newest(golden.steps, "review");
  if (review?.outcome?.kind !== "fixed")
    throw new Error(`the newest review is ${String(review?.outcome?.kind)}, not fixed`);
  const verify = newest(golden.steps, "verify");
  if (verify === undefined) throw new Error("the log has no verify step at all");
  if (golden.posts !== 0)
    throw new Error(`a host-channel run reached the forge post seam ${String(golden.posts)} time(s)`);
  if (golden.reports.length !== 1)
    throw new Error(`the run reported ${String(golden.reports.length)} comment(s), not one`);
  if (verify.key <= review.key)
    throw new Error("the re-verify's entry was never written ahead of the review");
}

/** Read the captured off-arm golden. */
export function readOffGolden(): OffGolden {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as OffGolden;
}

/** The fixture path, for a failure message that says where to re-capture. */
export const OFF_GOLDEN_FIXTURE = FIXTURE;

/** The heads a run of this shape leaves behind, for a case that wants them named. */
export const GOLDEN_HEADS = { verified: VERIFIED_SHA, fix: FIX_SHA };
