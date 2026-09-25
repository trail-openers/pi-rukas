/**
 * work-driver-explore-run — the `runExplore` step handler, moved VERBATIM
 * from work-driver-explore.ts (the 500-line gate headroom for the #799
 * slow-watch wiring). No behaviour change — the import paths below are the
 * union of both files' imports, and `work-driver-explore.ts` re-exports
 * `runExplore` so existing imports keep their path.
 */
import { dispatchCore } from "./dispatch.ts";
import { slowRecorder } from "./slow-notice.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  exploreProducedNoSignal,
  fetchIssueBodyViaGh,
  fetchIssueBodyWithRetry,
} from "./work-driver-explore.ts";
import {
  deleteSpecArtifact,
  persistSpecArtifact,
  readSpecArtifact,
  resolveIntentVerdict,
} from "./work-driver-intent-artifact.ts";
import { recoverOffloadedSpec } from "./work-driver-intent-offload.ts";
import { intentResolutionEnabled, reconcileVerdict } from "./work-driver-intent.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import {
  type ExploreVerdict,
  parseExploreVerdict,
  parsePerIssueVerdicts,
} from "./work-driver-plan.ts";
import { inlineExplorePrompt } from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent, writeDispatchArtifact } from "./workflow-state.ts";

/**
 * Step 1 — Read the issue and project context.
 *
 * Dispatches `@explore` with a prompt that:
 *   1. runs `gh issue view N` to get the issue body,
 *   2. discovers vipune memory types and searches relevant context,
 *   3. runs codebase_memory_search_code on key concepts,
 *   4. returns a structured summary the driver stores in the event log.
 *
 * The template file lives at `pi-prompts/work/explore.md` (added in the
 * step-template commit). For the skeleton, we inline a minimal prompt so
 * the smoke test can exercise the runStep path.
 */
export async function runExplore(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  // Mark the step start in the log before dispatch (resume-safety).
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "explore" } },
    { kind: "step-started", step: "explore", at: now },
  );

  // PR10 — multi-issue: fetch + present all N issue bodies. For N=1
  // this collapses to the existing single-issue shape.
  const issues = ctx.issues ?? state.issues ?? [ctx.issue];
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();

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
  const fetchBody = ctx.issueBodyFetcherFn ?? fetchIssueBodyViaGh;
  const bodySettled = await Promise.allSettled(
    issues.map((n) => fetchIssueBodyWithRetry(fetchBody, n, ctx.repoRoot)),
  );

  // PR11 — track per-issue fetch outcome. A body still empty or still
  // failing AFTER the retries is a pre-condition failure: explore can't
  // reliably classify
  // work that hasn't been read. Live evidence (v10r 2026-06-25 / PR #483):
  // 4 of 5 empty bodies cascaded silently into wrong-issue work landing
  // on main. Strict halt — operator gets a clear remediation message and
  // can fix gh auth / version / network before re-running.
  const emptyBodyIssues: Array<{ issue: number; reason: string }> = [];

  // PR13 — per-issue body content for inlining in the explore prompt.
  // Capped at 16 KiB per body — covers virtually every real-world issue
  // body. Larger bodies get a truncation marker pointing at the cached
  // artifact so the agent can `cat` for the rest if needed.
  const INLINE_BODY_CAP = 16 * 1024;
  const bodiesForPrompt: Array<{ issue: number; body: string; truncated: boolean }> = [];

  // Persist each issue body as a claim-check artifact (best-effort).
  // For single-issue cycles, the first body is stored under the legacy
  // "issue-body" name so back-compat readers still find it; additional
  // bodies use "issue-body-<N>" naming.
  for (let i = 0; i < issues.length; i++) {
    const n = issues[i];
    if (n === undefined) continue;
    const result = bodySettled[i];
    if (result?.status === "fulfilled") {
      const body = result.value.stdout;
      if (!body.trim()) {
        emptyBodyIssues.push({
          issue: n,
          reason:
            "gh issue view returned empty stdout on every attempt (possible projectCards GraphQL deprecation, gh extension hijack, or auth lapse)",
        });
        continue;
      }
      let artifactPath: string | undefined;
      try {
        const artifactName = issues.length === 1 ? "issue-body" : `issue-body-${n}`;
        artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, artifactName, body);
        // Only set issueBodyArtifact for the PRIMARY issue (back-compat
        // path readers look for `state.pipelineState.issueBodyArtifact`).
        if (n === ctx.issue) {
          next = {
            ...next,
            pipelineState: { ...next.pipelineState, issueBodyArtifact: artifactPath },
          };
        }
      } catch (err) {
        trace(
          `work-driver: failed to persist issue-body artifact for #${n}: ${(err as Error).message}`,
        );
      }
      const truncated = body.length > INLINE_BODY_CAP;
      const inlineBody = truncated
        ? `${body.slice(0, INLINE_BODY_CAP)}\n[... truncated; full body at ${artifactPath ?? "(artifact write failed)"}]`
        : body;
      bodiesForPrompt.push({ issue: n, body: inlineBody, truncated });
    } else if (result?.status === "rejected") {
      const reason = (result.reason as Error).message?.slice(0, 200) ?? "(no error message)";
      trace(`work-driver: gh issue view ${n} failed after every attempt: ${reason}`);
      emptyBodyIssues.push({
        issue: n,
        reason: `gh issue view rejected on every attempt: ${reason}`,
      });
    }
  }

  // PR11 — halt the cycle if ANY issue body failed to fetch. Pre-condition
  // failure; the operator fixes gh and re-runs. PR13 moves this check
  // above the dispatch so we don't spend tokens on an explore that's
  // bound to halt anyway. Same routing as before.
  if (emptyBodyIssues.length > 0) {
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, emptyBodyIssues },
    };
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "explore-bodies-empty",
      reviewRound: 0,
      nextStep: "handoff",
    });
    return next;
  }

  // PR13 — now dispatch with bodies embedded in the prompt. Verdict can
  // be sound from a single turn — no race, no agency-dependence.
  // #397 — ask for exactly one verdict protocol, and read the one we asked
  // for. Multi-issue is legacy-only: intent resolution yields ONE spec, so a
  // `## Spec` block in a multi-issue reply used to take the intent path and
  // return without setting activeIssues/droppedIssues at all — silently
  // dropping per-issue routing so every requested issue proceeded.
  const useIntent = intentResolutionEnabled() && issues.length === 1;
  const prompt = inlineExplorePrompt(
    issues,
    scratchDir(ctx.repoRoot, ctx.issue),
    bodiesForPrompt,
    useIntent,
  );
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const exploreRunId = `explore:explore:${process.pid}:${startedAt}`;
  const exploreTranscript = transcriptPathFor("explore", exploreRunId);
  // #382 — write-ahead before the await; see work-driver-resume.ts.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "explore",
    "explore",
    "explore",
    startedAt,
    exploreTranscript,
  );
  next = begun.state;
  // #799 — the state ref the slow recorder appends to (the step folds it
  // back on every exit path; the recorder itself never persists).
  const exploreStateRef = { current: next };
  // #594 — delete the prior cycle's spec artifact before dispatch (best-effort,
  // trace on failure). Gated on useIntent: the artifact is only used on the
  // intent path, so on the legacy path (PI_ENSEMBLE_INTENT=0 or N>1) leave it.
  if (useIntent) {
    await deleteSpecArtifact(ctx.repoRoot, ctx.issue);
  }
  const dispatchSettled = await Promise.allSettled([
    dispatch(
      ctx.pi,
      { role: "explore", prompt },
      { label: "explore", onSlow: slowRecorder("explore", exploreStateRef) },
    ),
  ]).then((arr) => arr[0]);

  if (dispatchSettled?.status === "rejected") {
    // #799 — fold the recorder's ref on the failure path too: a crossing
    // recorded before the failure must not be dropped by the next writeState.
    return appendEvent(clearDispatch(exploreStateRef.current, begun.jobId), {
      kind: "dispatch-failed",
      step: "explore",
      role: "explore",
      jobId: begun.jobId,
      label: "explore",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (dispatchSettled.reason as Error).message?.slice(-200),
    });
  }
  if (!dispatchSettled || dispatchSettled.status !== "fulfilled") {
    // Defensive — Promise.allSettled returns either fulfilled or rejected;
    // this branch unreachable. Synthesise a dispatch-failed so the driver
    // can route normally.
    return appendEvent(clearDispatch(exploreStateRef.current, begun.jobId), {
      kind: "dispatch-failed",
      step: "explore",
      role: "explore",
      jobId: begun.jobId,
      label: "explore",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: "explore dispatch settled in an unexpected state",
    });
  }

  // dispatchSettled.value is the explore role's dispatch result
  // (single-dispatch — explore returns one report covering all issues).
  const exploreDispatch = dispatchSettled.value as DispatchResult;
  // #799 — fold the recorder's ref back: the dispatch-slow events recorded
  // during the dispatch sit in exploreStateRef.current.
  next = exploreStateRef.current;
  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", exploreDispatch);
  next = appendEvent(clearDispatch(next, begun.jobId), event);

  // A dispatch that FAILED has no reply to route on (nessie #686/#693).
  if (event.kind !== "dispatch-completed") return next;

  const responseText = exploreDispatch.text ?? "";

  if (useIntent) {
    const parsed = await recoverOffloadedSpec(responseText, scratchDir(ctx.repoRoot, ctx.issue));
    if (parsed !== undefined) {
      trace("work-driver: intent — spec resolved (offload fallback or inline parse)");
    }
    const artifact = await readSpecArtifact(ctx.repoRoot, ctx.issue);
    const { spec, source } = resolveIntentVerdict(parsed, artifact);
    // Reconcile the chosen spec: a `proceed` with contradictions is
    // parked, a `proceed` with assumptions is promoted, an `underspecified`
    // park may be refuted by a complete spec. This runs on the WINNER
    // (prose or artifact), so the reconciliation logic is identical
    // regardless of which channel won the precedence rule.
    const finalSpec = spec ? reconcileVerdict(spec) : undefined;
    if (finalSpec !== undefined) {
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, normalisedSpec: finalSpec },
      };
      await persistSpecArtifact(ctx.repoRoot, ctx.issue, finalSpec);
      trace(
        `work-driver: intent verdict=${finalSpec.verdict}${finalSpec.parkReason ? ` (${finalSpec.parkReason})` : ""}, ${finalSpec.deliverables.length} deliverable(s) (source: ${source})`,
      );
      if (finalSpec.verdict === "park") {
        // #657 — carry the machine-readable park reason on the cap-hit itself
        // so the renderers can show `intent-park (contradicted-by-code)`.
        return appendEvent(next, {
          kind: "cap-hit",
          at: Date.now(),
          cap: "intent-park",
          reviewRound: next.pipelineState.reviewRound,
          nextStep: "handoff",
          ...(finalSpec.parkReason ? { parkReason: finalSpec.parkReason } : {}),
        });
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
        evidence: "no verdict and no spec parsed",
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
