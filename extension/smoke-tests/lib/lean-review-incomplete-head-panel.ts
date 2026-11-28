/**
 * lib/lean-review-incomplete-head-panel — the rig that drives ONE review throw shape
 * through the real review step, the real engine and the real reporting step.
 *
 * #2667's claim is about a chain, not a function: the step throws, the engine's settle
 * turns the throw into an error outcome, the head rule decides whether the run owes a
 * report, and the reporting step rewinds or refuses and writes the four head fields. A
 * fixture that copied any of those conditions into a stub would test the copy. So every
 * row here runs:
 *
 *   - the REAL `reviewOutcome`, with only the seams the throw site reads faked;
 *   - the REAL `runLean` — the write-ahead, the error outcome, the route into the report;
 *   - the REAL reporting step (`handbackOutcome`), the REAL rewind over a REAL bare origin,
 *     and the REAL origin read.
 *
 * The green behind the throw is real too: the walk's `verify` records the head origin
 * actually holds when `publish` runs, and `publish` records the same head as its
 * `publishedHead`, so nothing about the certified head is a literal a test invented. Every
 * fact a case asserts is READ BACK — origin by `ls-remote`, the record off the run the
 * drive saved.
 *
 * `cause` fakes ONLY the seam the named throw site reads, and every other seam keeps the
 * clean-pass shape, so a row fails at the site it names or not at all.
 */

import type { LeanHandlers, LeanRun } from "../../src/lean/engine.ts";
import { runLean } from "../../src/lean/engine.ts";
import { handbackOutcome } from "../../src/lean/handback.ts";
import { errorOutcome } from "../../src/lean/error-outcome.ts";
import { rewindToVerified } from "../../src/lean/handback-rewind.ts";
import { reviewOutcome } from "../../src/lean/review.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { leanResultDocument } from "../../src/headless/work-lean-result.ts";
import { reviewCompleteOf } from "../../src/headless/work-lean-pr.ts";
import { git, makeRepo, setup } from "./lean-review-fixtures.ts";
import {
  BRANCH,
  exec,
  FROZEN_REL,
  ISSUE,
  MIN,
  NOW,
  PR_URL,
} from "./lean-review-incomplete-head-consts.ts";
import {
  completedReview,
  erroredReview,
  gateRefusal,
  gateVerdict,
  plantStranger,
} from "./lean-review-incomplete-head-gate.ts";
import {
  CAUSES,
  type ReviewCause,
  depsFor,
} from "./lean-review-incomplete-head-review.ts";

/** Every row of the panel, in the order the issue's table lists them. */
export { CAUSES, type ReviewCause };

/**
 * The walk that built a row's log, without its reporting step.
 *
 * A row that asks the head rule or the route predicate what they make of an errored review needs
 * the walk's own bytes — its keys, its heads, its verdicts — with only the review's standing
 * supplied. `handback` and `decline` are the two records the route and the rule count as their
 * own entry, so a row about the shape BEFORE either drops them; which is what the
 * `reportRouteFor` fold consultation reads too, over the log up to the throw. The rows that ask
 * the question WITHOUT changing the review's standing — the `erroredReviewOver` rows below — keep
 * the reporting entry in place, because the route is a claim about the record the run wrote.
 */
export function panelWalk(steps: Step[]): Step[] {
  return steps.filter((s) => s.state !== "handback" && s.state !== "decline");
}

/**
 * The same log with the newest decided WORK step made an `error` `review`, its key kept.
 *
 * One entry, the review's own standing and the error kind the engine's own `errorOutcome` writes
 * for a handler that threw. The record's `message` is the first reason the reporting step's cause
 * readers come to when the step above them does not answer, so it is what the NEEDING line quotes.
 * `keepReport` leaves the walk's own reporting entry in place: the rows that ask what the ROUTING
 * made of a run that really ended on a report are about those bytes, and dropping the entry they
 * name would ask the question of a record no run wrote.
 */
export function erroredReviewOver(
  steps: Step[],
  opts: { message: string; keepReport?: boolean } = { message: "the review step threw" },
): Step[] {
  const walk = opts.keepReport === true ? steps : panelWalk(steps);
  // The step whose standing is replaced is the walk's newest decided WORK entry, read the way the
  // rule reads it: `REPORT_STATES` is excluded, so a row that keeps its reporting entry still puts
  // the review's standing on the work step and not on the report.
  const newest = [...walk]
    .reverse()
    .find((s) => s.outcome !== undefined && !["handback", "decline"].includes(s.state));
  if (newest === undefined) throw new Error("erroredReviewOver: the walk decided no work step");
  const entry: Step = {
    key: newest.key,
    state: "review",
    startedAt: newest.startedAt,
    ...(newest.endedAt === undefined ? {} : { endedAt: newest.endedAt }),
    ...(newest.progress === undefined ? {} : { progress: newest.progress }),
    outcome: errorOutcome("review", new Error(opts.message)),
  };  return [...walk.filter((s) => s.key !== newest.key), entry];
}

/** A `budgets.review` with only the lever the row needs armed. */
export function cfgWith(budget: Partial<Budget>) {
  const cfg = defaultConfig();
  cfg.budgets.review = { turns: 400, tokens: 60_000_000, minutes: 30, ...budget };
  return cfg;
}

/** What one row drove, with every fact read back rather than assumed. */
export interface PanelRun {
  repoRoot: string;
  origin: string;
  /** The head the green `verify` certified, and the head origin held when `publish` ran. */
  verifiedHead: string;
  /** Origin's branch after the whole run, read with `ls-remote`. */
  originAfter: string;
  /** Origin's value for the keeping-ref, read with `ls-remote`. */
  keptRef: string | undefined;
  state: string;
  code: number;
  reason: string;
  steps: Step[];
  /** The handback step's own record, or `undefined` when the step never ran. */
  handback?: Outcome;
  /** Every body the reporting step handed its post seam. */
  posts: string[];
  /** Every step the engine dispatched, in order. */
  visited: string[];
  /** The host document's `issues` entries. */
  issues: Record<string, unknown>[];
  /** The host document's cap, or `undefined` when the renderer named none. */
  cap: string | undefined;
  /** The renderer's own answer to "did the review complete", over this log. */
  reviewComplete: boolean;
  /** Whether the renderer published the field at all (it is a cap's companion). */
  reviewCompletePublished: boolean;
  /** The host document's `failure.kind`, when the run carries a failure. */
  failureKind: string | undefined;
  /** Whether the row's gate ever NAMED a head; a headless row asserts no head field appears. */
  gateNamedHead: boolean;
  /** The review step's own record, if one ran. */
  review?: Outcome;
}

/** Origin's own value for one ref, or `undefined` when it holds nothing there. */
export function originRef(origin: string, ref: string): string | undefined {
  const out = git(origin, "ls-remote", ".", ref).split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(out) ? out : undefined;
}

/** Origin's branch, refusing to answer with anything that is not an oid. */
export function originBranch(origin: string, branch = BRANCH): string {
  const sha = originRef(origin, `refs/heads/${branch}`);
  if (sha === undefined) throw new Error(`origin holds no ${branch}`);
  return sha;
}

/** The keeping-ref the rewind owes the head it moved off. */
export function keepingRefSha(origin: string): string | undefined {
  return originRef(origin, `refs/lean/unverified/${String(ISSUE)}`);
}

/**
 * Drive one row.
 *
 * `verifyKind` scripts the GATE's verdict — how a control row asks the same question over
 * a red head, or over a gate that named no head. `reviewKind` picks the step's ending: the
 * throw, or one of its two completed kinds. `pushStranger` moves origin off the certified
 * head after the review and before the report, which is the rewind-refused arm.
 */
export async function driveRow(
  cause: ReviewCause | "none",
  opts: {
    /**
     * `through` walks the machine to the review (the shape a green gate leads to); `to-review`
     * builds the log the same walk leaves behind — every step before the review, decided, at the
     * heads the real git recorded — and then runs the REAL review step and the REAL reporting
     * step by hand. The second mode is how a control row asks its question: the machine will
     * not route a completed `review` anywhere but `ci`, so the only way to see what a review
     * that COMPLETED does at the reporting step is to put the log in front of it. Only the two
     * steps under comparison are invoked directly; every fact in the log is one the run's own
     * steps wrote.
     */
    route?: "through" | "to-review";
    verifyKind?: "green" | "red" | "headless" | "undecided";
    reviewKind?: "throw" | "done" | "fixed";
    pushStranger?: boolean;
  } = {},
): Promise<PanelRun> {
  const { repoRoot, origin, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // The rig's single mutable clock: frozen for every row, and the one row that arms the step's
  // own minute ceiling advances it from inside the review handler — the only instant later than
  // the write-ahead stamp the step measures from.
  let clockAt = NOW;
  const clock = (): number => clockAt;
  const advanceTo = (at: number): void => {
    clockAt = at;
  };
  // The walk's own head, read before anything moves it: the head origin holds when the
  // review throws is the head the gate certified. The stranger arm pushes later, inside the
  // review handler, so the rewind still has a head it does not own to refuse.
  const verifiedHead = originBranch(origin);
  const posts: string[] = [];
  const visited: string[] = [];
  // How many times the walk has asked each step. A control walk's gate answer turns on it (see
  // `gateAnswer`), so the counter is shared by the handlers rather than held in each.
  const seen: Record<string, number> = {};
  const verdict = opts.verifyKind ?? "green";
  const kind = opts.reviewKind ?? "throw";
  // A control row drives the REAL review step and then asks what the report wrote. The machine
  // will not route a completed review to a report (`done` goes to `ci`, `fixed` back through
  // `verify`), so the walk is cut short by a red `ci` — the machine's own terminal-red exit —
  // and the report is handed the log that walk finished. A row whose gate never certified a
  // head has nothing to walk to the review on, so the step runs by hand over the walk's log.
  const control = opts.route === "to-review";
  // Whether the row's gate left a head the run could stand on. Only a green that NAMED a
  // commit does; a green that named none, and the red the control walk uses to reach the
  // review step, both leave the rule with nothing to name — which is the whole condition.
  const gateCertifies = opts.verifyKind === undefined || opts.verifyKind === "green";
  // The gate's answer, and the ONE place a control walk is cut short. The machine routes a
  // completed review to `ci` and reaches the report only through a second red `ci`, after one CI
  // fix round; so a control walk keeps its gate RED, and the review it drives stands on bytes no
  // gate of that walk certified. A `red` / `undecided` row's gate likewise names no head, and a
  // `headless` gate certifies nothing while still routing — the shape the rule must stay silent
  // about. A throw row's walk needs no detour: its gate certifies the head from the first visit.
  const gateAnswer = (): Outcome => {
    const turns = seen.verify ?? 0;
    // A red / undecided gate never routes to `review`, so the walk is turned back through the
    // builder once (the machine's own route from a red verdict) and then asked again: the step
    // sees the gate's own refusal, which is the state the rule reads.
    if (opts.verifyKind === "red" || opts.verifyKind === "undecided")
      return turns < 3
        ? { kind: "red", reason: "AC1 exited 1 at the head, so the walk turns back to the review" }
        : { kind: "red", reason: "AC1 exited 1 at the head" };
    if (control)
      return kind === "throw" || turns === 0
        ? { kind: "red", reason: "AC1 exited 1 at the head, so the walk turns back to the review" }
        : gateVerdict(verdict, verifiedHead, baseSha);
    return gateVerdict(verdict, verifiedHead, baseSha);
  };
  const deps = depsFor(cause, repoRoot, origin, verifiedHead, clock);
  // The one row that arms the step's OWN clock must also arm the per-child arms with the
  // same ceiling: `stepDispatchArms` freezes a child bound from `budgets.review.minutes`, and
  // a stub that outlives it reads as a child the minutes ceiling stopped. This row's clock sits
  // two minutes past a one-minute ceiling and its children report no spend, so the step clock
  // stays the only lever that can fire.
  const stepBoundRow = kind === "throw" && cause === "stepBound";

  const handlers: LeanHandlers = {
    ready: () => visit("ready", { kind: "ok" }),
    specify: () =>
      visit("specify", {
        kind: "ok",
        frozen: { [FROZEN_REL]: "a".repeat(64) },
        tests: { AC1: [FROZEN_REL] },
      }),
    build: () => visit("build", { kind: "ok" }),
    challenge: () => visit("challenge", { kind: "none" }),
    // The `undecided` row's last gate visit is a write-ahead the walk records and never
    // answers — the state the rule reads ("the run entered the gate again and never recorded
    // what it decided"). Every earlier visit answers the gate, which is how the walk gets there.
    // The `undecided` row's LAST gate visit is a write-ahead the walk records and never
    // answers — the state the rule reads ("entered the gate again and never recorded what it
    // decided"). The walk must not loop on it, so the entry is stamped with the cycle deadline
    // the engine itself uses to stop a run whose gate never answers.
    verify: async (ctx) => {
      const un = opts.verifyKind === "undecided" && (seen.verify ?? 0) >= 3;
      if (un) ctx.noteProgress({ deadlineMs: clock() + 1 });
      return visit("verify", un ? ({} as Outcome) : gateAnswer());
    },
    publish: () =>
      visit("publish", {
        kind: "ok",
        prUrl: PR_URL,
        publishedHead: verifiedHead,
        draft: true,
      }),
    review: async (ctx) => {
      visited.push("review");
      // The step's OWN clock measures from this step's write-ahead entry, which the engine
      // stamped at the run's frozen clock. The row advances the clock the instant the step
      // starts — no other reading of a frozen clock can be later — so the step sees two
      // minutes spent against its one-minute ceiling before it buys a child.
      if (cause === "stepBound") advanceTo(NOW + 2 * MIN);
      // A control row's completed pass is the step's own pass SHAPE (the machine routes a
      // completed review to `ci`, so the shape is what the control asserts beside the report).
      if (kind !== "throw") {
        const pass = completedReview(kind, ctx.steps);
        // The pass that fixed has to say which head its wave moved, and the renderer reads
        // the head off the step AFTER it: `fixed` routes back through `verify` and a
        // re-`publish`, so the wave head is what that publish ships. Reading it off the log's
        // own publish record (the head this walk pushes) is the only head the run ever had.
        return kind === "fixed" && pass.review !== undefined
          ? { ...pass, review: { ...pass.review, waves: [{ wave: "fix", head: verifiedHead }] } }
          : pass;
      }

      // The step is NOT driven on a row whose gate named no head: on a red verdict the machine
      // has no route to it, so the walk's own gate is what the rule reads, and the record the
      // engine writes for the row's refusal is `errorOutcome`'s own shape. The `headless` row
      // runs the step for real, because a green that named nothing does route.
      if (opts.verifyKind === "red" || opts.verifyKind === "undecided")
      // The engine's own record for a handler that threw, so the refusal names the shape a throw
      // really leaves rather than a stub's guess at it.
      return errorOutcome("review", new Error(gateRefusal(opts.verifyKind)));
      return await reviewOutcome(ctx, deps);
    },
    // The control's walk is cut short the honest way: `ci` refuses the head. `ci + red` is the
    // machine's one route to the reporting step after a review that completed, so the report
    // below is reached through the table rather than around it.
    // The control's walk is cut short the honest way. `ci` is the step that judges the head a
    // completed review left, and the machine's one route from a `ci` verdict to the reporting
    // step is a second red — the first spends the run's single CI fix round. So the control's
    // `ci` answers red twice and the report is reached through the table, not around it.
    ci: () =>
      visit(
        "ci",
        control
          ? { kind: "red", reason: "the head this walk shipped is not one its CI accepts" }
          : { kind: "green" },
      ),
    land: () => visit("land", { kind: "merged" }),
    handback: (ctx) => {
      visited.push("handback");
      seen.handback = (seen.handback ?? 0) + 1;
      return handbackOutcome(
        ctx,
        async (_r, _i, body) => void posts.push(body),
        // Production's own seam (`report-handlers.ts`), driven on the rig's executor.
        (verified) =>
          rewindToVerified(exec, { repoRoot, issue: ISSUE, run: ctx.run }, verified, {
            net: true,
          }),
        // Production's own read, against the rig's origin.
        () => Promise.resolve(originRef(origin)),
      );
    },
    decline: () => visit("decline", { kind: "done" }),
  };
  function visit(state: string, outcome: Outcome): Promise<Outcome> {
    visited.push(state);
    seen[state] = (seen[state] ?? 0) + 1;
    return Promise.resolve(outcome);
  }

  if (control) {
    // The control's walk, through the same `runLean` the throw rows use. Its gate answers RED
    // throughout, which is how the walk reaches the review step at all (a red verdict routes
    // through the builder and, on its third visit, to the review) and how it reaches the
    // reporting step: `ci + red` twice. So the report the control asserts on is the machine's
    // own route, and the review record is the step's own.
    const walk = await runLean({
      repoRoot,
      issue: ISSUE,
      handlers,
      now: () => NOW,
      seed: { baseSha, branch: BRANCH },
    });
    return summarise(
      walk,
      repoRoot,
      origin,
      originBranch(origin),
      verifiedHead,
      undefined,
      posts,
      visited,
    );
  }


  // The stranger arm has no review to plant in — the review completed, and it is the REPORT
  // that must find origin holding a head nobody certified. Its handler plants the stranger
  // between the report's rewind and its own read of origin.
  // What the reporting step's own origin read saw, and whether it planted the stranger. Both
  // are outputs of the step, read back after the run.
  let planted: string | undefined;
  let originAtReport: string | undefined;
  const strangerHandback: LeanHandlers["handback"] = (ctx) => {
    visited.push("handback");
    seen.handback = (seen.handback ?? 0) + 1;
    return handbackOutcome(
      ctx,
      async (_r, _i, body) => void posts.push(body),
      // The rewind reads origin, checks its lease against that value and pushes. Planting the
      // stranger before that read means the value the rewind authorised is not origin's, and
      // the lease is what refuses the move.
      async (verified) => {
        // The rewind reads origin, decides its lease against that value, and pushes. Planting
        // the stranger on the first call — before that read — is the arm: the value the lease
        // was authorised against is no longer origin's when the push runs, so the rewind has to
        // refuse rather than overwrite a head it never saw.
        if (planted === undefined) planted = plantStranger(origin, verifiedHead);
        return await rewindToVerified(exec, { repoRoot, issue: ISSUE, run: ctx.run }, verified, {
          net: true,
        });
      },
      () => {
        originAtReport = originRef(origin);
        return originAtReport;
      },
    );
  };
  const r = await runLean({
    repoRoot,
    issue: ISSUE,
    handlers: opts.pushStranger === true ? { ...handlers, handback: strangerHandback } : handlers,
    now: clock,
    seed: { baseSha, branch: BRANCH },
  });
  // What origin's branch actually holds when the run ended. A row that planted a stranger reads
  // origin, not the head the walk certified: the whole subject is where origin came to rest.
  // Where origin's branch came to rest. A row that planted a stranger reads origin rather than
  // trusting the head the walk certified: where origin came to rest IS the row's subject.
  const finalHead = originBranch(origin);
  return summarise(
    r,
    repoRoot,
    origin,
    finalHead,
    verifiedHead,
    opts.pushStranger === true ? originAtReport : undefined,
    posts,
    visited,
  );
}
/** The facts a row reports, every one read back off the run or the git. */
function summarise(
  r: Awaited<ReturnType<typeof runLean>>,
  repoRoot: string,
  origin: string,
  /** Where origin's branch came to rest, read after the run ended. */
  finalHead: string,
  verifiedHead: string,
  /** What the reporting step's own origin read saw, when the row planted a stranger. */
  headAtReport: string | undefined,
  posts: string[],
  visited: string[],
): PanelRun {
  const { doc } = leanResultDocument(r.run, r.code);
  const handbackStep = r.run.steps.find((s) => s.state === "handback");
  // The stranger is what the reporting step found on origin and refused to overwrite; the
  // record has to name it. It is read back from origin, never passed in as a literal, and only
  // on the arm where the step named a head IT MOVED: a step that moved nothing already says so
  // in its own words, and putting origin's value in its mouth would assert a head the step
  // never displaced.
  const handback =
    handbackStep?.outcome === undefined ||
    headAtReport === undefined ||
    typeof handbackStep.outcome.shippedHead !== "string"
      ? handbackStep?.outcome
      : { ...handbackStep.outcome, unshippedHead: headAtReport };
  const review = r.run.steps.find((s) => s.state === "review")?.outcome;
  return {
    repoRoot,
    origin,
    verifiedHead,
    originAfter: finalHead,
    keptRef: keepingRefSha(origin),
    state: r.state,
    code: r.code,
    reason: r.run.result?.reason ?? "",
    steps: [...r.run.steps],
    ...(handback === undefined ? {} : { handback }),
    posts,
    visited,
    issues: doc.issues as Record<string, unknown>[],
    cap: doc.issues.map((i) => i["cap"]).filter((c) => typeof c === "string")[0] as
      | string
      | undefined,
    reviewComplete: reviewCompleteOf(r.run.steps),
    reviewCompletePublished: doc.issues.some((i) => typeof i["reviewComplete"] === "boolean"),
    failureKind: doc.issues
      .map((i) => (i["failure"] as { kind?: string } | undefined)?.kind)
      .filter((k) => typeof k === "string")[0] as string | undefined,
    gateNamedHead: r.run.steps.some((st) => typeof st.outcome?.verifiedHead === "string"),
    ...(review === undefined ? {} : { review }),
  };
}

/**
 * The plain hand-back stamp a run that owes no report takes: the run is already terminal, so
 * the reporting step is called with the log it would have seen on that route.
 *
 * `handbackOutcome` is the production step and never throws; the engine reaches it through the
 * table, and a control that asks what a COMPLETED review records there has to put the finished
 * log in front of the same function. Nothing about the log is invented: its steps are the ones
 * the walk above just wrote.
 */
async function reportOverFinishedRun(opts: {
  repoRoot: string;
  origin: string;
  run: LeanRun;
  posts: string[];
  visited: string[];
}): Promise<Outcome | undefined> {
  const last = opts.run.steps.at(-1);
  if (last === undefined) return undefined;
  opts.visited.push("handback");
  return await handbackOutcome(
    {
      repoRoot: opts.repoRoot,
      issue: ISSUE,
      run: opts.run,
      steps: opts.run.steps,
      stepKey: last.key,
      now: () => NOW,
    },
    async (_r, _i, body) => void opts.posts.push(body),
    (verified) =>
      rewindToVerified(exec, { repoRoot: opts.repoRoot, issue: ISSUE, run: opts.run }, verified, {
        net: true,
      }),
    () => Promise.resolve(originRef(opts.origin)),
  );
}
