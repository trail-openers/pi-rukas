/**
 * work-driver-plan — Step 2 (plan) handler + explore/plan reply parsers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene).
 * `sliceMarkdownSection` is exported because work-driver-branch-develop.ts's
 * `parseWorktreesBlock` reuses the same fenced-section slicer.
 */

import fs from "node:fs/promises";
import { dispatchCore } from "./dispatch.ts";
import { slowRecorder } from "./slow-notice.ts";
import { trace } from "./trace.ts";
import { extractListField, sliceMarkdownSection } from "./work-driver-plan-parse.ts";

// Re-exported: several modules read plan/spec markdown through this module.
export { sliceMarkdownSection, splitOutsideParens } from "./work-driver-plan-parse.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transcriptPathFor } from "./spawn-support.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { checkAndRegisterClaims, crossGroupConflictsEnabled } from "./work-driver-path-claims.ts";
// #679 — the CANONICAL planQualityReason / correctivePlanSteer / steer builders
// live in work-driver-plan-helpers.ts; this module re-exports them so existing
// importers (smoke tests, cross-module consumers) keep their paths. The stale
// duplicate copy that used to sit here was deleted — one function, one module.
export {
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
  countEnumeratedFindings,
  countFindingsForCycle,
  planQualityEnabled,
  planQualityReason,
  planDispatchTimeoutMs,
  planTimeoutCorrective,
} from "./work-driver-plan-helpers.ts";
import {
  correctivePlanSteer,
  correctiveTestSubjectSplitSteer,
  countFindingsForCycle,
  planDispatchTimeoutMs,
  planQualityEnabled,
  planQualityReason,
  planTimeoutCorrective,
  planTimeoutKill,
} from "./work-driver-plan-helpers.ts";
import { findPathCollisions, findTestSubjectSplits } from "./work-driver-plan-paths.ts";
import { planFindingsCount } from "./work-driver-pr-body-definition.ts";
import { inlinePlanPrompt } from "./work-driver-prompts-early.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Step 2 — Plan / decompose into workstreams.
 *
 * PR3 restores the parallelism doctrine the PR #239 driver silently
 * dropped: the user's /work command treated "default to parallel" as a
 * first principle, exploiting up to 10 parallel slots for multi-
 * workstream issues (e.g., "fix bug X in frontend AND update docs"
 * would dispatch two developers in two worktrees concurrently).
 *
 * The decomposition prompt is cribbed from `pi-prompts/plan.md` Phase 2
 * — explore-shaped, structured output. The subagent reads the cached
 * issue body (from Step 1's `issueBodyArtifact`) plus the explore
 * report and decides whether the issue contains 1, 2, or N+
 * independent workstreams. Returns a fenced `## Workstreams` block
 * the driver parses.
 *
 * Single-workstream is `N=1` of the same code path (not a separate
 * branch): a `default` workstream is always written so downstream
 * code can iterate `Object.keys(workstreams)` uniformly.
 *
 * Failure modes:
 *  - parsing returns 0 workstreams → write the synthetic `default`
 *  - dispatch fails → treat as halt (the cycle can't proceed without
 *    knowing what to develop); event is `dispatch-failed`
 */
export async function runPlan(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "plan" } },
    { kind: "step-started", step: "plan", at: now },
  );
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  const prompt = inlinePlanPrompt(activeIssuesOf(state), scratchDir(ctx.repoRoot, ctx.issue));
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const planRunId = `plan:explore:${process.pid}:${startedAt}`;
  const planTranscript = transcriptPathFor("explore", planRunId);
  // #382 — write-ahead: persist the intent to dispatch BEFORE awaiting, so a
  // process death inside the dispatch window is visible on disk rather than
  // leaving the file at the previous step boundary still claiming `running`.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "plan",
    "explore",
    "plan",
    startedAt,
    planTranscript,
  );
  next = begun.state;
  let result: DispatchResult;
  // #754 — the PRIMARY plan dispatch carries the step's own bound; the
  // corrective below deliberately does not (it is the recovery path).
  const primaryOpts = {
    label: "plan",
    timeoutMs: planDispatchTimeoutMs(),
    onSlow: slowRecorder("plan", { current: next }),
  };
  try {
    result = await dispatch(ctx.pi, { role: "explore", prompt }, primaryOpts);
  } catch (err) {
    return appendEvent(clearDispatch(next, begun.jobId), {
      kind: "dispatch-failed",
      step: "plan",
      role: "explore",
      jobId: begun.jobId,
      label: "plan",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  // #754 — a primary dispatch killed at the plan bound is routed to the
  // corrective re-dispatch below: a killed child has no structured output,
  // parseWorkstreams would return nothing. The cause is rewritten at the
  // call site (not resolveKillCause) so downstream sees it, not a timeout.
  let planKill: DispatchResult | undefined;
  const primary = planTimeoutKill(result, primaryOpts);
  if (primary) {
    result = primary;
    planKill = result;
  }
  const event = await buildCompletionEvent(ctx, "plan", "explore", "plan", result);
  next = appendEvent(clearDispatch(next, begun.jobId), event);
  // Parse workstreams out of the reply. Failure or N=0 collapses to
  // `default` — never blocks the cycle.
  let workstreams = parseWorkstreams(result.text ?? "");

  const spec = next.pipelineState.normalisedSpec;
  // #792 — count only the deliverables that are expected to produce a diff.
  // A plan-time no-diff marker (settings toggle, operator action, manual
  // verification) cannot land in any diff, so it must not feed the
  // decomposition arithmetic — a 4-code deliverable plan plus one settings
  // toggle reads as 4, not 5 (the #786 phantom-under-decomposition shape).
  const findingsCount = spec ? planFindingsCount(spec) : await countFindingsForCycle(ctx, next);

  // #290 — deterministic plan-quality gate. An under-decomposed plan is the
  // dominant convergence failure: on nessie #604 an 8.6s plan collapsed six
  // enumerated findings into ONE workstream, the developer then sprawled
  // across 11 files, looped 17 failed builds and burned 10.5M tokens before
  // dying. The check is arithmetic, not judgment — asking the model that just
  // under-decomposed whether it decomposed well is worthless.
  // #378 — count DELIVERABLES from the resolved spec, not enumerated markdown.
  // countEnumeratedFindings counts top-level `- [ ]`, and in a /plan-authored
  // issue checkboxes are exclusive to `## Acceptance criteria` — so it was
  // counting test assertions. Measured on real issues: #287→7, #288→6,
  // #289→7, #366→6, with ZERO of #287's five actual deliverables (`**A.**`–
  // `**E.**`) seen, because bolded letters are invisible to it. A correctly
  // planned single-workstream issue therefore triggered a corrective
  // re-dispatch essentially every time.
  const reason = planQualityReason(workstreams, findingsCount);
  let redispatched = false;
  // #754 — a primary killed at the step's own bound gets the one-shot
  // corrective re-dispatch below (the kill-triggered half of it).
  if (planKill) {
    const recovered = await planTimeoutCorrective(
      ctx,
      ctx.pi,
      dispatch,
      prompt,
      planKill,
      next,
      parseWorkstreams,
      planCorrectivePrompt,
    );
    if (recovered.ok) {
      next = recovered.state;
      workstreams = recovered.workstreams;
      redispatched = true;
    }
  }
  // #754 — the kill-triggered corrective already spent this cycle's one-shot
  // corrective budget; the quality gate below must not spend it a second time.
  if (!planKill && planQualityEnabled() && reason) {
    trace(`work-driver: plan quality — ${reason}, re-dispatching once`);
    const steer =
      reason === "test-subject-split"
        ? correctiveTestSubjectSplitSteer(findTestSubjectSplits(workstreams))
        : correctivePlanSteer(
            reason,
            findingsCount,
            Object.keys(workstreams).length,
            findPathCollisions(workstreams),
          );
    // #657 post-mortem — the corrective re-dispatch inherits the original
    // prompt plus any prior-handoff / prior-conflict context the cycle has
    // accumulated. A weak model read a stale `cross-group-conflict` (issue
    // already closed, fix already on base) as a LIVE unsatisfiable
    // precondition, re-verified it with two gh/git commands 530+ times, and
    // burned 73.5M cache tokens before the wall-clock kill — twice.
    const correctivePrompt = planCorrectivePrompt(prompt, steer);
    const retry = await dispatch(
      ctx.pi,
      { role: "explore", prompt: correctivePrompt },
      { label: "plan:corrective", onSlow: slowRecorder("plan", { current: next }) },
    ).catch(() => undefined);
    if (retry) {
      // #754 — the corrective is NEVER re-dispatched again — exactly one
      // corrective re-dispatch per cycle, whether the trigger was plan-quality
      // findings or the #754 kill above. If it too failed or was killed, the
      // step ends on its dispatch-failed and the router's `plan-timeout` cap
      // halts to handoff.
      next = appendEvent(
        next,
        await buildCompletionEvent(ctx, "plan", "explore", "plan:corrective", retry),
      );
      const reparsed = parseWorkstreams(retry.text ?? "");
      // Second result is final — including when it is no better. One retry,
      // never a loop; a plan step that can re-dispatch on its own verdict is
      // a plan step that can spin.
      if (Object.keys(reparsed).length > 0) workstreams = reparsed;
      redispatched = true;
    }
  }

  // #571 — cross-group claim check. Detect path overlaps with sibling cycles
  // BEFORE registering. Parking early costs one plan dispatch, not a full
  // develop/adversarial/commit-pr burn. Extracted to a helper (line budget).
  if (crossGroupConflictsEnabled()) {
    next = await checkAndRegisterClaims(ctx, next, workstreams);
  }
  if (Object.keys(workstreams).length === 0) {
    workstreams.default = {
      id: "default",
      scope: `Issue #${ctx.issue}`,
      paths: [],
      outOfScope: [],
    };
  }
  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      workstreams,
      planQuality: { findingsCount, redispatched, ...(reason ? { reason } : {}) },
    },
  };
}

/**
 * Enumerated-finding count for this cycle's primary issue, read from the body
 * artifact the explore step cached. Returns 0 when unavailable — the gate then
 * cannot fire on the findings rule, which is the correct conservative
 * behaviour for a body we could not read.
 */
export type ExploreVerdict = "NEEDS_WORK" | "ALREADY_COMPLETE" | "NEEDS_CLARIFICATION";

export function parseExploreVerdict(text: string): ExploreVerdict | null {
  const m = text.match(/VERDICT:\s*\**\s*(NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)\b/i);
  const tok = m?.[1];
  return tok ? (tok.toUpperCase() as ExploreVerdict) : null;
}

/**
 * PR10 — Multi-issue counterpart to parseExploreVerdict.
 *
 * For `/work N M P`, explore returns a per-issue verdict block like:
 *
 *   ## Verdict
 *   - #561: NEEDS_WORK
 *   - #562: ALREADY_COMPLETE — satisfied by PR #534
 *   - #563: NEEDS_WORK
 *
 * Parses one verdict per requested issue number. The `reason` string
 * captures the trailing prose after `—`/`-` (handoff renderers surface
 * it). When explore omitted a per-issue line for an issue, fall back
 * to the overall verdict via parseExploreVerdict; if even that is
 * absent, default to NEEDS_WORK so the driver proceeds rather than
 * silently dropping the issue.
 */
export function parsePerIssueVerdicts(
  text: string,
  issues: number[],
): Array<{
  issue: number;
  verdict: ExploreVerdict;
  reason: string;
  /** Where the verdict came from. `default` means nothing was parsed (#408). */
  verdictSource: "per-issue" | "overall" | "default";
}> {
  const overall = parseExploreVerdict(text);
  return issues.map((n) => {
    const re = new RegExp(
      `#${n}\\s*:\\s*\\**\\s*(NEEDS_WORK|ALREADY_COMPLETE|NEEDS_CLARIFICATION)\\b\\**\\s*[—\\-]?\\s*(.*)`,
      "i",
    );
    const m = text.match(re);
    const tok = m?.[1];
    if (tok) {
      const reason = (m?.[2] ?? "").trim();
      return {
        issue: n,
        verdict: tok.toUpperCase() as ExploreVerdict,
        reason,
        verdictSource: "per-issue" as const,
      };
    }
    if (overall) {
      return {
        issue: n,
        verdict: overall as ExploreVerdict,
        reason: "(no per-issue verdict; using overall)",
        verdictSource: "overall" as const,
      };
    }
    // #408 — this used to default to NEEDS_WORK, i.e. BUILD IT. Nothing in
    // the reply said so; the driver invented it. That is the "silence is
    // permission" shape #378 set out to remove, and it survived here on the
    // multi-issue path — which #397 then made the ONLY multi-issue path.
    //
    // A value the driver made up must not drive an irreversible decision
    // (the #404 lesson, one step upstream). NEEDS_CLARIFICATION drops the
    // issue and tells the operator the verdict could not be read, which is
    // recoverable; building something nobody asked for is not.
    return {
      issue: n,
      verdict: "NEEDS_CLARIFICATION" as ExploreVerdict,
      reason:
        "the verdict for this issue could not be read — neither a per-issue marker nor an overall VERDICT was present. Not building on a verdict the driver invented.",
      verdictSource: "default" as const,
    };
  });
}

/**
 * Parse the explore-style reply for a fenced `## Workstreams` block.
 * Expected format (lenient — agents drift; only the keys matter):
 *
 *   ## Workstreams
 *
 *   ### task-a — short scope label
 *   - paths: src/foo.ts, src/bar.ts
 *   - out-of-scope: docs/, infrastructure
 *
 *   ### task-b — second scope label
 *   ...
 *
 * No `## Workstreams` heading present → returns `{}` (caller fills in
 * the synthetic `default` workstream). Designed to never throw: a
 * malformed reply collapses to single-workstream rather than aborting
 * the cycle.
 *
 * #679 case 2(a) — also parses the optional `- depends-on: <id>` and
 * `- integration-test: <path>` lines (tolerant of `depends_on:` / `Depends on:`
 * / `Depends-on:` variants and comma-separated multi-dep, via the same
 * `extractListField` + `splitOutsideParens` tolerance class as `paths:` /
 * `out-of-scope:`). Both are OPTIONAL: a plan that omits them parses
 * identically to the pre-#679 shape.
 */
export function parseWorkstreams(text: string): Record<
  string,
  {
    id: string;
    scope: string;
    paths: string[];
    outOfScope: string[];
    dependsOn?: string[];
    integrationTest?: string;
  }
> {
  const out: Record<
    string,
    {
      id: string;
      scope: string;
      paths: string[];
      outOfScope: string[];
      dependsOn?: string[];
      integrationTest?: string;
    }
  > = {};
  const section = sliceMarkdownSection(text, "Workstreams");
  if (section === undefined) return out;
  // Each workstream begins with a ### subheading. Slice between consecutive
  // ### lines (or to end of section). Heading shape: `### <id> — <scope>` or
  // `### <id>` (scope optional; em/en/hyphen all accepted as the separator).
  // The id matches `[a-z0-9][a-z0-9_-]*` so hyphens inside an id like
  // `task-a` work; the separator is SPACE-DASH-SPACE so we don't ambiguate.
  const headingRe = /^###\s+([a-z0-9][a-z0-9_-]*)(?:\s+[—–-]\s+(.+?))?\s*$/gim;
  const headings: Array<{ index: number; length: number; id: string; scope: string }> = [];
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
  while ((m = headingRe.exec(section))) {
    const id = (m[1] ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!id) continue;
    headings.push({
      index: m.index,
      length: m[0].length,
      id,
      scope: (m[2] ?? "").trim() || id,
    });
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!h) continue;
    const bodyStart = h.index + h.length;
    const bodyEnd = headings[i + 1]?.index ?? section.length;
    const body = section.slice(bodyStart, bodyEnd);
    // #679 case 2(a) — `depends-on` and `integration-test` are OPTIONAL lines.
    // Tolerant of `depends_on:` / `Depends on:` / `Depends-on:` variants and
    // comma-separated multi-dep (same `extractListField` + `splitOutsideParens`
    // tolerance class as `paths:` / `out-of-scope:`). Self-references and
    // dangling references are not dropped HERE — they surface as the
    // `invalid-dependency` / `circular-dependency` plan-quality reasons in
    // planQualityReason (the driver's one-shot corrective re-dispatch is the
    // existing pattern; the planner gets a steer naming the fix).
    const dependsOn = extractListField(body, "depends[- _]on");
    const integrationTest = extractListField(body, "integration[- _]test")[0];
    const entry = {
      id: h.id,
      scope: h.scope,
      paths: extractListField(body, "paths"),
      outOfScope: extractListField(body, "out[- ]of[- ]scope"),
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(integrationTest ? { integrationTest } : {}),
    };
    // #290 — ceiling. Each workstream becomes a worktree AND a developer
    // child, so M is a direct multiplier on process count; parallel groups
    // multiply it again. The prompt now deliberately biases toward MORE
    // workstreams, which makes an unbounded M actively dangerous rather than
    // merely untidy. Excess FOLDS into the last kept workstream — union of
    // paths, scope annotated — so the work is never silently dropped, which
    // is the failure mode a hard truncation would introduce.
    if (Object.keys(out).length >= maxWorkstreams()) {
      const lastId = Object.keys(out)[Object.keys(out).length - 1];
      const last = lastId ? out[lastId] : undefined;
      if (last) {
        last.paths = [...new Set([...last.paths, ...entry.paths])];
        last.outOfScope = [...new Set([...last.outOfScope, ...entry.outOfScope])];
        last.scope = `${last.scope} (+folded: ${entry.id})`;
        trace(
          `work-driver: plan exceeded MAX_WORKSTREAMS — folded '${entry.id}' into '${last.id}'`,
        );
      }
      continue;
    }
    out[h.id] = entry;
  }
  return out;
}

/** #290 — ceiling on workstreams per cycle. Override: PI_ENSEMBLE_MAX_WORKSTREAMS. */
export function maxWorkstreams(): number {
  const env = Number(process.env.PI_ENSEMBLE_MAX_WORKSTREAMS);
  return Number.isFinite(env) && env >= 1 ? env : 6;
}

/**
 * #657 — the corrective plan re-dispatch prompt. The historical-context note
 * lives here (at the corrective call path, NOT inside the shared steer
 * builders) so it applies ONLY to corrective re-dispatches: a weak model in
 * the #657 post-mortem read a stale `cross-group-conflict` reference as a
 * live unsatisfiable precondition, re-verified it with two gh/git commands
 * 530+ times, and burned 73.5M cache tokens before the wall-clock kill —
 * twice.
 */
export function planCorrectivePrompt(prompt: string, steer: string): string {
  const historicalNote = [
    "NOTE: any prior-handoff or prior-conflict references in your context (e.g. an earlier",
    "`cross-group-conflict` or overlapping-paths finding from a previous cycle) are HISTORICAL",
    "records, not live preconditions. Do NOT re-verify them (no `gh issue view`, no `git",
    "merge-base` checks on them) and do NOT let them block your plan. If the referenced",
    "issue/commit is no longer relevant, simply proceed with your decomposition. Your job is",
    "the decomposition itself — emit your final report once it is complete and stop.",
  ].join(" ");
  return `${prompt}\n\n${steer}\n\n${historicalNote}`;
}

/**
 * #290 — count discrete, actionable findings in an issue body.
 *
 * Deliberately deterministic and dumb: top-level numbered items (`1.`, `2)`)
 * and checkboxes (`- [ ]`). Indented continuations are excluded, because a
 * nested sub-point is detail about one finding, not a second finding.
 *
 * This exists to catch under-decomposition without asking a model whether it
 * decomposed well — a model that just produced one workstream is the last
 * thing you should ask. The count is compared against the workstream count
 * and nothing else.
 */
