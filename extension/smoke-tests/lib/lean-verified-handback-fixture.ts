/**
 * lib/lean-verified-handback-fixture — the rig `test-lean-verified-handback.ts`
 * drives the verified-handback rule with.
 *
 * The rule reads ONE thing: the step log (`src/lean/handback-heads.ts`). So every
 * case hands the rule, the rewind, or the handback step a log a real drive wrote,
 * plus a real repo whose origin a real `git push` moves. What the rule does NOT
 * read is the stop cause — the deadline, the step cap, a handler that threw — so
 * nothing here drives the engine's clock or kills a child to manufacture one:
 * that would test the engine's routing (other files pin it) while leaving the
 * rule's own reading unobserved.
 *
 * The logs are BUILT by the engine, not typed by hand — `driveTo` runs `runLean`
 * with scripted handlers and returns the record the drive saved. A hand-written
 * array is a guess about what a drive writes, which is why
 * `lib/lean-real-log-fixture.ts` exists for the resume cases; the same argument
 * holds here. The `fixed`-review log is the interesting one: the table routes a
 * `fixed` review into a re-verification, so the plan answers `verify` ONCE and the
 * drive then dies at the second visit (the queue is empty and a queueless handler
 * throws, which the engine records as an error) — and the truncated prefix handed
 * back is the residue of the run at that moment: newest WORK step = the `fixed`
 * review, newest DECIDED `verify` = the green behind it.
 *
 * The rewind is driven against a REAL repo with a REAL bare origin through the
 * real executor, so "nothing moved" is a fact about the ref origin holds
 * afterwards — the house pattern of `lib/lean-publish-fixture.ts`. Every git call,
 * the fixture's own and the step's, carries `stepGitEnv()`, which is what keeps
 * `test-verify-loop-git-env` green.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { HandlerCtx, LeanHandlers } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { MAX_BUILD_ATTEMPTS } from "../../src/lean/machine.ts";
import {
  type LeanRun,
  type LeanState,
  type Outcome,
  type Step,
  createRun,
  newestDecided,
} from "../../src/lean/state.ts";
import { stepGitEnv } from "./lean-review-fixtures.ts";

/** The run's branch; `specifyBranch` prints it verbatim, so the rewind's ref is this. */
export const BRANCH = "lean/issue-2242";

/** The issue every case drives, so a ref or a record names one value. */
export const ISSUE = 2242;

/** Heads no real repo produced, for the rule's own cases where nothing is pushed. */
export const FAKE_VERIFIED = "1".repeat(40);

/** A second head no real repo produced, so "another green" is a distinct value. */
export const FAKE_LATER = "2".repeat(40);

/** The green's reason line, so the comment's `needed:` block names the head it certified. */
export const VERIFY_REASON = `all frozen tests green at ${FAKE_VERIFIED}`;

/** The executor the rewind is driven with: the real one, on an isolated git view. */
export const exec = ((cmd, opts) =>
  execp(cmd, { ...(opts ?? {}), env: stepGitEnv() })) as typeof execp;

/** Every temp dir this file's fixtures made, removed by the test at its end. */
export const ROOTS: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-handback-drive-"));
  ROOTS.push(dir);
  return dir;
}

/** The handback step's context: the run, its log, and the repo the rewind acts on. */
export function handbackCtx(
  steps: Step[],
  repoRoot: string,
  issue = ISSUE,
  branch = BRANCH,
): HandlerCtx {
  const run: LeanRun = {
    ...createRun({ issue, version: "test", models: {}, baseSha: FAKE_VERIFIED, branch }),
    steps,
  };
  return { repoRoot, issue, run, steps, stepKey: `${String(issue)}:handback:0`, now: () => 5 };
}

/**
 * The plan every driven log starts from: an ordinary walk to the review.
 *
 * `publish` carries TWO entries because the table visits it twice on the fix-wave
 * walk (`review:fixed` routes back through `verify`, which routes to `publish`
 * again), and a queue that ran dry at the second visit would record an `error`
 * where the case wants the run to keep walking.
 *
 * `build` carries the queue the walk visits. A RED at the gate is routed back
 * through `viaBuild`, which BILLs one of the table's rounds per visit, so the run
 * visits `build` as many times as its first gate verdict was red plus one; a queue
 * short of that gets the run to its gate instead of to its review. The constant
 * plus one is the ceiling the table can bill, so the plan never runs dry before
 * the table's own cap does.
 */
function walkPlan(verifyQueue: Outcome[]): Partial<Record<LeanState, Outcome[]>> {
  return {
    ready: [{ kind: "ok" }],
    // A frozen contract, so the handback comment carries a `Frozen acceptance
    // tests:` section: the off-arm comparison covers the WHOLE body.
    specify: [
      {
        kind: "ok",
        frozen: { "tests/AC1-verified-head.test.sh": "a".repeat(64) },
        tests: { AC1: ["tests/AC1-verified-head.test.sh"] },
      },
    ],
    build: Array.from({ length: MAX_BUILD_ATTEMPTS + 2 }, () => ({ kind: "ok" }) as Outcome),
    challenge: [{ kind: "none" }],
    verify: verifyQueue,
    publish: [
      { kind: "ok", prUrl: "https://github.com/o/r/pull/1" },
      { kind: "ok", prUrl: "https://github.com/o/r/pull/2" },
    ],
    review: [{ kind: "fixed", reason: "one fix wave" }],
  };
}

/** The green the walk earns before the review, naming the head the rule ships. */
function green(head: string, reason = `all frozen tests green at ${head}`): Outcome {
  return { kind: "green", verifiedHead: head, reason };
}

/** The red the gate returns on the walk's first visit, which buys another round. */
function red(): Outcome {
  return { kind: "red", reason: "AC1 exited 1 on the run's first build round" };
}

/**
 * The plan of a run whose gate went green the FIRST time it was asked.
 *
 * That single visit is load-bearing in a way a queue length should not be. The rule
 * reads the log's ORDER (see `handback-heads.ts`): a walk that read its gate twice
 * stands at its review with the second visit's entry LAST in the log, which reads
 * — correctly — as "a verify decided after the fixed review". The handback the
 * defect describes is the ordinary run whose gate went green once, whose single
 * `verify` entry sits BEFORE the review in the log and whose rule therefore fires.
 */
function oneGreenWalk(head: string): Partial<Record<LeanState, Outcome[]>> {
  // TWO greens, not one: the table routes a `fixed` review into a re-verification
  // and a gate that runs dry there records an `error` and ends the run, so the drive
  // cannot reach its merge on a single entry. The walk is cut at its review either
  // way, and the case is about the newest gate verdict BEFORE that re-verification.
  return { ...walkPlan([]), verify: [green(head, VERIFY_REASON), green(FAKE_LATER)] };
}

/** Land the walk on its merge, so the drive reaches a terminal state legitimately. */
function toMerge(): Partial<Record<LeanState, Outcome[]>> {
  return { ci: [{ kind: "green" }], land: [{ kind: "merged" }] };
}

/**
 * The log as the run held it while it stood at the LAST step of `state` that
 * decided `kind`: that step's own entry, which carries its verdict, and nothing the
 * route after it wrote.
 *
 * The engine writes a step ahead and fills its `outcome` into the same entry when
 * the handler returns, so the prefix has to END at that entry: one shorter would
 * drop the verdict the case is about, one longer would drag in the next step's.
 * That prefix is what the durable record looked like at the moment the run stood
 * there — which is exactly the bytes the reporting step reads on a resumed run.
 */
function heldAt(steps: Step[], state: LeanState, kind: string): Step[] {
  const at = lastDecidedIndex(steps, (s) => s.state === state && s.outcome?.kind === kind);
  if (at < 0) throw new Error(`the driven log has no ${state} step that decided ${kind}`);
  return steps.slice(0, at + 1);
}

/** The last index satisfying `pred`, without `Array#findLastIndex` (lib is ES2022). */
function lastDecidedIndex(steps: Step[], pred: (s: Step) => boolean): number {
  for (let i = steps.length - 1; i >= 0; i--) if (pred(steps[i] as Step)) return i;
  return -1;
}

/** Drive `plan` to its merge and return the log as the run held it at `state`/`kind`. */
async function driveHeldAt(
  plan: Partial<Record<LeanState, Outcome[]>>,
  state: LeanState,
  kind: string,
): Promise<Step[]> {
  return heldAt(await driveTo({ ...plan, ...toMerge() }, { stopAt: "landed" }), state, kind);
}

/**
 * The `verify` that decided AFTER the fix wave, appended to a driven log.
 *
 * This is the ONE fact the table will not hand over on demand: the engine drives
 * from the position its log FOLDS to, so a walk stopped at its review can never be
 * made to decide the re-verification it routes into. The entry is therefore appended
 * to a real driven log, carrying the key the engine's own attempt rule would give it
 * on that visit and the shape `state.ts` loads — the rule's reading is over a log a
 * run could have saved, and the assertion is about the rule, not the harness.
 *
 * The key's attempt number is the engine's own rule — the count of entries the
 * state already holds — so the appended entry is the one a real re-visit of the
 * gate wrote. The rule reads POSITION, not that number, so nothing here depends on
 * a key ordering; what the log needs is for the entry to sit after the review, and
 * an append is what puts it there.
 */
async function withLaterVerify(steps: Step[], head: string): Promise<Step[]> {
  const visits = steps.filter((s) => s.state === "verify").length;
  const first = steps.find((s) => s.state === "verify");
  if (first === undefined) throw new Error("the driven log has no gate step to re-visit");
  return [
    ...steps,
    {
      key: `${String(ISSUE)}:verify:${String(visits)}`,
      state: "verify",
      startedAt: first.startedAt,
      endedAt: first.startedAt + 1,
      outcome: green(head),
    },
  ];
}

/**
 * The log whose newest work step is a `fixed` review with a decided green behind
 * it, and which head that green named.
 *
 * The drive goes all the way to its merge — a legal walk, every verdict the table
 * routes on answered — and the log handed back is what the run held at its review:
 * the review WITH its verdict and nothing the re-verification decided afterwards.
 * The `verify` queue carries two greens because the table re-visits the gate after
 * a `fixed` review and a queue that ran dry there would stop the drive at its gate
 * instead of walking it to the merge; the re-verification's verdict is cut, which is
 * the whole point of the case.
 */
export async function fixedReviewLog(head = FAKE_VERIFIED): Promise<Step[]> {
  const steps = await driveHeldAt(oneGreenWalk(head), "review", "fixed");
  return stampReviewReason(steps);
}

/**
 * A `fixed`-review log whose gate certified the head origin ALREADY holds.
 *
 * The arm no queue of scripted verdicts can produce, because the shape is about the
 * repo rather than the walk: origin's branch still points at the green's own head when
 * the handback runs — a rewind that died between its push and its read-back, replayed.
 * Built from the driven log the same way {@link fixedReviewLog} is, then corrected in
 * place: the routing green's `verifiedHead` becomes the head the caller's origin holds.
 * The correction is the whole case, so it is asserted rather than hoped for — the rule
 * must still fire (a log whose newest gate sits after the review would silence it) and
 * must fire naming THAT head.
 */
export async function alreadyAtVerifiedLog(head: string): Promise<Step[]> {
  if (head === FAKE_LATER)
    throw new Error("the already-at-verified head must be a real head the case's origin holds");
  const steps = await fixedReviewLog(FAKE_VERIFIED);
  const reviewAt = lastDecidedIndex(steps, (s) => s.state === "review" && s.outcome?.kind === "fixed");
  const greenAt = lastDecidedIndex(
    steps,
    (s) => s.state === "verify" && s.outcome?.kind === "green" && s.outcome.verifiedHead === FAKE_VERIFIED,
  );
  if (greenAt < 0 || greenAt > reviewAt)
    throw new Error(
      `no routing green sits before the review to re-title (${String(greenAt)} vs ${String(reviewAt)})`,
    );
  const green = steps[greenAt] as Step;
  if (green.outcome === undefined)
    throw new Error(`the routing green at ${green.key} decided nothing, so there is nothing to re-title`);
  steps[greenAt] = {
    ...green,
    outcome: { ...green.outcome, verifiedHead: head, reason: `all frozen tests green at ${head}` },
  };
  const newest = newestDecided(steps, "verify");
  if (newest?.outcome?.verifiedHead !== head)
    throw new Error(
      `the log's newest decided green names ${String(newest?.outcome?.verifiedHead)}, not ${head}`,
    );
  return steps;
}

/** The review verdict re-worded to name the head the case's gate certified. */
function stampReviewReason(steps: Step[]): Step[] {
  const reviewAt = lastDecidedIndex(steps, (s) => s.state === "review" && s.outcome?.kind === "fixed");
  const review = steps[reviewAt];
  if (review?.outcome !== undefined)
    steps[reviewAt] = {
      ...review,
      outcome: { ...review.outcome, reason: VERIFY_REASON },
    };
  // What the case is about: the newest DECIDED gate verdict the rule will read is a
  // green naming this head, and it sits EARLIER in the log than the review does —
  // which is what the rule reads as "the green still speaks for the head". A log
  // whose newest gate sits after the review is one the rule reads as re-verified,
  // and it has its own case for that reading — so this fixture would be asserting
  // the wrong thing while passing. The test is the log's own ORDER, never a
  // comparison of keys: `verify:0` and `review:0` order by letter.
  const verified = newestDecided(steps, "verify");
  if (verified?.outcome?.kind !== "green" || verified.outcome.verifiedHead === undefined)
    throw new Error(
      `the log's newest decided verify is ${String(verified?.outcome?.kind)}, not a green naming a head`,
    );
  const greenAt = steps.indexOf(verified);
  const reviewRow = steps[reviewAt];
  if (reviewRow === undefined || greenAt > reviewAt)
    throw new Error(
      `the newest green (${verified.key}) sits at ${String(greenAt)}, after the review (${String(reviewRow?.key)}) at ${String(reviewAt)} — the rule would read this log as re-verified`,
    );
  return steps;
}

/**
 * The log of a run whose fix wave WAS re-verified: a `verify` decided AFTER the
 * `fixed` review, so the rule must not speak for it.
 */
export async function reverifiedLog(
  head = FAKE_VERIFIED,
  reverifiedHead = FAKE_LATER,
): Promise<Step[]> {
  const steps = await withLaterVerify(await fixedReviewLog(head), reverifiedHead);
  const newest = lastDecided(steps);
  if (newest?.state !== "verify" || newest.outcome?.kind !== "green")
    throw new Error(
      `the log's newest work step is ${String(newest?.state)}:${String(newest?.outcome?.kind)}, not a decided verify`,
    );
  if (!steps.some((s) => s.state === "review" && s.outcome?.kind === "fixed"))
    throw new Error("the log holds no fixed review, so the case would prove nothing");
  return steps;
}

/** The log of a run whose review decided `done` — clean, with no fix wave. */
export async function reviewDoneLog(head = FAKE_VERIFIED): Promise<Step[]> {
  return driveHeldAt(
    {
      ...walkPlan([red(), green(head)]),
      review: [{ kind: "done", reason: "review clean, no findings" }],
    },
    "review",
    "done",
  );
}

/**
 * The log whose newest work step is a `fixed` review and whose gate NEVER decided:
 * the handback over unverified bytes with no green to go back to.
 *
 * The two halves are in tension, and that is the interesting part. The table only
 * reaches a review through a DECIDED green, so a driven log standing at a `fixed`
 * review always carries one behind it; and the one edge that puts a run at
 * `handback` with an unanswered gate — the handler's `error` — is a DECIDED step,
 * which `newestDecided` sees, so the rule answers its other wording. No single
 * driven log is both, which is why the rule carries two reasons.
 *
 * So this takes the driven fix-wave log above — real keys, real order, the review
 * the table actually routed — keeps every step up to and including that review, and
 * takes the HEAD out of the green's verdict. The gate still answered, and the
 * report still quotes what it said; what it no longer names is a head, which is the
 * one thing the rule reads.
 *
 * The verdict and its text stay because the report's `needed:` line is the newest
 * decided verdict the log holds, read through {@link neededFromLog} — a function the
 * rule must not touch, and whose output the byte-for-byte comparison in the test is
 * against. An outcome-less step would print the fall-back sentence no pre-rule run
 * ever posted, and the comparison would be with a body nothing emitted.
 */
export async function unverifiedFixLog(head = FAKE_VERIFIED): Promise<Step[]> {
  const steps = await fixedReviewLog(head);
  const at = lastDecidedIndex(steps, (s) => s.state === "review" && s.outcome?.kind === "fixed");
  const held = steps.slice(0, at + 1);
  return held.map((s) => {
    if (s.state !== "verify" || s.outcome?.kind !== "green") return s;
    const { verifiedHead: _dropped, ...rest } = s.outcome;
    return { ...s, outcome: rest };
  });
}

/**
 * The log of a run that reached a handback with a `fixed` review and a gate that
 * answered NOTHING: the newest work step is the review, and the log holds no verdict
 * of the gate at all.
 *
 * No walk produces this, and it is not meant to look like one. It is the log a run
 * saves when its gate is stopped before it is first asked — a crash between the
 * review's verdict and the step that would have taken it, a run restored from a
 * record written before the gate ran — and it is the one input the rule answers with
 * "nothing decided", as opposed to the green-missing-a-head and the
 * gate-entered-and-unfinished cases, which each have their own wording and their own
 * log. A rule that collapsed the three would report a head it had not verified under
 * one of the other two's explanations.
 *
 * `green` is for the SPEAKS-ONLY step case only: the gate answers with a head, so the
 * rule fires naming it while the origin read below is driven to answer nothing — the
 * one shape that leaves the comment with a `speaks` claim and no head to print. Leave
 * it unset for every case about a log with no gate verdict at all (the entry stays
 * UNANSWERED, which is what "the gate never ran" means here — no step, or a step that
 * decided nothing, reads the same to the rule); passing a green would change the
 * rule's answer from "no verify of this run decided anything" to "the green recorded
 * no head", which is (d2)'s wording.
 */
export function unaskedGateReviewLog(opts: { green?: Outcome } = {}): Step[] {
  const verify: Step = {
    key: `${String(ISSUE)}:verify:0`,
    state: "verify",
    startedAt: 8,
  };
  return [
    { key: `${String(ISSUE)}:ready:0`, state: "ready", startedAt: 5, outcome: { kind: "ok" } },
    {
      key: `${String(ISSUE)}:specify:0`,
      state: "specify",
      startedAt: 6,
      outcome: { kind: "ok", frozen: { "tests/AC1-verified-head.test.sh": "a".repeat(64) } },
    },
    { key: `${String(ISSUE)}:build:0`, state: "build", startedAt: 7, outcome: { kind: "ok" } },
    ...(opts.green === undefined ? [verify] : [{ ...verify, outcome: opts.green }]),
    {
      key: `${String(ISSUE)}:review:0`,
      state: "review",
      startedAt: 9,
      outcome: { kind: "fixed", reason: "one fix wave" },
    },
  ];
}

/**
 * The log whose gate was entered and never ANSWERED, over a `fixed` review.
 *
 * The rule's other "no verified head" wording, and a different log from
 * {@link unverifiedFixLog} on purpose. One green is left standing because the table
 * only routes to a review through a decided gate; every gate step after it loses its
 * outcome, which is what a run that was stopped inside the re-verification saved.
 * So the newest gate the rule can read is no gate at all, and it must answer that
 * nothing of this run decided anything — the wording a green missing its head does
 * not earn.
 */
export async function undecidedFixLog(head = FAKE_VERIFIED): Promise<Step[]> {
  const steps = await fixedReviewLog(head);
  const at = lastDecidedIndex(steps, (s) => s.state === "review" && s.outcome?.kind === "fixed");
  const held = steps.slice(0, at + 1);
  const first = held.find((s) => s.state === "verify");
  if (first === undefined) throw new Error("the driven log has no gate step to re-visit");
  // The key and shape the engine's own attempt rule gives the re-verification, so
  // this is a log a run could have saved with its gate still open.
  return [
    ...held,
    { key: `${String(ISSUE)}:verify:${String(held.filter((s) => s.state === "verify").length)}`, state: "verify" as const, startedAt: first.startedAt },
  ];
}
/** The newest step that was WORK and carried a verdict (a report state is how a run ended). */
function lastDecided(steps: Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step === undefined || step.outcome === undefined) continue;
    if (step.state === "handback" || step.state === "decline") continue;
    return step;
  }
  return undefined;
}

/**
 * Drive a run with a scripted plan and hand back the log it wrote.
 *
 * `runLean` stops on a state with no handler, so the plan's states get queue-backed
 * handlers and the walk runs to wherever the table and the queues take it. A state
 * whose queue is empty THROWS, which the engine records as `error` and ends the run
 * — that is the mechanism every truncated case uses, and the reason the plan, not
 * the harness, decides where a run dies.
 */
async function driveTo(
  plan: Partial<Record<LeanState, Outcome[]>>,
  opts: { stopAt?: LeanState } = {},
): Promise<Step[]> {
  const dir = scratch();
  const handlers: LeanHandlers = {};
  const queues: Partial<Record<LeanState, Outcome[]>> = {};
  for (const [state, queue] of Object.entries(plan))
    queues[state as LeanState] = [...(queue ?? [])];
  for (const state of Object.keys(queues) as LeanState[]) {
    handlers[state] = async () => {
      const next = queues[state]?.shift();
      if (next === undefined) throw new Error(`no scripted outcome for ${String(state)}`);
      return next;
    };
  }
  const r = await runLean({ repoRoot: dir, issue: ISSUE, handlers, maxSteps: 24 });
  if (opts.stopAt !== undefined && r.state !== opts.stopAt)
    throw new Error(
      `the drive ended ${r.state}, not ${opts.stopAt}: ${r.run.steps.map((s) => `${s.key}=${String(s.outcome?.kind ?? "?")}${s.outcome?.message === undefined ? "" : `(${s.outcome.message.slice(0, 40)}`}`).join(" ")}`,
    );
  if (r.run.steps.length === 0) throw new Error("the drive wrote no steps");
  return [...r.run.steps];
}
