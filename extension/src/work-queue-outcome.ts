/**
 * work-queue-outcome — #1101: what a finished `/work` group becomes, and the
 * single point at which it stops holding anything back.
 *
 * The queue's worker loop decides *when* a group may run. This module decides
 * *what it turned into* — merged, refused, systemic halt, parked — and owns
 * the one operation the whole scheduler depends on: `finishGroup`, which
 * releases a group's claim and its ordering edge in one synchronous step.
 *
 * That operation is why this is a module and not three lines in a `finally`
 * beside `runGroup`. A group occupies three states and only the queue knows
 * them: in flight (holds an overlap claim), settled (releases the ordering
 * wait), resolved (can never be re-dispatched). Writing them in the wrong
 * order — or writing one without the entry that explains it — is what made a
 * dependent read "my dependency can never merge" about a cycle that was still
 * running, and what made an overlap read "safe to run alongside" in the window
 * after the cycle stopped and before its outcome was read. Both are ordering
 * bugs, and both are invisible unless the writes live in one place.
 *
 * Split from `work-queue-worker.ts` for AGENTS.md §12's 500-line cap; the
 * worker keeps the claim loop, this keeps the reporting.
 */

import { trace } from "./trace.ts";
import { notify } from "./work-notify.ts";
import { type QueueWaitCap, humanActionFor, waitCapFor } from "./work-queue-cap.ts";
import { parkReason } from "./work-queue-park-reason.ts";
import type { BlockReason } from "./work-queue-scheduler.ts";
import type { GroupOutcome, IssueGroup } from "./work-queue-types.ts";
import { dropDeferred } from "./work-queue-waitlist.ts";
import type { WorkerState } from "./work-queue-worker.ts";

/**
 * The single point at which a group stops holding anything back.
 *
 * Reached exactly once per dispatched group, after its entry has been written.
 * Two marks and a wake, in one synchronous step: `inFlight` releases the
 * overlap claim, `settled` releases the ordering wait, and `wake()` is what
 * stops either release from being discovered on a poll interval.
 *
 * The ordering of the marks against the ENTRY is the whole reason this is a
 * function and not three lines in a `finally`. A dependency that is `settled`
 * but not yet `merged` reads as "can never merge, park the dependent"; a
 * dependency that has left `inFlight` but is not yet `settled` reads as "safe
 * to run alongside". Writing the entry first and the marks last is what makes
 * both of those reads true.
 */
export function finishGroup(state: WorkerState, id: string): void {
  state.inFlight.delete(id);
  state.settled.add(id);
  // The group has now told the queue what it became. That is what separates it
  // from a group that only ever WAITED, and it is what `drainDeferred` reads
  // before it will re-dispatch anything — an entry in the map is not enough,
  // because a group the drain is running has no entry yet either.
  state.resolved.add(id);
  // Out of the wait list last, once the outcome is on the record: while a
  // group was in this list it remained visible to the scheduler as somebody
  // else's business, which is exactly what a running group must still be.
  dropDeferred(state, id);
  state.wake();
}

/** Record the driver-throw halt. Reached from both the scan and the wake path. */
export function recordCrash(state: WorkerState, gi: number, g: IssueGroup, threw: Error): void {
  // A driver throw is an unknown-shape failure: we cannot tell whether it
  // left the repo in a state the next group depends on.
  state.outcomeOf.set(g.id, "halted");
  state.halted = true;
  const crashAction = `inspect .pi/work-state/${g.issues[0]}.json (or /work-status ${g.issues[0]}) — the driver threw, so this is a bug worth filing`;
  state.entries.set(gi, {
    groupId: g.id,
    issues: g.issues,
    outcome: "halted",
    reason: `driver crashed: ${threw.message?.slice(0, 200)}`,
    humanAction: crashAction,
  });
  void notify({
    kind: "crashed",
    issues: g.issues,
    reason: threw.message?.slice(0, 160) ?? "driver threw",
    action: crashAction,
  });
  // The entry is on the record, so this group now holds nothing back — and
  // sibling workers may be asleep waiting to learn that.
  finishGroup(state, g.id);
}

/**
 * Classify a finished group: merged, refused, systemic halt, or park.
 *
 * Split from the claim body so both the scan path and the wake path run the
 * identical decision. Returns after recording; `state.halted` is what the
 * caller checks to stop.
 */
export async function classify(
  state: WorkerState,
  gi: number,
  g: IssueGroup,
  outcome: GroupOutcome | undefined,
): Promise<void> {
  // Reached through the caller's `g.issues[0] === undefined` guard, so the
  // primary exists; the cast is only to keep the index type's `undefined` from
  // every `humanActionFor(reason, …)` / `read(…, primary)` call below.
  const primary = g.issues[0] as number;
  // The driver refused before running. Whatever state file is on disk belongs
  // to the cycle that is ACTUALLY running, so reading it here would report a
  // live cycle's mid-flight cap as this group's park reason — and the park
  // advice is `--restart`, which would race fresh jobs against live ones.
  if (outcome?.started === false) {
    state.outcomeOf.set(g.id, "not-started");
    state.entries.set(gi, {
      groupId: g.id,
      issues: g.issues,
      outcome: "not-started",
      reason: outcome.reason ?? "the driver refused to start this cycle",
      humanAction: `nothing to do here — ${outcome.reason ?? "this cycle never started"}. Check /work-status ${primary} for the cycle that owns it.`,
    });
    finishGroup(state, g.id);
    return;
  }

  const st = await state.read(state.repoRoot, primary).catch(() => undefined);
  if (st?.pipelineState.status === "merged") {
    // `merged` before `settled`: a dependent deciding between "wait" and
    // "park" reads both sets, and the merge has to be visible no later than
    // the settle that would otherwise release it.
    state.merged.add(g.id);
    state.outcomeOf.set(g.id, "merged");
    state.entries.set(gi, { groupId: g.id, issues: g.issues, outcome: "merged" });
    // A merge is the event every ordering waiter has been waiting for.
    finishGroup(state, g.id);
    return;
  }

  const { reason, failedStep } = parkReason(st);
  const systemic = state.isSystemic(st);
  if (systemic.systemic || state.haltOnFailure()) {
    state.halted = true;
    const why = systemic.reason ?? reason;
    state.outcomeOf.set(g.id, "halted");
    state.entries.set(gi, {
      groupId: g.id,
      issues: g.issues,
      outcome: "halted",
      reason: why,
      failedStep,
      humanAction: humanActionFor(reason, primary),
    });
    void notify({
      kind: "halted",
      issues: g.issues,
      reason: why,
      action: humanActionFor(reason, primary),
    });
    finishGroup(state, g.id);
    return;
  }

  trace(`work-queue: parking ${g.id} (${reason}) and continuing`);
  state.outcomeOf.set(g.id, "parked");
  state.entries.set(gi, {
    groupId: g.id,
    issues: g.issues,
    outcome: "parked",
    reason,
    failedStep,
    humanAction: humanActionFor(reason, primary),
  });
  // #388 — one notification per parked group, carrying the action rather than
  // the event. A merged group is never notified: nothing is asked of the
  // operator. #380's hold is not a failure — the work is done, only the merge
  // is waiting.
  void notify({
    kind: /awaiting-human-merge/.test(reason) ? "awaiting-merge" : "parked",
    issues: g.issues,
    reason,
    action: humanActionFor(reason, primary),
  });
  finishGroup(state, g.id);
}

/**
 * The wait did not clear inside its bound: record the park the operator sees
 * and move on. The group stays UNCLAIMED, so `finish()` lists it among the
 * groups the queue never started — a capped wait must not be reported as a
 * cycle that ran and failed.
 */
export function capOutWait(
  state: WorkerState,
  gi: number,
  g: IssueGroup,
  reason: Exclude<BlockReason, null>,
): void {
  const { cap, detail } = waitCapFor(reason);
  state.deferralStart.delete(g.id);
  recordQueuePark(state, gi, g, cap, detail);
  trace(`work-queue: ${g.id} parked at the wait cap (${cap})`);
}

/**
 * The one place a queue-level park is written, so the two shapes that never
 * dispatched a cycle (a dependency that did not merge, a wait that outlasted
 * its bound) cannot drift into two different reason formats — the renderers
 * and `humanActionFor` both read that string.
 */
export function recordQueuePark(
  state: WorkerState,
  gi: number,
  g: IssueGroup,
  cap: QueueWaitCap | "dependency-parked",
  detail: string,
): void {
  const issues = g.issues.join(", #");
  const rerun = `/work ${g.issues.join(" ")} --restart`;
  // The reason string is what `humanActionFor` and the renderers pattern on.
  // #1101's contract names it `dependency-parked:#N` — with the colon — and
  // `humanActionFor` reads it back with `/cap dependency-parked:(\S+)/`, so
  // the separator has to be `:` for every cap. The old shape wrote a space for
  // this one case, and the dependent's action fell through to "inspect a diff
  // that does not exist" while the queue-side text happened to still match a
  // looser test.
  const reason = `cap ${cap}:${detail}`;
  // One entry per group, whatever route reached it. Both the scan and the wake
  // path can reach a park for the same group (a cap racing a settle), and two
  // entries for one group would be counted twice by the summary and printed
  // twice to the operator.
  if (state.entries.has(gi)) return;
  // A queue-level park is an outcome too. Without this the group stayed in
  // `settled`-but-unresolved, so `stillWaiting` kept a waiter alive over a
  // group that had already been reported — and a group that had only ever
  // waited looked identical to one that had finished, which is the
  // distinction `drainDeferred` needs before it will re-dispatch anything.
  state.resolved.add(g.id);
  state.outcomeOf.set(g.id, "parked");
  state.entries.set(gi, {
    groupId: g.id,
    issues: g.issues,
    outcome: "parked",
    reason,
    humanAction:
      cap === "dependency-parked"
        ? `get #${issues}'s dependency ${detail} merged (or drop the declared dependency from its body), then re-run \`${rerun}\` — this group never started, so nothing was built`
        : `inspect .pi/work-state/${g.issues[0]}.json and re-run \`${rerun}\` — this group never started, so nothing was built`,
  });
}
