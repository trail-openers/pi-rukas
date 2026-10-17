/**
 * work-queue — the multi-issue `/work` queue and what happens when a group fails.
 *
 * Extracted from commands.ts (#368; also keeps that file under the 500-line
 * cap and gives #289's bounded pool somewhere to live).
 *
 * Pre-#368 the loop returned on any non-`merged` status, so one issue's
 * failure stopped every unrelated issue behind it. Observed on this machine:
 * `/work` over 13 issues died on #279 and left **11 groups unstarted**; a
 * three-issue batch halted on its second item while the third was unrelated
 * and independently ready. Since 69% of the failures that trigger this are
 * provider infrastructure (#366), the queue was usually being stopped by
 * something with no bearing on the remaining work.
 *
 * The replacement is dead-letter-queue semantics — three destinations, not
 * two — and the whole design rests on one question: *is the next group likely
 * to fail for the same reason?*
 *
 *   merged  → continue
 *   parked  → issue-scoped failure; record why, continue
 *   halted  → systemic; continuing would burn every remaining issue against
 *             the same wall (spend cap, quota window, driver throw)
 *
 * #1101 added the fourth thing a group can be waiting for before it ever
 * starts, and split the module along that seam: the pre-dispatch policy lives
 * in `work-queue-scheduler.ts` (pure), the claim loop in `work-queue-worker.ts`,
 * the operator-facing cap text in `work-queue-cap.ts`, and the ordering-edge
 * discovery in `work-queue-deps.ts`. What stays here is the orchestration, the
 * summary, and the systemic-failure verdict.
 */

import { trace } from "./trace.ts";
import { classifyFailureCause } from "./work-driver-failure-taxonomy.ts";
import { captureInvocationStartRef } from "./work-driver-git.ts";
import type { GroupingResult } from "./work-driver-grouping.ts";
import { mergeQueueSummaryEntries } from "./work-queue-summary.ts";
import { type WorkerState, queueOrderingEnabled, runQueueWorker } from "./work-queue-worker.ts";
import { type WorkState, readState } from "./workflow-state.ts";

// #753 (six-lens FIX 5) — the renderer moved to work-queue-render.ts to keep
// this module under the 500-line cap; re-exported so importers keep working.
export { renderQueueSummary } from "./work-queue-render.ts";
// #1101 — the operator-facing cap text moved to work-queue-cap.ts; re-exported
// so importers of work-queue keep working, and so there is exactly one
// `humanActionFor` for the whole queue to agree on.
export { humanActionFor, waitCapFor } from "./work-queue-cap.ts";
// #1101 — the ordering gate's kill switch, re-exported so the env-var surface
// is discoverable from the module an operator actually reads about.
export { queueOrderingEnabled } from "./work-queue-scheduler.ts";
// The types moved to work-queue-types.ts so the scheduler and the worker can
// import them without importing this module back (a cycle through the worker
// would otherwise be load-bearing at runtime).
export type {
  GroupOutcome,
  IssueGroup,
  QueueEntry,
  QueueSummary,
} from "./work-queue-types.ts";
import type { GroupOutcome, IssueGroup, QueueEntry, QueueSummary } from "./work-queue-types.ts";
// #676 — re-exported so importers of work-queue keep working; the predicates
// live in work-queue-overlap.ts.
export { groupPathsOverlap, overlappingSiblingIds } from "./work-queue-overlap.ts";

/** #368 escape hatch: PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE=1 restores halt-on-first-failure. */
export function queueHaltOnFailure(): boolean {
  const v = process.env.PI_ENSEMBLE_QUEUE_HALT_ON_FAILURE;
  return v === "1" || v === "true";
}

/**
 * #1101 — how long a group tolerates waiting on a sibling before the wait
 * itself becomes the finding.
 *
 * 30 minutes is the right production number and it is not a guess: a `/work`
 * cycle that is genuinely running — explore, plan, develop, the adversarial
 * loop, six-lens review, CI — routinely takes that long, and the whole point
 * of the ordering edge is that a dependent waits for its dependency to
 * MERGE. A cap under an hour would park dependents whose dependency was
 * healthy and merely slow, which is the failure mode #1101 is fixing. It is
 * also the same figure `work-driver-path-claims.ts` already treats as the
 * generous ceiling for a live cycle (`_STALE_MS`), so the queue and the claim
 * registry do not disagree about how long a cycle may take.
 *
 * Two things make the number survivable rather than a hang:
 *
 *  - It is **injectable** (`RunQueueOpts.deferCapMs`) and tests pass a few
 *    hundred ms, so no test pays 30 minutes to prove the cap-out route.
 *  - It is a **bound, not a poll interval**. Waiters park on an event and are
 *    woken the instant anything they wait on settles, merges, parks or halts
 *    (`work-queue-worker.ts`'s `wake`); the timer only covers what no event
 *    reported. A group that is merely waiting on a healthy sibling does not
 *    consume the cap at all — it is woken when that sibling finishes.
 *
 * `PI_ENSEMBLE_QUEUE_DEFER_CAP_MS` is the operator's override for the same
 * reason `PI_ENSEMBLE_VERIFY_TIMEOUT_MS` exists: a host where 30 minutes is
 * the wrong number should not have to patch the extension.
 */
export const DEFER_CAP_MS = 30 * 60 * 1000;

/** The env-overridable defer cap; falls back to {@link DEFER_CAP_MS}. */
export function queueDeferCapMs(): number {
  const raw = process.env.PI_ENSEMBLE_QUEUE_DEFER_CAP_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    // A cap of 0 would make every wait a cap-out, which is a silent way to
    // disable the ordering gate; a negative parse is a typo. Either is ignored
    // rather than obeyed.
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFER_CAP_MS;
}

/**
 * Decide whether a finished group's failure is systemic.
 *
 * Systemic means "the next group will hit this too": a spend cap, or a quota
 * window that nothing will get past until it resets. Everything else — a
 * review cap, an adversarial rejection, a dirty tree, a transport blip — is
 * this issue's problem, not the queue's.
 */
export function isSystemicFailure(state: WorkState | undefined): {
  systemic: boolean;
  reason?: string;
} {
  if (!state) return { systemic: false };
  // #386 — the failure that matters is the one that ENDED the cycle, not the
  // most recent one of its kind. The driver retries transient faults, so a
  // cycle can hit a quota window, recover, run for another twenty minutes,
  // and then park for an unrelated semantic reason. Reading the last failure
  // unconditionally found the RECOVERED quota event and halted every
  // remaining group — the exact outcome #368 exists to prevent. A failure
  // followed by a successful `dispatch-completed` was recovered and does not
  // count.
  let lastFailure: WorkState["eventLog"][number] | undefined;
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (!e) continue;
    if (e.kind === "dispatch-completed") break;
    if (e.kind === "dispatch-failed-provider" || e.kind === "dispatch-failed") {
      lastFailure = e;
      break;
    }
  }
  if (!lastFailure) return { systemic: false };
  const cls = classifyFailureCause(lastFailure as Parameters<typeof classifyFailureCause>[0]);
  if (cls.cause === "rate-limited:quota-terminal") {
    return {
      systemic: true,
      reason: "provider spend cap reached — every remaining group would fail the same way",
    };
  }
  if (cls.cause === "rate-limited:quota-window") {
    const hours = Math.round((cls.waitMs ?? 0) / 3_600_000);
    return {
      systemic: true,
      reason: `provider quota window — nothing will succeed for roughly ${hours}h, so the rest of the queue would only burn attempts`,
    };
  }
  return { systemic: false };
}

export interface RunQueueOpts {
  repoRoot: string;
  groups: IssueGroup[];
  restart: boolean;
  /**
   * Run one group. The returned `started: false` means the driver refused
   * and never ran — a claim conflict, another live pid, a terminal state.
   * The queue MUST NOT read a state file as this group's outcome in that
   * case: the file on disk belongs to whatever cycle is actually running.
   */
  runGroup: (
    primary: number,
    issues: number[] | undefined,
    invocationStartRef: string | undefined,
  ) => Promise<GroupOutcome>;
  /** Groups to run at once. Defaults to 1 (strictly sequential). */
  concurrency?: number;
  readStateFn?: (repoRoot: string, issue: number) => Promise<WorkState | undefined>;
  /**
   * #1101 — cross-group ordering edges, keyed by the DEPENDENT group id.
   * `blockingGroupIds` are groups that must reach `merged` before this group
   * is claimed. Produced by `planOrderingEdges()` from the issues' declared
   * `Depends-on: #N` / `blocked by #N` statements; the queue does not parse
   * bodies itself.
   */
  dependencies?: Record<string, { blockingGroupIds: string[] }>;
  /**
   * How long a group may wait on a sibling before the wait itself becomes the
   * finding. Injectable so the cap-out route is testable without a 30-minute
   * test. #1101 changed what a cap-out DOES: it parks with the reason naming
   * the group that never released, where it used to drop the wait and proceed.
   * See {@link DEFER_CAP_MS} for why the default is 30 minutes and what keeps
   * that from being a hang.
   */
  deferCapMs?: number;
  /**
   * #1101 — group ids that sit inside a dependency cycle, from
   * `findCyclicGroups()`. Every one of them parks with `dependency-cycle`
   * BEFORE any dispatch: an ordering loop has no valid order, so running part
   * of it would build a dependent before the thing it depends on. Detected
   * pre-flight, which is what makes the runtime waits safe to look forward —
   * a cycle can only reach the wait cap if the graph changed underneath the
   * queue, and a cap-out is a named park rather than a hang either way.
   */
  cyclic?: string[];
}

/**
 * Run every group, parking failures instead of halting on them.
 *
 * A driver throw still halts: an unknown-shape failure is not safe to
 * continue past, because we cannot tell whether it left the repo in a state
 * the next group depends on.
 */
export async function runWorkQueue(opts: RunQueueOpts): Promise<QueueSummary> {
  const read = opts.readStateFn ?? readState;
  const groups = opts.groups;
  // Keyed by original index so the summary is deterministic regardless of the
  // order groups actually finish in.
  const entries = new Map<number, QueueEntry>();
  const claimed = new Set<string>();
  // #1093 — the operator's checkout, read ONCE before any group starts. A group
  // that leaves repoRoot on its own branch (a failed restore) must not become
  // a sibling's start ref, so every group stamps this value, not a re-read.
  const invocationStartRef = await captureInvocationStartRef(opts.repoRoot);
  const cap = Math.max(1, Math.min(opts.concurrency ?? 1, groups.length || 1));
  /**
   * The state every worker shares. One object, passed by reference: the claim
   * is taken between awaits (`cursor++` is atomic because JS is
   * single-threaded), and the scheduler reasons over `inFlight` / `settled` /
   * `merged` as a snapshot of exactly this.
   */
  const state: WorkerState = {
    repoRoot: opts.repoRoot,
    groups,
    runGroup: opts.runGroup,
    read,
    isSystemic: isSystemicFailure,
    haltOnFailure: queueHaltOnFailure,
    cursor: 0,
    halted: false,
    entries,
    claimed,
    // #1101 — who has taken a group. Set alongside `inFlight` on every claim,
    // read by the scan (to skip) and by `finish()` (to report).
    owners: new Set<string>(),
    // #1101 — groups the scan could not claim live here, not on the cursor:
    // sat-on-at-the-cursor is what let one blocked group wedge the whole
    // queue. See the module header of work-queue-worker.ts.
    deferred: [],
    inFlight: new Map<string, number>(),
    waiters: [],
    // Synchronous fan-out to every parked waiter. Reentrancy is fine: a
    // waiter's continuation runs after the current synchronous step, so the
    // state the caller just mutated is the state it observes.
    wake: () => {
      for (const w of state.waiters.splice(0)) w();
    },
    settled: new Set<string>(),
    resolved: new Set<string>(),
    merged: new Set<string>(),
    outcomeOf: new Map<string, QueueEntry["outcome"]>(),
    deferralStart: new Map<string, number>(),
    dependencies: opts.dependencies ?? {},
    orderingEnabled: queueOrderingEnabled(),
    deferCapMs: opts.deferCapMs ?? queueDeferCapMs(),
    invocationStartRef,
  };

  // #1101 — an ordering cycle is decided before a single dispatch. Claiming
  // these groups here (rather than letting a worker park them) is what makes
  // the assertion "runGroup was never called for them" true by construction:
  // they are already accounted for, so no worker can pick one up.
  if (state.orderingEnabled) {
    for (const [gi, g] of groups.entries()) {
      if (g.issues[0] === undefined) continue;
      if (!(opts.cyclic ?? []).includes(g.id)) continue;
      claimed.add(g.id);
      state.settled.add(g.id);
      state.outcomeOf.set(g.id, "parked");
      const others = (opts.dependencies?.[g.id]?.blockingGroupIds ?? []).join(", ") || g.id;
      entries.set(gi, {
        groupId: g.id,
        issues: g.issues,
        outcome: "parked",
        reason: `cap dependency-cycle: ${g.id} is part of an ordering cycle (waits on ${others})`,
        humanAction: `break the declared dependency cycle among ${g.issues.map((n) => `#${n}`).join(", ")} (remove or reverse one \`Depends-on\` / \`blocked by\` statement), then re-run \`/work ${g.issues.join(" ")} --restart\` — this group never started, so nothing was built`,
      });
      trace(`work-queue: ${g.id} parked — it is part of a dependency cycle`);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => runQueueWorker(state)));
  const summary = finish(entries, groups, claimed, state);
  // #382 — the summary is the most actionable state the run produces: which
  // groups parked, why, and what a human has to do about each. It used to
  // exist only in the scrollback of the session that produced it, so walking
  // away and coming back meant it was gone. #808 — merge, not overwrite: the
  // queue summary is an accumulating index and single-issue cycles write to
  // it too, so a whole-file overwrite here would erase the rows earlier
  // single-issue cycles recorded (the #765 incident shape, reversed). Only
  // this run's groups are replaced; rows for other issues are kept. Best-
  // effort: a failed write must not turn a completed queue into an error.
  await mergeQueueSummaryEntries(opts.repoRoot, summary.entries, summary.notStarted);
  // #1101 — one line naming the ordering graph whenever a group did not start
  // for a reason the operator did not choose. Silence here is what made the
  // original bug look like the driver refusing good work.
  const capped = summary.entries.filter((e) =>
    /dependency-parked|dependency-timeout|dependency-cycle|cross-group-conflict/.test(
      e.reason ?? "",
    ),
  );
  if (capped.length > 0) {
    trace(
      `work-queue: ${capped.length} group(s) parked before dispatch: ${capped.map((e) => `${e.groupId} (${e.reason})`).join("; ")}`,
    );
  }
  return summary;
}

function finish(
  entries: Map<number, QueueEntry>,
  groups: IssueGroup[],
  claimed: Set<string>,
  state: WorkerState,
): QueueSummary {
  // Never-claimed, not "everything after the last index". With K workers
  // groups complete out of order, so a positional slice would report groups
  // that actually ran as skipped — and miss ones that genuinely were.
  // #1101 — a group the queue itself parked (a dependency that never merged, a
  // wait that outlasted its bound) also counts as started: it has an entry, an
  // operator action, and belongs in the parked column. Testing only `claimed`
  // / `owners` double-reported every queue-level park as both `⏸ parked` and
  // `Not started`, which is the contradiction the operator would rightly
  // distrust. `resolved` is the honest test — it says the queue gave this group
  // an answer, however it arrived at one.
  const notStarted = groups
    .filter((g) => !state.resolved.has(g.id))
    .map((r) => `${r.id} (#${r.issues.join(", #")})`);
  // Ordered by original group index so the report reads the same every run.
  const ordered = [...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  // A systemic fault hits every in-flight group at once, so K workers can each
  // record a halt for the same cause. Tell the operator once.
  const halts = ordered.filter((e) => e.outcome === "halted");
  const deduped =
    halts.length > 1 ? ordered.filter((e) => e.outcome !== "halted" || e === halts[0]) : ordered;
  return {
    entries: deduped,
    merged: deduped.filter((e) => e.outcome === "merged").length,
    parked: deduped.filter((e) => e.outcome === "parked").length,
    refused: deduped.filter((e) => e.outcome === "not-started").length,
    notStarted,
  };
}
