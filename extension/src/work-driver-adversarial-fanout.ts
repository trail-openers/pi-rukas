/**
 * work-driver-adversarial-fanout — the per-workstream fan-out of the
 * adversarial gate (#486), extracted from work-driver-adversarial.ts
 * (AGENTS.md §12 file-size limit). Leaf module — no dependency on any
 * work-driver-<step>.ts handler. #486: a transient infrastructure failure
 * in ONE workstream's loop is retried in-step (per-workstream budget,
 * taxonomy backoff) while the other workstreams' approved verdicts are
 * preserved in the event log either way. A permanent failure parks with
 * cap `adversarial-infra-failure` instead of being rendered as a review
 * rejection.
 */

import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { isDiffUnreadableOutcome } from "./work-driver-adversarial-diff-cap.ts";
import { withSpentLadderBudget } from "./work-driver-adversarial-fanout-budget.ts";
import { retryLadderKillCause } from "./work-driver-adversarial-fanout-capkill.ts";
import { outcomeEvents } from "./work-driver-adversarial-fanout-events.ts";
import { runAdversarialWorkstream } from "./work-driver-adversarial-fanout-run.ts";
import { settledMarkerIds, splicePassBatch } from "./work-driver-adversarial-fanout-splice.ts";
import { reviewTrack, workstreamsToReview } from "./work-driver-adversarial-fix.ts";
import {
  classifyAdversarialOutcome,
  isTransientAdversarialOutcome,
  mergeFreshOutcomes,
  reentryPassBatchSpan,
} from "./work-driver-adversarial-reentry.ts";
import { survivorsOf } from "./work-driver-adversarial-survivors.ts";
import {
  ADVERSARIAL_PER_WS_MAX_RETRIES,
  type AdversarialOutcome,
} from "./work-driver-adversarial-types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import {
  jitteredMs,
  providerRetryWaitMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import { beginDispatch, clearDispatch, mintJobId } from "./work-driver-resume.ts";
import { armStepNotice } from "./work-driver-step-notice.ts";
import { providerSleep } from "./work-driver-step-router.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * #543 — the cap-kill fields of an AdversarialOutcome: the killCause
 * (loop / token-budget) + its structured trigger evidence, threaded from
 * the inner spawn's DispatchResult. Empty when the result carries no cap
 * kill. Split from runOne's return (AGENTS.md §12 file-size limit).
 */

export async function fanOutAdversarial(
  ctx: CycleContext,
  state: WorkState,
  ids: string[],
  priorOutcomes: Map<string, string>,
  priorHadInfraFailure: boolean,
  priorBatchSpan: [number, number] | null,
): Promise<{
  next: WorkState;
  outcomes: AdversarialOutcome[];
  /** No dispatch ran on this pass (budget exhausted on re-entry). */
  parked: boolean;
  /** #486 — a first-pass workstream exhausted its per-workstream budget and never produced a verdict. The caller parks with the distinct infra cap instead of rendering the shortfall as a rejection. */
  parkedInfra: boolean;
}> {
  const retries = state.pipelineState.adversarialTransientRetries ?? {};
  // #486 — mutable retry map seeded from the prior run's budget so the
  // candidates filter below observes in-step increments (a permanently
  // failing workstream must stop being a candidate after its budget runs
  // out, rather than being re-selected forever from the immutable
  // `retries` snapshot). Re-entry preserves the prior budget: seeding from
  // `retries` (which a resumed cycle reads from its state file) keeps the
  // bound intact across restarts.
  const localRetries: Record<string, number> = { ...retries };
  // #799 F2 — the fan-out's wall-clock span, keyed on the STEP (not any
  // child), matching the develop-path notice. Fires once, above the healthy
  // band; a cancel is returned and invoked on every exit below.
  const stepStartedAt = Date.now();
  const cancelStepNotice = armStepNotice({
    state,
    step: "adversarial",
    startedAt: stepStartedAt,
  });
  // #1137 — the workstream map supplies the sibling list and the N>1 test
  // only; the review set is `ids`. Without a map, N>1 is the id count.
  const wsMap = state.pipelineState.workstreams;
  const multi = (wsMap ? Object.keys(wsMap).length : ids.length) > 1;
  const endStep = (
    final: WorkState,
    rest: { outcomes: AdversarialOutcome[]; parked: boolean; parkedInfra: boolean },
  ) => {
    cancelStepNotice();
    return { next: withSpentBudget(final), ...rest };
  };
  // #485/#486 — on re-entry, the previous pass's per-workstream records are
  // REPLACED where the re-run workstreams produced a fresh batch (R1): the
  // fresh batch is spliced over the previous batch's span (below), so each
  // workstream's rounds and outcome appear exactly once, and a recovered
  // workstream's stale failure outcome does not sit side-by-side with its
  // fresh APPROVED outcome (W1). The stale failure stays auditable through
  // the preserved dispatch event and the per-workstream outcome's
  // errorTail. The span is captured by the caller on the ORIGINAL event
  // log — BEFORE this pass's events are appended.
  const passStart = priorBatchSpan ? priorBatchSpan[0] : state.eventLog.length;
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "adversarial" },
  };
  // #485/#486 — the per-workstream pass (diff read + reviewer loop) lives in
  // work-driver-adversarial-fanout-run.ts (§12 size). A failed read carries its
  // own reason on the outcome and on the cap's evidence, so nothing is threaded
  // through a mutable pipeline-state field (which sibling won the race used to
  // decide what the handoff said).
  //
  // #1863 — WRITE-AHEAD, one marker per workstream pass (develop's granularity:
  // resume granularity is the step, a half-finished fan-out re-enters wholesale).
  // Before this the family wrote ahead ONLY for the fix dispatch, so a cycle whose
  // round review was killed had nothing on disk for its whole review window.
  //
  // ONE mutable log for the whole fan-out, and ONE chained writer for it.
  // `next` was a local rebuilt at each step, but N workstreams now write ahead
  // CONCURRENTLY (`Promise.all`), and each one's write must see its siblings' —
  // a snapshot taken at pass start would drop a sibling's `dispatch-started`
  // and its in-flight id. So every write goes through `writeThrough`, which
  // reads the current log, runs `beginDispatch` / `clearDispatch` against it
  // and installs the result; the chain makes that read-modify-write atomic, so
  // two siblings starting in the same tick cannot each clobber the other's
  // marker, and a clear can never be lost under another workstream's write.
  //
  // The MARKER ITSELF is the shared helper: `beginDispatch` / `clearDispatch`
  // (work-driver-resume.ts), the same pair every other write-ahead in the
  // driver routes through. The hand-rolled `markDispatchStarted` + bare
  // `persistCycle` this file used to carry duplicated the helper's body and
  // dropped one thing it does: a persist failure REJECTS, and the caller does
  // not dispatch (see `runSingleDispatch` / `beginDispatch` callers).
  //
  // The id is minted HERE and handed to the child as its `runId`, so the
  // write-ahead marker, the child's transcript and the completion event are one
  // identity (#1789's rule, which `runSingleDispatch` already follows).
  let log: WorkState = next;
  let writeChain: Promise<unknown> = Promise.resolve();
  // #1863 — the marker ids this fan-out minted, in order. `settledMarkerIds`
  // turns them into the set the splice keys on.
  const passMarkers: string[] = [];
  // #1863 — #486's per-workstream ladder budget must survive this pass in the
  // state the step RETURNS, not only in the one every retry branch
  // `persistCycle`s — see work-driver-adversarial-fanout-budget.ts for why both
  // publishers merge rather than replace. Applied to every `next` this function
  // produces, so the RETRY_ONCE re-entry seeds from the spent budget (#357 T8).
  const withSpentBudget = (s: WorkState): WorkState => withSpentLadderBudget(s, localRetries);
  const writeThrough = (fn: (s: WorkState) => Promise<WorkState>): Promise<WorkState> => {
    const step = writeChain.then(async () => {
      log = await fn(log);
      // The step resolves with the log AS INSTALLED, which is what makes the
      // read-modify-write atomic for the caller: it sees the log its own write
      // produced, siblings' writes and all.
      return log;
    });
    // A FAILED step must not poison the chain — a sibling's clear still has to
    // run — but the failure is not swallowed either: `step` is what the caller
    // awaits, and `runOne` turns it into a no-dispatch outcome.
    writeChain = step.catch(() => undefined);
    return step;
  };
  const writeAheadFor = (id: string): { jobId: string; label: string } => {
    const label = multi ? `adversarial[${id}]` : "adversarial_loop";
    // ONE minting per pass, handed to the leaf (see `RunOneArgs.writeAhead`) and
    // registered for the splice. A second `Date.now()` read makes a second
    // minting a different string, and then the marker, the dispatch events and
    // the outcome's `clearedJobId` no longer name one dispatch (#1863).
    return { jobId: mintJobId("adversarial", `${label}:${id}`, Date.now()), label };
  };
  // De-duplicated: a workstream the in-step retry re-ran registers one per attempt.
  const registerMarker = (jobId: string): void => {
    if (!passMarkers.includes(jobId)) passMarkers.push(jobId);
  };
  const writeAheadFailed = (id: string, label: string, jobId: string, e: unknown) => {
    const errMsg = (e as Error).message?.slice(-200);
    trace(
      `work-driver: adversarial[${id}] write-ahead persist FAILED — not dispatching a reviewer nobody recorded`,
    );
    return {
      id,
      ok: false,
      rounds: 0,
      records: [],
      // The driver's own write failed: a NO-VERDICT infrastructure failure,
      // never a rejection and never something the retry ladder re-spawns into
      // the same unreadable state file.
      infra: true,
      threw: true,
      skipped: false,
      priorInfra: priorOutcomes.get(id) === "infra-failure",
      rejectionText: `adversarial write-ahead failed: ${errMsg}`,
      errorTail: errMsg,
      // Never dispatched: excluded from the splice's marker set by
      // `settledMarkerIds`, so it absorbs no region and claims no dispatch.
      clearedJobId: jobId,
      markerWritten: false,
      failureEvent: {
        kind: "dispatch-failed",
        step: "adversarial",
        role: "adversarial-loop",
        jobId,
        label,
        ms: 0,
        at: Date.now(),
        errorTail: errMsg,
      } as const,
    } satisfies AdversarialOutcome;
  };
  const runOne = async (id: string): Promise<AdversarialOutcome> => {
    const wa = writeAheadFor(id);
    const startedAt = Date.now();
    let begunLog: WorkState;
    try {
      begunLog = await writeThrough(async (s) => {
        const b = await beginDispatch(
          ctx,
          s,
          "adversarial",
          "adversarial-loop",
          wa.label,
          startedAt,
          undefined,
          // The id this pass's dispatch events carry, and the id its `finally`
          // clears: ONE string, taken from the marker rather than minted again
          // (#1863 — see `writeAheadFor`).
          wa.jobId,
        );
        // #1863 — the marker's real id, from the helper that wrote it, is the id
        // the pass uses everywhere: `beginDispatch` mints its own when the
        // caller passes none, and two mintings a millisecond apart are two
        // strings. The leaf then stamps its dispatch events with one and the
        // marker carries the other, and the batch's marker no longer names the
        // dispatch it precedes.
        if (b.jobId !== wa.jobId) wa.jobId = b.jobId;
        registerMarker(b.jobId);
        return b.state;
      });
    } catch (e) {
      // The intent is what makes a killed review visible on resume. If it could
      // not be written, dispatching anyway would spend a reviewer whose death
      // nothing records — the exact cause B this step is about. So: no dispatch.
      return writeAheadFailed(id, wa.label, wa.jobId, e);
    }
    // #1863 — the marker's OWN log, not the shared one: every outcome below
    // carries the dispatch events the pass produced, so they must sit AFTER this
    // pass's `dispatch-started`, and the `finally` clears the id out of this
    // copy. The fan-out re-emits the outcome's events at the splice, and merges
    // the in-flight clears from every outcome's copy — reading the shared log
    // here would strand a sibling's dispatch events behind this workstream's.
    try {
      return await runAdversarialWorkstream(id, {
        ctx,
        // The state the write-ahead PERSISTED is the one the pass builds on.
        state: begunLog,
        multi,
        wsMap,
        priorOutcomes,
        writeAhead: wa,
      });
    } finally {
      // Cleared on EVERY exit, including a throw out of the loop: the step's
      // tail must be the dispatch event, never the `dispatch-started`. The
      // splice builds the batch from `log`, which this queued write installs,
      // so the clear is awaited before this pass resolves — no separate
      // boundary persist.
      await writeThrough(async (s) => clearDispatch(s, wa.jobId)).catch(() => undefined);
    }
  };

  const isTransient = (o: AdversarialOutcome): boolean =>
    // #1634 — the driver's own diff read is DETERMINISTIC: a re-run of a
    // missing worktree or a failing `git diff` says the same thing, so the
    // ladder would only buy waits. Park at once instead of spending the
    // per-workstream budget and a jittered sleep on it.
    !isDiffUnreadableOutcome(o) && isTransientAdversarialOutcome(o);
  const classify = (o: AdversarialOutcome) => classifyAdversarialOutcome(o);

  // #486 — workstreams that produced a VERDICT (approved / rejected /
  // skipped-empty-diff) on the prior pass are final and NOT re-run. Their
  // per-workstream events are re-emitted from this prior-outcome record
  // (see the `outcomes` seed below), so the log stays complete after the
  // splice replaces the prior pass's batch.
  // #486 — the workstreams that run on THIS pass. First entry: everything.
  // Re-entry (the previous fan-out recorded a NO-VERDICT outcome): only the
  // infra-failed ones re-run while their per-workstream budget holds — a
  // permanent failure therefore stops the retry loop rather than re-running
  // siblings forever, and their preserved outcomes keep the aggregate
  // honest.
  // #1114 — "everything" on a first entry means whatever still needs a review;
  // re-entry also re-runs a workstream whose fix pass was applied since its
  // routed review. The rest are survivors.
  const runSet = priorHadInfraFailure
    ? ids.filter((id) => {
        const prev = priorOutcomes.get(id);
        const retryableInfra =
          (prev === "infra-failure" || prev === "dispatch-failed") &&
          (localRetries[id] ?? 0) < ADVERSARIAL_PER_WS_MAX_RETRIES;
        // #1114 — a fix pass applied since its routed review still needs re-review.
        const fixedAwaitingReview =
          prev === "fix-requested" && reviewTrack(state.eventLog, id).needsReview;
        return retryableInfra || fixedAwaitingReview;
      })
    : workstreamsToReview(state, ids);
  // #486 — workstreams with a FINAL verdict on an earlier invocation are not
  // re-run, and their per-workstream events are re-emitted from the prior
  // record (see the `outcomes` seed below), so the log stays complete after
  // the splice. A single-workstream cycle keeps no per-workstream outcome
  // event, so its approval is recovered from the rounds it already ran.
  const survivorOutcomes = survivorsOf(state, ids, runSet, priorOutcomes);
  let toRun = [...runSet];
  // #486 — a first-pass workstream whose FINAL (merged) outcome has no
  // verdict and whose failure the in-step retry could not absorb is a
  // permanent infra shortfall. The step-level router does not retry
  // fan-outs (branches-converged declines when ANY workstream succeeded),
  // so for a first pass the per-workstream budget is the retry mechanism;
  // the predicate is the FINAL outcome (merged aggregate), not the budget:
  //  - `!o.ok` — no verdict in the final outcome. A workstream that
  //    exhausted its budget on a TRANSIENT failure and then recovered in
  //    step has a fresh APPROVED outcome and never matches — parking on
  //    the budget alone would fire the spurious `adversarial-infra-
  //    failure` cap-hit (W1). A budget check without an outcome check is
  //    the same bug class as T6: stale first-attempt state surviving
  //    into aggregation.
  //  - `o.infra || o.threw` — the final outcome is a NO-VERDICT failure
  //    (infrastructure death or a throw), never a genuine rejection.
  //  - `(localRetries[o.id] ?? 0) >= MAX || !isTransient(o)` — budget
  //    exhausted OR the failure is not retryable in-step (self-kill).
  //  - `!priorHadInfraFailure` — re-entry permanent failures already park
  //    through the dedicated `parked` / re-entry branches; `parkedInfra`
  //    must not double-fire.
  //  - N>1 only: N=1 leaves the dispatch-failed tail for the step-level
  //    router's RETRY_ONCE path (#298); its re-entry parks with the cap.
  const exhaustedNoVerdict = (o: AdversarialOutcome): boolean =>
    !o.ok &&
    (o.infra || o.threw) &&
    ((localRetries[o.id] ?? 0) >= ADVERSARIAL_PER_WS_MAX_RETRIES || !isTransient(o));
  if (priorHadInfraFailure && toRun.length === 0) {
    // #486 — every failing workstream already exhausted its budget.
    // Nothing left to retry: the caller parks with the distinct cap; the
    // preserved per-workstream outcomes are already in the event log.
    trace(
      "work-driver: adversarial per-workstream infra failure permanent — parking (no retryable workstreams)",
    );
    return endStep(next, { outcomes: [], parked: true, parkedInfra: false });
  }
  // #486 W1 — `outcomes` accumulates per-attempt history for this pass.
  // `mergeFreshOutcomes` returns the merged aggregate (one entry per
  // workstream in `ids` order, fresh outcome superseding stale
  // first-attempt entries). On re-entry the prior pass's SURVIVOR outcomes
  // (approved / rejected / skipped) are seeded up front: they are final
  // and not re-run, but their per-workstream events must be re-emitted in
  // `ids` order so the log stays complete after the splice replaces the
  // prior pass's batch.
  let outcomes: AdversarialOutcome[] = [...survivorOutcomes];

  for (;;) {
    const fresh = await Promise.all(toRun.map((id) => runOne(id)));
    outcomes = mergeFreshOutcomes(outcomes, fresh, ids);

    // #486 — a transient infra failure in ANY pass earns a bounded in-step
    // retry: the per-workstream budget (ADVERSARIAL_PER_WS_MAX_RETRIES)
    // bounds the total attempts, so a permanent failure terminates the loop
    // rather than spinning. Pre-#486 the budget was only visible on re-entry,
    // so a first-pass failure was terminal for the whole cycle even when a
    // single provider blip had discarded the approved siblings' work.
    const candidates = fresh.filter(
      (o) =>
        !o.ok &&
        !o.skipped &&
        isTransient(o) &&
        (localRetries[o.id] ?? 0) < ADVERSARIAL_PER_WS_MAX_RETRIES,
    );
    if (candidates.length === 0) break;

    // #486 — retry each failing workstream with the same backoff the
    // step-level router applies: provider-stated delay as floor, full
    // jitter, one shared wait so siblings that share a 429 clear together.
    // #1243 — a provider-class failure gets the minutes-floor ladder (the 5s
    // ladder re-spawns inside the same outage); the attempt index scales it and
    // the total stays bounded, so a fan-out cannot sleep past the incident.
    const waitMs = transientRetryEnabled()
      ? Math.max(
          0,
          ...candidates.map((o) =>
            jitteredMs(
              providerRetryWaitMs(
                classify(o),
                (localRetries[o.id] ?? 0) + 1,
                transientRetryBackoffMs() * ((localRetries[o.id] ?? 0) + 1),
              ),
              classify(o).waitMs ?? 0,
            ),
          ),
        )
      : 0;
    // #1243 — the SAME injectable seam the step router's provider ladder uses
    // (`providerSleep` in work-driver-step-router.ts), so the offline suite
    // records this wait instead of sleeping through it, and the abort signal
    // still ends it early in production. The seam's default IS `abortableSleep`,
    // so behaviour is unchanged in production; the difference is that the two
    // ladder sites can now be observed by one test seam rather than one being
    // hard-wired to the real timer.
    if (waitMs > 0) await providerSleep(waitMs, ctx.signal);
    const budget: Record<string, number> = { ...localRetries };
    for (const o of candidates) {
      const incremented = (localRetries[o.id] ?? 0) + 1;
      budget[o.id] = incremented;
      localRetries[o.id] = incremented;
    }
    // The ladder's own spend, merged into whatever `next` already carries
    // (`log`'s pipeline state survives the in-loop write-aheads).
    next = withSpentLadderBudget(next, budget);
    trace(
      `work-driver: adversarial per-workstream infra retry: ${candidates.map((o) => o.id).join(", ")}` +
        ` (waited ${waitMs}ms)`,
    );
    toRun = candidates.map((o) => o.id);
  }

  // The batch itself is built by outcomeEvents (work-driver-adversarial-fanout-events.ts).
  // #485/#486 — true splice: the fresh batch REPLACES the previous pass's
  // batch on re-entry (see `priorBatchSpan` above). On a first pass
  // `priorBatchSpan` is null and `passStart` is the end of the log, so this
  // degenerates to an append.
  //
  // #1863 — the batch is built on the log the write-aheads PRODUCED (`log`),
  // not on the `next` snapshot taken before any dispatch happened. Replacing
  // that snapshot would silently delete every `dispatch-started` this pass
  // wrote — which is what a crash-resume reads as "this step never started",
  // the exact cause B this issue is about.
  //
  // Two things survive the splice:
  //
  //  - a `dispatch-started` whose id is STILL in flight: a sibling still
  //    reviewing while another workstream's batch is spliced. Removing its
  //    marker would leave the id in `inFlightJobIds` with no backing event, so
  //    `classifyRunningState` could not see the crash and
  //    `detectInconsistencies` would call the file corrupt. An id already
  //    cleared is a finished pass's orphan (the crash-resume shape, which
  //    `clearForResume` deliberately keeps) and stays spliced away.
  //  - every outcome's `inFlightJobIds`, which its own `finally` cleared. The
  //    aggregate never saw those clears (each pass held its own copy), so
  //    without this merge a completed review would still look in-flight and the
  //    next invocation would resume a step that already finished.
  const events = outcomeEvents(outcomes, multi);
  const passEnd = priorBatchSpan ? priorBatchSpan[1] : passStart;
  // #1863 — the splice and its invariant live in the splice module: a step that
  // failed ends on its failure event, never on a write-ahead marker.
  const settledMarkers = settledMarkerIds(outcomes, passMarkers);
  next = {
    ...log,
    pipelineState: {
      ...log.pipelineState,
      inFlightJobIds: log.pipelineState.inFlightJobIds.filter(
        (id) => !outcomes.some((o) => o.clearedJobId === id),
      ),
    },
    eventLog: splicePassBatch(log, events, settledMarkers, passStart, passEnd),
  };

  if (multi) {
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "adversarial",
      verdicts: outcomes.map((o) => ({ id: o.id, ok: o.ok })),
      at: Date.now(),
    });
  }

  // #486 — computed over the FINAL per-workstream outcomes (the merged
  // aggregate), not the accumulated first-attempt history: a workstream
  // that exhausted its budget on a transient failure and then RECOVERED on
  // the in-step retry must not park (W1) — its final outcome is the fresh
  // APPROVED. Same bug class as T6: stale first-attempt state surviving
  // into aggregation.
  return endStep(next, {
    outcomes,
    parked: false,
    parkedInfra: !priorHadInfraFailure && multi && outcomes.some(exhaustedNoVerdict),
  });
}
