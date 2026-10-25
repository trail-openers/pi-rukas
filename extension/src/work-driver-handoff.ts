/** work-driver-handoff — Step 7g (handoff) handler. #674: worktree consolidation + forge post retry. */
import fs from "node:fs/promises";
import path from "node:path";
import { execp } from "./exec.ts";
import { drainSlowEvents } from "./slow-events.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { settleDraftPrAtHandoff } from "./work-driver-draft-pr.ts";
import { openDraftPrForCappedWork } from "./work-driver-handoff-capped-pr.ts";
import { handoffChannel } from "./work-driver-handoff-channel.ts";
import {
  handoffConsolidateWorktrees,
  lastConsolidatedEvent,
} from "./work-driver-handoff-consolidate-step.ts";
import { consolidationClaim } from "./work-driver-handoff-consolidation-claim.ts";
import {
  HOST_PARK_RECORD_BOUND_MS,
  boundedBestEffort,
  deliverHandoff,
  handoffDispatchFailed,
  parseHandoffCommentUrl,
  priorHandoffCommentUrl,
} from "./work-driver-handoff-deliver.ts";
import { handoffForge } from "./work-driver-handoff-forge.ts";
import { applyIssueLabelAndVerify, labelPrAfterBodyRefusal } from "./work-driver-handoff-labels.ts";
import { renderHandoffMarkdown } from "./work-driver-handoff-markdown.ts";
import { runHandoffOpsDispatch } from "./work-driver-handoff-ops.ts";
import {
  captureCommittedWork,
  declinedLabelSeed,
  makeHandoffEmittedEvent,
  parseHandoffOpsReply,
  verifyHandoffLabel,
} from "./work-driver-handoff-post.ts";
import { renderHandoffBody } from "./work-driver-handoff-render.ts";
import { captureWorktreeSnapshot } from "./work-driver-handoff-snapshot.ts";
import { terminaliseHandoff } from "./work-driver-handoff-terminal.ts";
import { recordHostPark } from "./work-driver-park-memory-host.ts";
import {
  REPEAT_PARK_REFUSAL_COUNT,
  readParkMemory,
  recordPark,
} from "./work-driver-park-memory.ts";
import { releaseClaim } from "./work-driver-path-claims.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { runWorktreeTeardown } from "./work-driver-worktree-sweep.ts";
import { foldWriteFenceCount } from "./work-driver-write-fence.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

// #1263 test seam — module-level handoff-step throw injection (offline tests
// only), called in runHandoff just before the terminal-status write. A
// closure rather than an env var: env seams leak into hostile environments.
let handoffThrowForTest: (() => void) | undefined;
export function setHandoffThrowForTestForTest(fn: (() => void) | undefined): void {
  handoffThrowForTest = fn;
}

// §12 split — the bounded best-effort await and its bound moved to
// `work-driver-handoff-deliver.ts`; re-exported so no consumer's path changes.
export { HOST_PARK_RECORD_BOUND_MS, boundedBestEffort } from "./work-driver-handoff-deliver.ts";

// #775 prep — captureWorktreeSnapshot moved to work-driver-handoff-snapshot.ts
// (§12 file-size split); re-exported so no consumer's import path changes.
export { captureWorktreeSnapshot } from "./work-driver-handoff-snapshot.ts";
// §12 split — the delivery half (comment/label verification, the in-process
// forge fallback and the pure URL helpers) moved to
// work-driver-handoff-deliver.ts; re-exported so no consumer's path changes.
export {
  handoffDispatchFailed,
  parseHandoffCommentUrl,
  priorHandoffCommentUrl,
} from "./work-driver-handoff-deliver.ts";
export { handoffForge } from "./work-driver-handoff-forge.ts";
export function handoffDispatchTimeoutMs(): number {
  const env = Number(process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 8 * 60_000;
}
/** Step 7g — Emit cap-hit handoff artifact. Dispatches @ops to: - render the handoff body (referencing the work-state file) - post `gh pr comment` (or `gh issue comment` if no PR yet) - apply `needs-human-attention` label After the dispatch, set status=handoff to terminate the loop. The in-process fallback (`!commentUrl || !labelApplied`) now routes its gh calls through the forge adapter — the ops child's prompt still names raw `gh` (it is a prose contract with the agent, not an exec seam), but the driver's own mechanical calls are forge-aware. */
export async function runHandoff(
  ctx: CycleContext,
  stateIn: WorkState,
  now: number,
): Promise<WorkState> {
  return handoff(ctx, stateIn, now);
}

async function handoff(ctx: CycleContext, stateIn: WorkState, now: number): Promise<WorkState> {
  // #1655 — the handoff body reports the refusal total. This step is not routed
  // through routeStepOutcome, so the total is folded here, before the body is rendered.
  const state = await foldWriteFenceCount(ctx, stateIn);
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "handoff" },
  };
  next = appendEvent(next, { kind: "step-started", step: "handoff", at: now });
  // #674 items 1+2 — consolidate the parked work BEFORE the snapshot, so
  // the snapshot (and the recovery printed from it) describes the world the
  // operator is actually left in. When a cycle parks at develop with
  // committed work on detached-HEAD worktrees, moving it onto the feature
  // branch here makes the branch genuinely contain the work and the printed
  // `git status` / `push` instructions true; a consolidation failure
  // degrades to the accurate per-worktree recovery (the worktrees are then
  // retained by the teardown below). Must never throw — the handoff
  // completes either way.
  const consolidated =
    process.env.PI_ENSEMBLE_HANDOFF_CONSOLIDATE === "0"
      ? {}
      : await handoffConsolidateWorktrees(ctx, state);
  if (consolidated.event) {
    next = appendEvent(next, consolidated.event);
  }
  // #1402 — an adversarial-loop cap skipped commit-pr: push the branch and
  // open a draft PR carrying the findings, so the work is reachable. Before
  // the snapshot, so the handoff reports the branch as pushed.
  next = await openDraftPrForCappedWork(ctx, next);
  // PR5: capture the worktree snapshot FIRST so handoff surfaces (in-chat
  // sendUserMessage, GitHub body, /work-status terminal) can answer
  // WHERE the work is without re-shelling git. Snapshot persists into
  // pipelineState even if subsequent steps in runHandoff fail.
  const snap = await captureWorktreeSnapshot(
    ctx.repoRoot,
    state.pipelineState.branchName,
    state.pipelineState.worktrees,
    state.pipelineState.baseSha,
  );
  // #674 — `git status --porcelain` alone reports 0 files for committed work
  // on detached-HEAD worktrees (clean tree, commits ahead of base) — the
  // exact shape of the five parked cycles (#645/#649/#659/#660/#664). Record
  // that committed work explicitly so the "Worktree state" section and the
  // worktree-aware recovery print the work's true location instead of
  // "0 file(s) modified".
  await captureCommittedWork(snap, ctx.repoRoot, state.pipelineState);
  // In-cycle teardown: purge build artifacts and retain worktrees as needed.
  // Guarded by PI_ENSEMBLE_WORKTREE_TEARDOWN=0.
  // Wrapped in try/catch: teardown must never prevent a handoff from completing.
  // #674 — the state passed to teardown carries a synthetic handoff-emitted
  // tail (below) whose `status` is "running": the cycle has not reached its
  // terminal status until this function returns. `runWorktreeTeardown`
  // decides removal via `isWorkProvablyOnRemote`, which requires a terminal
  // status — without the override, even a successful consolidation would
  // leave every worktree behind (bug 2's accumulation). Without
  // consolidation the work is NOT on the branch, so the check fails and the
  // worktrees are retained (and named in the recovery printed from the
  // snapshot). The override only ever upgrades a check from "not terminal"
  // to "terminal": it cannot turn a false into a true for work that is not
  // provably on the branch, because the fetch + HEAD + clean-tree checks
  // still run against reality.
  if (process.env.PI_ENSEMBLE_WORKTREE_TEARDOWN !== "0") {
    try {
      const terminalState = {
        ...next,
        pipelineState: { ...next.pipelineState, status: "handoff" as const },
      };
      const retained = await runWorktreeTeardown({
        repoRoot: ctx.repoRoot,
        state: terminalState,
      });
      snap.retainedWorktrees = retained;
    } catch (err) {
      trace(`work-driver: worktree teardown failed (non-fatal): ${err}`);
    }
  }
  next = {
    ...next,
    pipelineState: { ...next.pipelineState, handoffSnapshot: snap },
  };
  // #1292 — a concluded review marks a draft PR ready; a cut-short one leaves it
  // a draft. Before the render, so the comment states the outcome.
  next = await settleDraftPrAtHandoff(ctx, next);
  // Build the handoff markdown body: rendered, host paths normalised by the ONE
  // driver seam, marker-prefixed, and written to the scratch dir — one call in
  // work-driver-handoff-render.ts, which owns why the rewrite happens exactly
  // once, before the file is written (#1788 follow-up, #1327, #1820).
  const rendered = await renderHandoffBody(ctx, next);
  const handoffMd = rendered.body;
  const handoffBodyPath = rendered.bodyPath;
  // Dispatch @ops to post the comment + apply the label. The body file is
  // already on disk; ops just runs two `gh` invocations. Bounded by
  // handoffDispatchTimeoutMs() — see there for why a bound is safe here when
  // the deleted per-role caps were not, and why the number is what it is.
  // (The dispatch leg itself lives in work-driver-handoff-ops.ts — §12
  // file-size split; the bound, the write-ahead resume bookkeeping and the
  // completion / dispatch-failed event construction moved verbatim.)
  const prNumber = next.pipelineState.prNumber;
  const target = prNumber ? `pr #${prNumber}` : `issue #${ctx.issue}`;
  // A freshly re-resolved park that matches the one already reported
  // (work-driver-park-memory.ts) has its comment on the issue: no ops
  // dispatch, no second comment. The label is still verified below and
  // re-applied if someone removed it. #1743 — the record exists on the host
  // channel too, where no URL was ever captured; suppressing the post then
  // would leave the park unreported, so only a repeat that CAN point at an
  // earlier comment (or a host channel that posts nothing either way) skips.
  // #1327 — a host-owned channel: nothing is posted or labelled; the body goes in the result.
  const host = handoffChannel() === "host";
  const park = await readParkMemory(ctx, next, host);
  const reusedComment = park.repeatOf?.commentUrl !== undefined;
  // #1820 round 3 — a REFUSED body still arms the repeat-park guard. Nothing is
  // posted (the ops dispatch and the in-process fallback are both gated on
  // `rendered.refusal` below), but the `needs-human-attention` label carries no
  // text: it is a name the forge already has, and the pre-loop attention gate
  // (`work-driver-attention.ts`) reads exactly that label. A park that refused to
  // publish had no label, so the guard never armed and `/work N` on the same
  // unchanged issue re-ran the whole pipeline, refused again, and produced another
  // handoff nobody had been asked to look at — the label exists to reach a human
  // through a channel the refused text cannot travel.
  const opsGated = host || reusedComment || rendered.refusal !== undefined;
  const dispatchResult = opsGated
    ? { next, opsReplyText: "" }
    : await runHandoffOpsDispatch(ctx, next, handoffBodyPath);
  next = dispatchResult.next;
  const opsReplyText = dispatchResult.opsReplyText;
  // RE-ENTRY DEDUPE (census 2026-09-09): a crash after the comment posted
  // but before the enclosing writeState left the file at "running"; resume
  // re-entered handoff and posted a SECOND comment. A prior handoff-emitted
  // event with a commentUrl is proof of delivery — reuse it (the label
  // re-application below stays: gh --add-label is idempotent server-side).
  // #775 — the ops reply is parsed for BOTH the comment URL and the label
  // state (the ops child now verifies the label with an unchained `gh …
  // --json labels` read and reports it in the HANDOFF-RESULT marker). The
  // URL parse (the SAME shared regex as `parseHandoffCommentUrl`, exercised
  // inside `parseHandoffOpsReply`) falls back to the prior handoff-emitted
  // event's URL (the re-entry dedupe) before any fallback post — the
  // invariant pinned by test-work-driver-reentry.ts.
  const parsed = parseHandoffOpsReply(opsReplyText);
  // The dedupe line, verbatim — re-entry reuses a prior event's URL and
  // never re-posts (the canary above pins the shape):
  let commentUrl = parseHandoffCommentUrl(opsReplyText) ?? priorHandoffCommentUrl(next.eventLog);
  commentUrl ??= park.repeatOf?.commentUrl;
  if (parsed.commentUrl && !commentUrl) commentUrl = parsed.commentUrl;
  // #798 — per-target label state. When prNumber is set, the driver labels
  // BOTH the issue (the entry-gate target) and the PR (the review target);
  // each is verified independently. When prNumber is absent, only the issue
  // is targeted and issueLabelApplied mirrors labelApplied. #1472 seeds all
  // three settled for a closed-issue park — see `declinedLabelSeed`.
  let { labelApplied, issueLabelApplied, prLabelApplied } = declinedLabelSeed(
    next.pipelineState,
    prNumber,
  );
  // #1820 round 3 — a refused body posts nothing, so nothing verified it. Start
  // the fallback's label bookkeeping at "not applied" for the comment target too
  // (the `!labelApplied` below is what runs the apply); the issue-target leg
  // further down is untouched because it is already gated on `!issueLabelApplied`.
  const bodyRefused = rendered.refusal !== undefined;
  // #775 — provenance of the recorded state. "dispatch" is asserted only
  // when the driver verified it (URL parsed or label read-back succeeded);
  // a reply whose state could not be verified records no provenance.
  let delivery: "dispatch" | "fallback" | undefined;
  // #775 — track whether the ops dispatch actually failed (threw or timed out)
  // so the fallback can be gated correctly: if the dispatch succeeded and
  // the URL parsed, the fallback is skipped entirely (idempotent).
  const dispatchFailed = handoffDispatchFailed(next);
  // #1820 round 3 — the delivery legs are gated on the COMMENT having posted, not
  // on both artefacts together, so a body the hygiene seam refused still gets its
  // label. `needsLabel` below is the only thing the refused case needs, and
  // `deliverHandoff`/`postHandoffWithRetry` refuse to post an empty body, so
  // labelling cannot smuggle the text out.
  //
  // The comment-verified read stays under `!host` exactly as before: a host-owned
  // channel applies nothing by contract (#1696), so a false label there is a
  // decline and must not be chased with a forge read.
  if (!host) {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    if (commentUrl) delivery = "dispatch";
    if (forge) {
      if (prNumber) {
        // #798 — option (a): verify the label on BOTH the issue (the entry-
        // gate target) and the PR (the review target). Each is independent;
        // a partial success records which target verified.
        const issueVerified = await verifyHandoffLabel(forge, "issue", ctx.issue);
        const prVerified = await verifyHandoffLabel(forge, "pr", prNumber);
        issueLabelApplied = issueVerified;
        prLabelApplied = prVerified;
        labelApplied = issueVerified && prVerified;
        if (labelApplied && !delivery) delivery = "dispatch";
      } else {
        const verified = await verifyHandoffLabel(forge, "issue", ctx.issue);
        issueLabelApplied = verified;
        labelApplied = verified;
        if (verified && !delivery) delivery = "dispatch";
      }
    }
  }

  // In-process fallback (with retry). When the ops dispatch failed OR the
  // commentUrl didn't parse out, the driver itself posts via the forge
  // adapter. postHandoffWithRetry retries with backoff; only after retries
  // are exhausted does the HANDOFF DISPATCH INCOMPLETE banner surface. The
  // delivery half lives in work-driver-handoff-deliver.ts (§12 file-size
  // split); the try/catch stays HERE because the whole point of the leg is
  // that a forge write must never stop a handoff from completing.
  //
  // #1820 round 3 — a refused body runs this leg LABEL-ONLY. `body` arrives empty
  // so `postHandoffWithRetry`'s comment half posts nothing (it is already gated on
  // a non-empty body, and an empty expected body matches nothing, so the idempotency
  // read cannot mistake an earlier comment for this one), and the label half runs
  // exactly as it would for a comment that posted. That is the whole of the fix:
  // the label is a name, not text, and it is the only carrier the repeat-park
  // guard reads when the comment cannot be written.
  if (!host && !commentUrl && !labelApplied) {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    try {
      const delivered = await deliverHandoff({
        issue: ctx.issue,
        prNumber,
        forge,
        handoffBodyPath,
        // The bytes the seam judged. On a refusal those bytes may NOT be posted,
        // and `deliverHandoff`'s own rule is that an empty body posts no comment —
        // which is what makes "label only, comment never" one code path rather
        // than a flag the forge layer has to understand.
        body: bodyRefused ? "" : handoffMd,
        commentUrl,
        labelApplied,
        issueLabelApplied,
        prLabelApplied,
        delivery,
        dispatchFailed,
      });
      commentUrl = delivered.commentUrl;
      labelApplied = delivered.labelApplied;
      issueLabelApplied = delivered.issueLabelApplied;
      prLabelApplied = delivered.prLabelApplied;
      delivery = delivered.delivery;
    } catch (err) {
      trace(
        `work-driver: in-process forge fallback failed: ${(err as Error).message?.slice(0, 200)}`,
      );
    }
  }
  // #1820 round 3 — a REFUSED body still arms the repeat-park guard. Nothing is
  // posted (the ops dispatch is gated on `rendered.refusal` above, and
  // `postHandoffWithRetry` never posts an empty body), but the
  // `needs-human-attention` label carries no text: it is a name the forge already
  // has, and the pre-loop attention gate (`work-driver-attention.ts`) reads
  // exactly that label. A park that refused to publish had no label, so the guard
  // never armed and `/work N` on the same unchanged issue re-ran the whole
  // pipeline, refused again, and produced another handoff nobody had been asked to
  // look at — the label reaches a human through a channel the refused text cannot
  // travel. It stays inside `!host`: on the host channel the label is the host's
  // to apply and the event records the decline instead (#1696).
  if (!host && bodyRefused && prNumber && !prLabelApplied) {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    if (forge) {
      const outcome = await labelPrAfterBodyRefusal(forge, prNumber, issueLabelApplied);
      prLabelApplied = outcome.prLabelApplied;
      labelApplied = outcome.labelApplied;
    }
  }
  // #798 — when prNumber is set, the fallback above applies the label to the
  // comment target (PR) via postHandoffWithRetry. The ISSUE label is applied
  // separately here because the retry only targets one object.
  //
  // This block sits OUTSIDE the swallow-all try/catch above and is guarded by
  // `!host`: a host-owned channel never labels anything, and a forge write
  // here must not be traced away with the rest of the fallback. Do not move it
  // into `deliverHandoff` — that function is the try/catch's body.
  //
  // The gate is the TARGET, not the PR. This is the ISSUE label leg — the entry-
  // gate target that `work-driver-attention.ts` reads — so it is gated on the
  // issue's own label state. It used to also require `prNumber`, on the reasoning
  // above that the fallback's retry already labelled the comment target; but with
  // no PR the retry labels nothing at all, and the `!issueLabelApplied` read-back
  // above records "not applied", so the whole leg was skipped and an issue-target
  // park finished with NO label. That is the same failure #1820 fixed for a
  // refused body: a park the repeat-park guard cannot see re-runs the entire
  // pipeline against an unchanged issue. `applyIssueLabelDualTarget` has always
  // been the issue-facing helper, and it applies the label itself whether or not
  // a PR exists — the comment-target leg can now reach the issue too, so the
  // pre-read above is the only thing that can spare it the write.
  if (!host && !issueLabelApplied) {
    const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
    if (forge) {
      const outcome = await applyIssueLabelAndVerify(forge, ctx.issue, prLabelApplied);
      issueLabelApplied = outcome.issueLabelApplied;
      labelApplied = outcome.labelApplied;
    }
  }
  // #674 — carry the consolidation outcome into the handoff-emitted event so the
  // renderers can print either the branch-contains-the-work path or the accurate
  // per-worktree fallback. The `handoff-consolidated` event is the audit trail.
  const consEvent = lastConsolidatedEvent(next.eventLog);
  // #1421 — WHY consolidation did not happen, composed by
  // `work-driver-handoff-consolidation-claim.ts` from the snapshot's committed
  // work and the driver's own `degradedReason`. The rule lives there; the reason
  // it is a rule at all (one fixed sentence told every failure, including the
  // cargo-`target/` case, as "the work is unreachable") is in that module.
  const consolidationReason = consEvent
    ? undefined
    : consolidationClaim({
        committedWork: snap.committedWork,
        degradedReason: consolidated.degradedReason,
      });
  // #1743 — the park record is written BEFORE the event is built, so the
  // repeat count the event carries is the count this write produced rather
  // than a number read back later. Returns undefined when nothing was
  // recorded (an uncovered cap, an unreadable body, the feature off).
  //
  // `parkReported` is the delivery half of the record: the refusal threshold
  // counts REPORTED parks, not parks the driver attempted. On the forge
  // channel that is a comment that exists or a label that was verified; on the
  // host channel it is the body reaching the host in the result — which it does
  // whenever a body was rendered at all.
  const parkReported = host
    ? handoffMd.trim().length > 0
    : commentUrl !== undefined || labelApplied === true;
  const parkRecord = await recordPark(ctx, park, commentUrl, parkReported);
  // #1696 — and the host channel's own signal, which covers every cap the
  // covered records do NOT: a host cycle posts no comment and applies no label,
  // so without this a park outside the three covered caps left no trace anywhere
  // and a factory's `--restart` re-ran it indefinitely. ONE call, one rule
  // shared with the line above: a park is published when a body reached the host.
  // Bounded, because this is the terminal path: a write that never settles must
  // cost the refusal-memory it carries, never the handoff that already delivered
  // the report the memory is about.
  if (
    await boundedBestEffort("host park signal write", HOST_PARK_RECORD_BOUND_MS, () =>
      recordHostPark(ctx, next, parkReported),
    )
  ) {
    trace(
      `work-driver: host park signal write exceeded ${HOST_PARK_RECORD_BOUND_MS}ms — the handoff continues without it`,
    );
  }
  const emitted = makeHandoffEmittedEvent({
    at: Date.now(),
    commentUrl,
    labelApplied,
    handoffBodyPath,
    body: handoffMd,
    // #1820 — a refused body posted nothing: record the matcher's category/line
    // (never the term) so no reader can take this event as proof of delivery. The
    // refused TEXT is still carried: on the host channel nothing is ever posted
    // and the result's `handoff.body` is the only carrier of the report, so
    // dropping it there would silently lose a park (#1743's whole point) while the
    // comment post stays gated on `rendered.refusal` above. `bodyRefusal` is what says it
    // was not published; `result.ts` publishes no body alongside a refusal.
    ...(rendered.refusal !== undefined ? { bodyRefusal: rendered.refusal } : {}),
    consolidated: consEvent !== undefined,
    consolidatedBranch: consEvent?.branchName,
    consolidatedWorkstreams: consEvent?.workstreams,
    consolidationReason,
    // #1421 fix round — the driver's cause rides on the SAME event the
    // renderers read, as its own field (the single carrier for the cause).
    ...(consolidated.degradedReason !== undefined
      ? { degradedReason: consolidated.degradedReason }
      : {}),
    // A repeat delivered nothing this cycle — no provenance to assert.
    delivery: host ? "host" : reusedComment ? undefined : delivery,
    // #1696 — on the host channel the label is the host's to apply, so record
    // the decline: `labelApplied: false` there must never read as an outage.
    ...(host ? { labelSkipped: "host-channel" as const } : {}),
    repeatOf: park.repeatOf,
    ...(parkRecord && parkRecord.count >= REPEAT_PARK_REFUSAL_COUNT
      ? {
          repeat: {
            count: parkRecord.count,
            firstAt: parkRecord.firstAt,
            marker: parkRecord.lastMarker,
          },
        }
      : {}),
    targetType: prNumber ? "pr" : "issue",
    targetNumber: prNumber ?? ctx.issue,
    issueLabelApplied,
    prLabelApplied,
  });
  next = appendEvent(next, emitted);
  // #571 — release the path claim so sibling cycles can proceed.
  // #1454 — every issue in the group, not just the primary: a grouped cycle
  // claims all of them, so clearing one left a sibling entry to park the next
  // cycle against.
  try {
    await releaseClaim(ctx.repoRoot, activeIssuesOf(next));
  } catch {
    /* best-effort; handoff must always emit regardless */
  }
  // #1263 test seam (see setHandoffThrowForTestForTest) — called just before
  // the terminal-status write so a thrown error escapes runHandoff and the
  // driver's one-shot guard (abort, no re-route to handoff) is exercised.
  handoffThrowForTest?.();
  // The terminal status (handoff / aborted / provider-interrupted) is decided by
  // `work-driver-handoff-terminal.ts` from the cap that ended the cycle; the
  // rules and the #1243 provider re-entry argument live there.
  next = terminaliseHandoff(next, Date.now());
  trace(
    `work-driver: handoff for issue #${ctx.issue} (${target}) — commentUrl=${commentUrl ?? "NOT POSTED"} label=${labelApplied}${prNumber ? ` (issue=${issueLabelApplied === true} pr=${prLabelApplied === true})` : ""}`,
  );
  // #799 — final drain: the handoff ops child may outlive the dispatch bound
  // (its slow watch keeps recording until it settles), and the driver's
  // step-boundary drain (routeStepOutcome, which runs after this function
  // returns) is the last persistence point this cycle gets — handoff is the
  // terminal step. Drain the buffer into the returned state so a crossing
  // recorded during the handoff leg lands in the durable log instead of
  // being discarded. A crossing recorded AFTER this drain is not persisted:
  // the cycle is done and there is no later boundary to carry it. That is
  // acceptable — the crossing is an in-session notice (the PM was already
  // notified at the moment it fired), and the driver's cycle-start drop
  // (work-driver.ts) keeps any such leftover from leaking into the next
  // cycle of this issue.
  const slowEvents = drainSlowEvents(ctx.issue);
  if (slowEvents.length > 0) {
    next = { ...next, eventLog: [...next.eventLog, ...slowEvents] };
  }
  return next;
}
