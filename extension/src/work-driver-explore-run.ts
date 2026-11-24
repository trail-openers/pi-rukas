/**
 * work-driver-explore-run — the `runExplore` step handler: read the issue(s),
 * dispatch explore, and route on the reply. The pieces with their own contracts
 * live beside it — `work-driver-explore-bodies.ts` (issue bodies, or the halt
 * when one never arrived), `work-driver-explore-recovery.ts` (the two recoveries
 * an unreadable reply gets: the #2611 same-session ask, then the #1094 fresh
 * child), `work-driver-intent-*.ts` (spec reconciliation and park evidence), and
 * `work-driver-explore-dispatch.ts` (the dispatch itself). What stays here is the
 * ordering between them, since that ordering is the step's contract.
 */
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { appendBodiesEmpty, prepareExploreBodies } from "./work-driver-explore-bodies.ts";
import {
  EXPLORE_RETRY_PREFACE,
  dispatchExploreAttempt,
  hasIntentVerdictToken,
  noSpecEvidence,
  resolveExploreSpec,
  shouldRetryExplore,
} from "./work-driver-explore-dispatch.ts";
import { parkOnIntent } from "./work-driver-explore-intent-park.ts";
import {
  type ExploreReaskTried,
  type ExploreSpecPath,
  askExploreSessionOnce,
  redispatchExplore,
} from "./work-driver-explore-recovery.ts";
import {
  exploreProducedNoSignal,
  fetchIssueBodyViaGh,
  fetchIssueBodyWithRetry,
} from "./work-driver-explore.ts";
import { fetchFailureReason } from "./work-driver-fetch-reason.ts";
import { deleteSpecArtifact, persistSpecArtifact } from "./work-driver-intent-artifact.ts";
import { finaliseSpecVerdict } from "./work-driver-intent-finalise.ts";
import { groundAlreadyImplemented } from "./work-driver-intent-grounding.ts";
import { intentResolutionEnabled } from "./work-driver-intent.ts";
import { loadIssueComments, withIssueComments } from "./work-driver-issue-comments.ts";
import { issueImagesFor } from "./work-driver-issue-images.ts";
import { cycleSpecs, specFetcher } from "./work-driver-issue-spec.ts";
import {
  type ExploreVerdict,
  parseExploreVerdict,
  parsePerIssueVerdicts,
} from "./work-driver-plan.ts";
import { inlineExplorePrompt } from "./work-driver-prompts-early.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { exploreTitleAsk } from "./work-title-ask.ts";
import { settleSpecTitle } from "./work-title.ts";
import {
  type WorkState,
  appendEvent,
  persistCycle,
  writeDispatchArtifact,
} from "./workflow-state.ts";

/**
 * Step 1 — Read the issue and project context.
 *
 * Dispatches `@explore` with a prompt that:
 *   1. runs `gh issue view N` to get the issue body,
 *   2. discovers vipune memory types and searches relevant context,
 *   3. runs mcp__codebase_memory__search_code on key concepts,
 *   4. returns a structured summary the driver stores in the event log.
 *
 * The template file lives at `pi-prompts/work/explore.md` (added in the
 * step-template commit). For the skeleton, we inline a minimal prompt so
 * the smoke test can exercise the runStep path.
 */
export async function runExplore(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // Mark the step start in the log before dispatch (resume-safety).
  let next = appendEvent(
    {
      ...state,
      pipelineState: { ...state.pipelineState, currentStep: "explore" },
    },
    { kind: "step-started", step: "explore", at: now },
  );

  // PR10 — multi-issue: fetch + present all N issue bodies. For N=1
  // this collapses to the existing single-issue shape.
  const issues = ctx.issues ?? state.issues ?? [ctx.issue];

  // PR13 — fetch bodies as a BARRIER before the explore dispatch (was
  // a fan-out in PR3 Pattern 1; the race caused false NEEDS_CLARIFICATION
  // cap-hits on issues with substantive bodies because the agent's
  // verdict committed before the gh fetch settled and the prompt never
  // pointed at the cached artifact path). The bodies are then inlined
  // into the explore prompt — agent has the body content directly and
  // doesn't need to read files or trust the "driver is fetching in
  // parallel" instruction. Wall-clock impact: ~1-2 s on the happy path
  // (the parallel-fetch dispatch overlap was never that large), and up to
  // ~150 s per issue when every attempt fails — three 45 s deadlines plus
  // backoff — before the halt below fires. That worst case is bounded on
  // purpose: pre-fix the fetch carried NO deadline at all and could block
  // the step indefinitely.
  //
  // PR11 §C empty-body halt also moves above the dispatch — if any
  // fetch returns empty stdout, we halt BEFORE wasting tokens on the
  // explore dispatch. That halt is terminal, so each fetch gets a bounded
  // retry with a per-attempt deadline first (see fetchIssueBodyWithRetry).
  //
  // #1371 — the step start is persisted before the fetch, so a host reading the
  // stream sees explore begin when it begins, not after up to ~150 s of
  // fetching. An abort during the fetch wins over its result: the step returns
  // with no cap, and the loop records the interrupt.
  await persistCycle(ctx, next);
  // An approved spec that does not verify stops the cycle before any read: the bare issue never stands in for it.
  const read = await cycleSpecs(issues);
  if ("why" in read)
    return appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "step-failed:explore",
      reviewRound: 0,
      nextStep: "handoff",
      evidence: read.why,
    });
  const specSha = read.specs.get(ctx.issue)?.sha256;
  if (specSha !== undefined) next = { ...next, pipelineState: { ...next.pipelineState, specSha } };
  // The host's comments join the body here, so the cached artifact carries them to every reader.
  const comments = await loadIssueComments(issues);
  if (comments)
    next = appendEvent(next, { kind: "issue-comments", at: Date.now(), ...comments.report });
  const fetchBody = withIssueComments(
    specFetcher(ctx.issueBodyFetcherFn ?? fetchIssueBodyViaGh, read.specs),
    comments,
  );
  const bodySettled = await Promise.allSettled(
    issues.map((n) => fetchIssueBodyWithRetry(fetchBody, n, ctx.repoRoot, { signal: ctx.signal })),
  );
  if (ctx.signal?.aborted === true) {
    trace("work-driver: explore interrupted during the issue-body fetch — no cap recorded");
    return next;
  }

  // PR11 — track per-issue fetch outcome. A body still empty or still
  // failing AFTER the retries is a pre-condition failure: explore can't
  // reliably classify
  // work that hasn't been read. Live evidence (v10r 2026-06-25 / PR #483):
  // 4 of 5 empty bodies cascaded silently into wrong-issue work landing
  // PR11 — a blank or rejected body is a hard pre-condition failure: the operator
  // fixes gh and re-runs, and nothing is spent on an explore bound to halt.
  const prepared = await prepareExploreBodies({ ctx, state: next, issues, bodySettled });
  next = prepared.state;
  const bodiesForPrompt = prepared.bodies;
  if (prepared.emptyBodyIssues.length > 0) {
    return appendBodiesEmpty(next, prepared.emptyBodyIssues);
  }
  // PR13 — now dispatch with bodies embedded in the prompt. Verdict can
  // be sound from a single turn — no race, no agency-dependence.
  // #397 — ask for exactly one verdict protocol, and read the one we asked
  // for. Multi-issue is legacy-only: intent resolution yields ONE spec, so a
  // `## Spec` block in a multi-issue reply used to take the intent path and
  // return without setting activeIssues/droppedIssues at all — silently
  // dropping per-issue routing so every requested issue proceeded.
  const useIntent = intentResolutionEnabled() && issues.length === 1;
  // The issue's own images, where the launcher left any: attached to the
  // explore prompt (and its retry), with a section that lists them.
  const img = await issueImagesFor(ctx, issues, "explore");
  const dctx: CycleContext = { ...ctx, dispatchFn: img.dispatch };
  const prompt =
    inlineExplorePrompt(issues, scratchDir(ctx.repoRoot, ctx.issue), bodiesForPrompt, useIntent) +
    img.section;
  // #1094 — one dispatch attempt, then at most ONE re-dispatch when a
  // COMPLETED reply has no readable `## Spec`. Failed dispatches return here
  // (no reply to route on) and never consume the retry. The prior spec
  // artifact is dropped before each attempt, on the intent path only (#594).
  // #594 — delete the prior cycle's spec artifact before dispatch (best-effort,
  // trace on failure). Gated on useIntent: the artifact is only used on the
  // intent path, so on the legacy path (PI_ENSEMBLE_INTENT=0 or N>1) leave it.
  if (useIntent) await deleteSpecArtifact(ctx.repoRoot, ctx.issue);
  const first = await dispatchExploreAttempt(dctx, next, prompt);
  next = first.state;
  // A failed dispatch has no reply, so it returns here and can never reach the
  // retry below — this early return is what guarantees a failed dispatch never
  // retries.
  if (first.reply === undefined) return next;
  let responseText = first.reply.text ?? "";
  let transcriptPath = first.reply.transcriptPath;
  // One read per reply: the retry decision and the routing below both use it.
  let resolved = useIntent ? await resolveExploreSpec(ctx, responseText) : undefined;
  let retried = false;
  // #2611 — the ask's outcome, and which path produced the routed spec.
  let reaskTried: ExploreReaskTried | undefined;
  let specPath: ExploreSpecPath | undefined =
    resolved === undefined
      ? undefined
      : resolved.source === "artifact"
        ? "artifact"
        : "first-reply";
  // The two recoveries an unreadable reply gets, in order: the same session is
  // asked once (#2611), and only a reply it leaves unreadable is followed by a
  // fresh child (#1094). Both run only after a COMPLETED dispatch — a failed one
  // returned above, keeping the provider path's own recovery — and neither can
  // loop: nothing below returns here.
  const reasked = await askExploreSessionOnce({
    ctx: dctx,
    state: next,
    useIntent,
    reply: first.reply,
    spec: resolved,
    jobId: first.jobId,
    verdictParsed: hasIntentVerdictToken(responseText),
  });
  next = reasked.state;
  reaskTried = reasked.tried;
  if (reasked.spec !== undefined) {
    resolved = reasked.spec;
    specPath = reasked.specPath;
  }
  if (shouldRetryExplore({ useIntent, spec: resolved?.spec })) {
    const second = await redispatchExplore({
      ctx: dctx,
      state: next,
      prompt,
      useIntent,
      firstReplyText: responseText,
      firstJobId: first.jobId,
    });
    next = second.state;
    // A failed re-dispatch has no reply to route on: it returns here, as before.
    if (!second.completed) return next;
    responseText = second.replyText;
    transcriptPath = second.transcriptPath;
    resolved = second.spec;
    specPath = second.specPath;
    retried = true;
  }

  if (useIntent) {
    if (resolved !== undefined) trace(`work-driver: intent — spec resolved (${resolved.source})`);
    // Reconcile the chosen spec: a `proceed` with contradictions is
    // parked, a `proceed` with assumptions is promoted, an `underspecified`
    // park may be refuted by a complete spec. This runs on the WINNER
    // (prose or artifact), so the reconciliation logic is identical
    // regardless of which channel won the precedence rule.
    // #1151 — the primary body comes from the settled fetch, read here at the
    // gate (not a mutable local). A failed or blank read is passed through as
    // `undefined`, which finaliseSpecVerdict records instead of skipping.
    // A failed read halts below; a blank body is still recorded by finaliseSpecVerdict.
    // The primary is always in the set on this path (intent is single-issue), so a
    // miss is a wiring bug and must not be read as a blank body.
    const primaryIdx = issues.indexOf(ctx.issue);
    const primarySettled = primaryIdx === -1 ? undefined : bodySettled[primaryIdx];
    if (primarySettled?.status !== "fulfilled") {
      // A wiring bug, not a bad issue: report it as a halted step rather than
      // throwing out of the driver.
      // A rejected fetch halts the same way, with its own evidence line.
      let evidence: string;
      if (primaryIdx === -1) {
        evidence = `wiring: primary issue missing from issue list [${issues.join(", ")}]`;
      } else {
        const reason = fetchFailureReason(primarySettled?.reason);
        evidence = `primary issue #${ctx.issue} body fetch failed: ${reason || "body unavailable"}`;
      }
      trace(`work-driver: explore halted — ${evidence}`);
      return appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "step-failed:explore",
        reviewRound: 0,
        nextStep: "handoff",
        evidence,
      });
    }
    // #1351 — an `already-implemented` park is checked against the mainline first.
    const finalised = resolved
      ? finaliseSpecVerdict(
          await groundAlreadyImplemented(
            resolved.spec,
            responseText,
            ctx.repoRoot,
            ctx.verifyExecFn ?? execp,
          ),
          primarySettled.value.stdout,
        )
      : undefined;
    // A spec that proceeds names the PR: its title is checked here, re-asked once on the
    // explore session when it does not fit, and dropped when the answer still does not.
    const finalSpec =
      finalised?.verdict === "park" || finalised === undefined
        ? finalised
        : await settleSpecTitle(finalised, exploreTitleAsk(transcriptPath, ctx.repoRoot));
    if (resolved !== undefined && finalSpec !== undefined) {
      // #2611 — WHICH path produced this spec (first reply, same-session re-ask,
      // fresh re-dispatch, restored artifact), recorded where the cycle takes it:
      // "a spec was parsed" is then answerable from the state file alone.
      next = appendEvent(next, {
        kind: "explore-spec-source",
        step: "explore",
        at: Date.now(),
        source: specPath ?? (resolved.source === "artifact" ? "artifact" : "first-reply"),
        channel: resolved.source,
      });
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, normalisedSpec: finalSpec },
      };
      await persistSpecArtifact(ctx.repoRoot, ctx.issue, finalSpec);
      trace(
        `work-driver: intent verdict=${finalSpec.verdict}${finalSpec.parkReason ? ` (${finalSpec.parkReason})` : ""}, ${finalSpec.deliverables.length} deliverable(s) (source: ${resolved.source})`,
      );
      if (finalSpec.verdict === "park") {
        return await parkOnIntent(ctx, next, finalSpec);
      }
      return next;
    }
    // spec === undefined: no inline parse, no offloaded file, no valid
    // artifact. Fall through to the legacy router below (fires the
    // no-signal cap-hit on the intent path).
    trace("work-driver: no `## Spec` block and no valid artifact — legacy verdict router");
  }

  if (issues.length === 1) {
    const verdict = parseExploreVerdict(responseText);
    if (verdict) {
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, exploreVerdict: verdict },
      };
    }
    // No `## Spec` block AND no legacy verdict is no signal at all, and the
    // driver used to read that as "proceed": it fell through to `return next`
    // and advanced to plan on an explore reply it could not parse a single
    // decision out of.
    //
    // The documented degradation stays intact — an older prompt or a drifting
    // agent that still emits the legacy token is honoured above. This only
    // catches the case where neither channel said anything, which on the
    // single-issue intent path is the likely one, because the prompt suppresses
    // the legacy token it would fall back to (`useLegacyVerdict` is false
    // there, `work-driver-prompts-early.ts:46-47`).
    if (exploreProducedNoSignal(useIntent, verdict)) {
      trace("work-driver: explore returned neither a `## Spec` block nor a verdict — parking");
      // #830 — carry WHY the driver could not act so the handoff names it.
      return appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap: "explore-needs-clarification",
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
        evidence: noSpecEvidence(responseText, retried, reaskTried),
      });
    }
    if (verdict === "ALREADY_COMPLETE" || verdict === "NEEDS_CLARIFICATION") {
      const cap =
        verdict === "ALREADY_COMPLETE" ? "explore-already-complete" : "explore-needs-clarification";
      next = appendEvent(next, {
        kind: "cap-hit",
        at: Date.now(),
        cap,
        reviewRound: next.pipelineState.reviewRound,
        nextStep: "handoff",
      });
    }
    return next;
  }

  // N>1 path — per-issue verdicts.
  const perIssue = parsePerIssueVerdicts(responseText, issues);
  const activeIssues = perIssue.filter((p) => p.verdict === "NEEDS_WORK").map((p) => p.issue);
  const droppedIssues = perIssue.filter((p) => p.verdict !== "NEEDS_WORK");
  // Aggregate verdict for back-compat surfacing: NEEDS_WORK if any
  // active; else ALREADY_COMPLETE if every dropped is already-complete;
  // else NEEDS_CLARIFICATION.
  const aggregateVerdict: ExploreVerdict =
    activeIssues.length > 0
      ? "NEEDS_WORK"
      : droppedIssues.every((d) => d.verdict === "ALREADY_COMPLETE")
        ? "ALREADY_COMPLETE"
        : "NEEDS_CLARIFICATION";
  next = {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      exploreVerdict: aggregateVerdict,
      activeIssues,
      droppedIssues,
    },
  };
  if (activeIssues.length === 0) {
    // Every issue dropped → handoff with the aggregate cap. Existing
    // PR6 routing handles both cap shapes through nextStep().
    const cap =
      aggregateVerdict === "ALREADY_COMPLETE"
        ? "explore-already-complete"
        : "explore-needs-clarification";
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap,
      reviewRound: next.pipelineState.reviewRound,
      nextStep: "handoff",
    });
  }
  return next;
}
