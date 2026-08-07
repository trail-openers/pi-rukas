/**
 * work-driver-explore — Step 1 (explore) handler.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Dispatches
 * `@explore` with all requested issue bodies inlined, then routes on the
 * parsed verdict(s) via work-driver-plan.ts's parsers.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import {
  intentResolutionEnabled,
  parseNormalisedSpec,
  reconcileVerdict,
} from "./work-driver-intent.ts";
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

const execp = promisify(exec);

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
  // parallel" instruction. Wall-clock impact: ~1-2 s (the parallel-
  // fetch dispatch overlap was never that large).
  //
  // PR11 §C empty-body halt also moves above the dispatch — if any
  // fetch returns empty stdout, we halt BEFORE wasting tokens on the
  // explore dispatch.
  const fetchBody =
    ctx.issueBodyFetcherFn ??
    ((n: number, cwd: string) => execp(`gh issue view ${n}`, { cwd, maxBuffer: 256 * 1024 }));
  const bodySettled = await Promise.allSettled(issues.map((n) => fetchBody(n, ctx.repoRoot)));

  // PR11 — track per-issue fetch outcome. Any empty/failed body is a
  // pre-condition failure for the cycle: explore can't reliably classify
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
            "gh issue view returned empty stdout (possible projectCards GraphQL deprecation, gh extension hijack, or auth lapse)",
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
      trace(`work-driver: gh issue view ${n} failed: ${reason}`);
      emptyBodyIssues.push({ issue: n, reason: `gh issue view rejected: ${reason}` });
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
  const prompt = inlineExplorePrompt(issues, scratchDir(ctx.repoRoot, ctx.issue), bodiesForPrompt);
  // #382 — write-ahead before the await; see work-driver-resume.ts.
  const begun = await beginDispatch(ctx.repoRoot, next, "explore", "explore", "explore", startedAt);
  next = begun.state;
  const dispatchSettled = await Promise.allSettled([
    dispatch(ctx.pi, { role: "explore", prompt }, { label: "explore" }),
  ]).then((arr) => arr[0]);

  if (dispatchSettled?.status === "rejected") {
    return appendEvent(clearDispatch(next, begun.jobId), {
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
    return appendEvent(clearDispatch(next, begun.jobId), {
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
  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", exploreDispatch);
  next = appendEvent(clearDispatch(next, begun.jobId), event);

  // PR6 + PR10 — verdict router. For N=1, the existing
  // parseExploreVerdict path is unchanged. For N>1, parse per-issue
  // verdicts and split into activeIssues (NEEDS_WORK) + droppedIssues
  // (ALREADY_COMPLETE / NEEDS_CLARIFICATION). If ALL issues are
  // dropped, synthesise an aggregate cap-hit (PR6 path); otherwise
  // continue with the activeIssues subset.
  const responseText = exploreDispatch.text ?? "";

  // #378 — intent resolution. The resolver worked out what is actually being
  // asked and checked it against the code and the world; route on that rather
  // than on a single classification token. Falls through to the pre-#378
  // router when no `## Spec` block came back, so an older prompt or a drifting
  // agent degrades to the previous behaviour instead of parking everything.
  if (intentResolutionEnabled()) {
    const parsed = parseNormalisedSpec(responseText);
    if (parsed) {
      const spec = reconcileVerdict(parsed);
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, normalisedSpec: spec },
      };
      try {
        await writeDispatchArtifact(ctx.repoRoot, ctx.issue, "spec", JSON.stringify(spec, null, 2));
      } catch (err) {
        trace(`work-driver: could not persist spec artifact: ${(err as Error).message}`);
      }
      trace(
        `work-driver: intent verdict=${spec.verdict}${spec.parkReason ? ` (${spec.parkReason})` : ""}, ${spec.deliverables.length} deliverable(s)`,
      );
      if (spec.verdict === "park") {
        return appendEvent(next, {
          kind: "cap-hit",
          at: Date.now(),
          cap: "intent-park",
          reviewRound: next.pipelineState.reviewRound,
          nextStep: "handoff",
        });
      }
      return next;
    }
    trace("work-driver: no `## Spec` block in the explore reply — using the legacy verdict router");
  }

  if (issues.length === 1) {
    const verdict = parseExploreVerdict(responseText);
    if (verdict) {
      next = {
        ...next,
        pipelineState: { ...next.pipelineState, exploreVerdict: verdict },
      };
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
