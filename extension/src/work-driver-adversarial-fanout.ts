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

import { runAdversarialLoop } from "./adversarial.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import {
  classifyAdversarialOutcome,
  isTransientAdversarialOutcome,
  mergeFreshOutcomes,
  reentryPassBatchSpan,
  roundsRecords,
} from "./work-driver-adversarial-reentry.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { fetchDiff } from "./work-driver-diff.ts";
import {
  jitteredMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/** #486 — the driver's per-workstream adversarial retry budget. Matches the #308 router's TRANSIENT_MAX_RETRIES shape (2 retries = up to 3 total attempts). */
export const ADVERSARIAL_PER_WS_MAX_RETRIES = 2;

export type AdversarialRoundStatus =
  | "CRITICAL_ISSUES_FOUND"
  | "ISSUES_FOUND"
  | "MINOR_OBSERVATIONS"
  | "APPROVED";

export interface AdversarialRoundRecord {
  round: number;
  status: AdversarialRoundStatus;
  verdictParsed: boolean;
}

export interface AdversarialOutcome {
  id: string;
  ok: boolean;
  /** Reviews this workstream actually executed. */
  rounds: number;
  /** #485 — per-round verdict records, persisted verbatim. */
  records: AdversarialRoundRecord[];
  /** #298 — the loop died on infrastructure: no verdict exists. */
  infra: boolean;
  /** The loop threw before any review ran. */
  threw: boolean;
  /** #286 — empty diff, loop skipped (counts as a pass). */
  skipped: boolean;
  /** #486 — a prior run's infra-failure outcome for this workstream. */
  priorInfra: boolean;
  /** #486 — a prior run's VERDICT outcome (approved / rejected / skipped-empty-diff). Final and NOT re-run on re-entry; the event loop below re-emits the prior verdict from this record so the log stays complete after the splice replaces the prior pass's batch. */
  priorVerdict?: "approved" | "rejected" | "skipped-empty-diff";
  rejectionText?: string;
  /** Non-blocking findings outstanding when this workstream passed. */
  passFindings?: string;
  errorTail?: string;
  completionEvent?: WorkEvent;
  failureEvent?: WorkEvent;
  branchEvent?: WorkEvent;
}

/**
 * Fan the adversarial loop out across the named workstreams, applying the
 * #486 in-step per-workstream infra retry, and return the deterministic
 * per-workstream event batch. Re-entry (the previous fan-out already
 * recorded NO-VERDICT outcomes in `state.eventLog`): only the infra-failed
 * workstreams re-run, while their per-workstream budget holds. When nothing
 * left is retryable, returns `parked: true` — the caller appends the
 * `adversarial-infra-failure` cap-hit.
 */
export async function fanOutAdversarial(
  ctx: DriverContext,
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
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "adversarial" },
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
  const runOne = async (id: string): Promise<AdversarialOutcome> => {
    const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
    const label = ids.length > 1 ? `adversarial[${id}]` : "adversarial_loop";
    const startedAt = Date.now();
    const orchestratorJobId = makeRunId();
    // Per-workstream diff: a single `git diff HEAD` from this worktree —
    // exactly what ONE developer wrote. The cross-workstream merge happens
    // later in commit-pr; this gate judges each workstream independently.
    const diff = await fetchDiff(cwd);

    // #286 — empty-diff short-circuit (a full reviewer spawn on an empty
    // diff is pure waste; lens review has had this guard since PR6).
    const emptySkipDisabled = process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP === "0";
    if (!emptySkipDisabled && !diff.trim()) {
      trace(`work-driver: adversarial[${id}] skipped — empty diff`);
      return {
        id,
        ok: true,
        rounds: 0,
        records: [],
        infra: false,
        threw: false,
        skipped: true,
        priorInfra: priorOutcomes.get(id) === "infra-failure",
        completionEvent: {
          kind: "adversarial-skipped-empty-diff",
          at: Date.now(),
          workstreamId: id,
        },
        branchEvent:
          ids.length > 1
            ? {
                kind: "branch-completed",
                step: "adversarial",
                workstreamId: id,
                ok: true,
                ms: Date.now() - startedAt,
                at: Date.now(),
              }
            : undefined,
      };
    }

    const loopFn = ctx.adversarialLoopFn ?? runAdversarialLoop;
    let result: DispatchResult;
    try {
      result = await loopFn(
        {
          diff,
          context:
            ids.length > 1
              ? `/work issue #${ctx.issue}: gating diff for workstream "${id}" before commit (Step 5).`
              : `/work issue #${ctx.issue}: gating diff before commit (Step 5).`,
          workCwd: cwd,
          // Re-read before each round. Without this, rounds 2+ are prompted
          // with the pre-fix diff and the reviewer has to notice for itself
          // that its earlier objections were already addressed.
          getDiff: () => fetchDiff(cwd),
          // #278 — the reviewer judges the diff against what was ASKED FOR,
          // not just against generic code quality. Absent on cycles resumed
          // from older state files, which degrade to the previous behaviour.
          issueBody: state.pipelineState.issueBodyArtifact,
        },
        // No AbortController plumbing in v1 — spawn-level timeouts
        // in spawn.ts (per-role) bound the work.
        new AbortController().signal,
        orchestratorJobId,
      );
    } catch (err) {
      const errMsg = (err as Error).message?.slice(-200);
      return {
        id,
        ok: false,
        rounds: 0,
        records: [],
        infra: false,
        threw: true,
        skipped: false,
        priorInfra: priorOutcomes.get(id) === "infra-failure",
        rejectionText: `adversarial loop threw: ${errMsg}`,
        errorTail: errMsg,
        failureEvent: {
          kind: "dispatch-failed",
          step: "adversarial",
          role: "adversarial-loop",
          jobId: orchestratorJobId,
          label,
          ms: Date.now() - startedAt,
          at: Date.now(),
          errorTail: errMsg,
        },
        branchEvent:
          ids.length > 1
            ? {
                kind: "branch-completed",
                step: "adversarial",
                workstreamId: id,
                ok: false,
                ms: Date.now() - startedAt,
                error: errMsg,
                at: Date.now(),
              }
            : undefined,
      };
    }

    const completionEvent = await buildCompletionEvent(
      ctx,
      "adversarial",
      "adversarial-loop",
      label,
      // #298 — a REJECTED verdict is a COMPLETED review, not a dispatch
      // failure (pre-#298 exitCode=1 recorded it as dispatch-failed with
      // the escalation menu as errorTail).
      result.loopOutcome === "rejected" ? { ...result, ok: true, exitCode: 0 } : result,
    );
    const ok = result.ok && !result.errorStop;
    const records = roundsRecords(result);
    // #485 — rounds are data: the loop's own count when it carried one,
    // else the count the per-round records describe.
    const rounds = result.roundsExecuted ?? records.length;
    return {
      id,
      ok,
      rounds,
      records,
      infra: !ok && result.loopOutcome === "infra-failure",
      threw: false,
      skipped: false,
      priorInfra: priorOutcomes.get(id) === "infra-failure",
      rejectionText: ok ? undefined : result.text,
      // A pass that carried unresolved findings says so in its headline.
      passFindings: ok && result.text?.includes("PASSED WITH FINDINGS") ? result.text : undefined,
      errorTail: result.errorStop?.message ?? undefined,
      completionEvent,
      branchEvent:
        ids.length > 1
          ? {
              kind: "branch-completed",
              step: "adversarial",
              workstreamId: id,
              ok,
              ms: Date.now() - startedAt,
              at: Date.now(),
            }
          : undefined,
    };
  };

  const isTransient = (o: AdversarialOutcome): boolean => isTransientAdversarialOutcome(o);
  const classify = (o: AdversarialOutcome) => classifyAdversarialOutcome(o);

  // #486 — workstreams that produced a VERDICT (approved / rejected /
  // skipped-empty-diff) on the prior pass are final and NOT re-run. Their
  // per-workstream events are re-emitted from this prior-outcome record
  // (see the `outcomes` seed below), so the log stays complete after the
  // splice replaces the prior pass's batch.
  const survivorOutcomes: AdversarialOutcome[] = priorHadInfraFailure
    ? ids
        .filter((id) => {
          const prev = priorOutcomes.get(id);
          return prev === "approved" || prev === "rejected" || prev === "skipped-empty-diff";
        })
        .map((id) => {
          const prev = priorOutcomes.get(id) ?? "approved";
          return {
            id,
            ok: prev === "approved" || prev === "skipped-empty-diff",
            rounds: 0,
            records: [],
            infra: false,
            threw: false,
            skipped: prev === "skipped-empty-diff",
            priorInfra: false,
            priorVerdict: prev as "approved" | "rejected" | "skipped-empty-diff",
          };
        })
    : [];
  // #486 — the workstreams that run on THIS pass. First entry: everything.
  // Re-entry (the previous fan-out recorded a NO-VERDICT outcome): only the
  // infra-failed ones re-run while their per-workstream budget holds — a
  // permanent failure therefore stops the retry loop rather than re-running
  // siblings forever, and their preserved outcomes keep the aggregate
  // honest.
  let toRun = priorHadInfraFailure
    ? ids.filter((id) => {
        const prev = priorOutcomes.get(id);
        return (
          (prev === "infra-failure" || prev === "dispatch-failed") &&
          (localRetries[id] ?? 0) < ADVERSARIAL_PER_WS_MAX_RETRIES
        );
      })
    : [...ids];
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
  //  - `(localRetries[o.id] ?? 0) >= MAX || !isTransient(o)` — the budget
  //    is exhausted OR the failure is not retryable in-step at all
  //    (quota window, spend cap, self-kill — the taxonomy says
  //    shouldRetry=false, so no in-step retry is spent and the budget
  //    stays at 0 while the failure is still permanent).
  //  - `!priorHadInfraFailure` — re-entry permanent failures already park
  //    through the dedicated `parked` / re-entry branches; `parkedInfra`
  //    must not double-fire.
  //  - N>1 only: the N=1 first pass leaves the dispatch-failed tail for
  //    the step-level router's RETRY_ONCE path (the #298 contract); the
  //    router's re-entry is what parks with the named cap.
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
    return { next, outcomes: [], parked: true, parkedInfra: false };
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
    const waitMs = transientRetryEnabled()
      ? Math.max(
          0,
          ...candidates.map((o) =>
            jitteredMs(
              transientRetryBackoffMs() * ((localRetries[o.id] ?? 0) + 1),
              classify(o).waitMs ?? 0,
            ),
          ),
        )
      : 0;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    const budget: Record<string, number> = { ...localRetries };
    for (const o of candidates) {
      const incremented = (localRetries[o.id] ?? 0) + 1;
      budget[o.id] = incremented;
      localRetries[o.id] = incremented;
    }
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, adversarialTransientRetries: budget },
    };
    trace(
      `work-driver: adversarial per-workstream infra retry: ${candidates.map((o) => o.id).join(", ")}` +
        ` (waited ${waitMs}ms)`,
    );
    toRun = candidates.map((o) => o.id);
  }

  // Append per-workstream events in deterministic order: dispatch-completed
  // / dispatch-failed, the per-round verdict records (#485), the
  // per-workstream outcome (#486), then branch-completed for N>1. On
  // re-entry the prior pass's SURVIVOR outcomes (approved / rejected /
  // skipped) are re-emitted here from their prior-outcome records (no
  // completionEvent / failureEvent / records — the events are synthetic,
  // carrying the prior verdict and `roundsExecuted: 0`), so the log stays
  // complete after the splice. The whole batch is spliced at `passStart`
  // — the previous pass's records' position on re-entry — so the fresh
  // records replace them and each workstream's rounds appear exactly once
  // (R1). The previous pass's stale records are dropped: a recovered
  // workstream's stale failure outcome must not sit side-by-side with its
  // fresh APPROVED outcome (W1).
  const events: WorkEvent[] = [];
  for (const o of outcomes) {
    if (o.completionEvent) events.push(o.completionEvent);
    if (o.failureEvent) events.push(o.failureEvent);
    const recordsAt = Date.now();
    for (const r of o.records) {
      events.push({
        kind: "adversarial-round",
        at: recordsAt,
        workstreamId: ids.length > 1 ? o.id : undefined,
        round: r.round,
        status: r.status,
        verdictParsed: r.verdictParsed,
      });
    }
    if (ids.length > 1) {
      const outcome = o.priorVerdict
        ? (o.priorVerdict as "approved" | "rejected" | "skipped-empty-diff")
        : o.skipped
          ? ("skipped-empty-diff" as const)
          : o.threw
            ? ("dispatch-failed" as const)
            : o.infra
              ? ("infra-failure" as const)
              : o.ok
                ? ("approved" as const)
                : ("rejected" as const);
      events.push({
        kind: "adversarial-workstream-outcome",
        at: Date.now(),
        workstreamId: o.id,
        outcome,
        roundsExecuted: o.rounds,
        ...(o.errorTail && (o.infra || o.threw) ? { errorTail: o.errorTail } : {}),
      });
    }
    if (o.branchEvent) events.push(o.branchEvent);
  }
  // #485/#486 — true splice: the fresh batch REPLACES the previous pass's
  // batch on re-entry (see `priorBatchSpan` above). On a first pass
  // `priorBatchSpan` is null and `passStart` is the end of the log, so this
  // degenerates to an append.
  const passEnd = priorBatchSpan ? priorBatchSpan[1] : passStart;
  next = {
    ...next,
    eventLog: [...next.eventLog.slice(0, passStart), ...events, ...next.eventLog.slice(passEnd)],
  };

  if (ids.length > 1) {
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
  return {
    next,
    outcomes,
    parked: false,
    parkedInfra: !priorHadInfraFailure && ids.length > 1 && outcomes.some(exhaustedNoVerdict),
  };
}
