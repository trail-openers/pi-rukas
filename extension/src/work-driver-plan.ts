/**
 * work-driver-plan — Step 2 (plan) handler + explore/plan reply parsers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene).
 * `sliceMarkdownSection` is exported because work-driver-branch-develop.ts's
 * `parseWorktreesBlock` reuses the same fenced-section slicer.
 */

import fs from "node:fs/promises";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
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
  // #382 — write-ahead: persist the intent to dispatch BEFORE awaiting, so a
  // process death inside the dispatch window is visible on disk rather than
  // leaving the file at the previous step boundary still claiming `running`.
  const begun = await beginDispatch(ctx.repoRoot, next, "plan", "explore", "plan", startedAt);
  next = begun.state;
  let result: DispatchResult;
  try {
    result = await dispatch(ctx.pi, { role: "explore", prompt }, { label: "plan" });
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
  const event = await buildCompletionEvent(ctx, "plan", "explore", "plan", result);
  next = appendEvent(clearDispatch(next, begun.jobId), event);
  // Parse workstreams out of the reply. Failure or N=0 collapses to
  // `default` — never blocks the cycle.
  let workstreams = parseWorkstreams(result.text ?? "");

  // #290 — deterministic plan-quality gate. An under-decomposed plan is the
  // dominant convergence failure: on lantern #604 an 8.6s plan collapsed six
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
  const spec = next.pipelineState.normalisedSpec;
  const findingsCount =
    spec && spec.deliverables.length > 0
      ? spec.deliverables.length
      : await countFindingsForCycle(ctx, next);
  const reason = planQualityReason(workstreams, findingsCount);
  let redispatched = false;
  if (planQualityEnabled() && reason) {
    trace(`work-driver: plan quality — ${reason}, re-dispatching once`);
    const retry = await dispatch(
      ctx.pi,
      {
        role: "explore",
        prompt: `${prompt}\n\n${correctivePlanSteer(reason, findingsCount, Object.keys(workstreams).length)}`,
      },
      { label: "plan:corrective" },
    ).catch(() => undefined);
    if (retry) {
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

/** #290 escape hatch: PI_ENSEMBLE_PLAN_QUALITY=0 disables the re-dispatch (doctrine stays). */
export function planQualityEnabled(): boolean {
  const v = process.env.PI_ENSEMBLE_PLAN_QUALITY;
  return v !== "0" && v !== "false";
}

/**
 * Which plan-quality rule was violated, if any. Both are structural: an
 * under-decomposed plan produces a sprawling diff, and a workstream with no
 * declared paths disables `verifyConsolidation`'s oracle for that slice
 * (`work-driver-verify.ts` skips workstreams with `paths.length === 0`).
 */
export function planQualityReason(
  workstreams: Record<string, { paths: string[] }>,
  findingsCount: number,
): "under-decomposed" | "empty-paths" | undefined {
  const ids = Object.keys(workstreams);
  if (findingsCount >= 3 && ids.length === 1) return "under-decomposed";
  if (ids.length > 0 && ids.some((id) => (workstreams[id]?.paths.length ?? 0) === 0)) {
    return "empty-paths";
  }
  return undefined;
}

/** The corrective steer appended to the second plan dispatch. */
export function correctivePlanSteer(
  reason: "under-decomposed" | "empty-paths",
  findingsCount: number,
  workstreamCount: number,
): string {
  if (reason === "under-decomposed") {
    return [
      "## Corrective re-dispatch",
      "",
      `Your previous plan produced ${workstreamCount} workstream(s) for an issue body containing ${findingsCount} enumerated findings.`,
      "That is under-decomposed. Two findings share a workstream ONLY when they require edits to THE SAME FILES —",
      "conceptual relatedness is not a reason. Re-plan: map each finding to its own workstream unless the file sets",
      "genuinely overlap, and list anything you are deliberately not doing under `Deferred:`.",
    ].join("\n");
  }
  return [
    "## Corrective re-dispatch",
    "",
    "At least one workstream in your previous plan declared no `paths:`.",
    "Every workstream MUST list the files it will touch — the driver uses that list to verify the committed diff",
    "actually contains each workstream's slice, and an empty list silently disables that check.",
    "Re-plan with a non-empty `paths:` and `out-of-scope:` for every workstream.",
  ].join("\n");
}

/**
 * Enumerated-finding count for this cycle's primary issue, read from the body
 * artifact the explore step cached. Returns 0 when unavailable — the gate then
 * cannot fire on the findings rule, which is the correct conservative
 * behaviour for a body we could not read.
 */
async function countFindingsForCycle(ctx: DriverContext, state: WorkState): Promise<number> {
  const artifact = state.pipelineState.issueBodyArtifact;
  if (!artifact) return 0;
  try {
    return countEnumeratedFindings(await fs.readFile(artifact, "utf8"));
  } catch (err) {
    trace(
      `work-driver: plan quality could not read issue body artifact: ${(err as Error).message?.slice(0, 120)}`,
    );
    return 0;
  }
}

/**
 * PR6 — Parse the explore reply for a `VERDICT: <kind>` token.
 *
 * Lenient on shape: tolerates `VERDICT: X`, `**VERDICT:** X`, leading
 * whitespace, any case. First match wins so a verbatim quote of the
 * prompt text further down in the reply doesn't override the verdict
 * declared at the top. Returns null on missing or unknown verdicts —
 * `runExplore` treats null as "agent skipped the heading, proceed as
 * NEEDS_WORK" rather than halting. The structural fix is opt-in
 * robustness, not a hard contract break.
 *
 * Empirical case (#533 cascade): explore declared "Task complete:
 * Issue #533 — ALREADY COMPLETED" in prose at the top of its reply
 * but lacked the `VERDICT:` heading, so the driver had nothing to
 * route on. With this parser + the prompt update, future already-
 * complete declarations carry a parseable token.
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
): Array<{ issue: number; verdict: ExploreVerdict; reason: string }> {
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
      return { issue: n, verdict: tok.toUpperCase() as ExploreVerdict, reason };
    }
    return {
      issue: n,
      verdict: (overall ?? "NEEDS_WORK") as ExploreVerdict,
      reason: overall
        ? "(no per-issue verdict; using overall)"
        : "(no verdict; defaulting to NEEDS_WORK)",
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
 */
export function parseWorkstreams(
  text: string,
): Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }> {
  const out: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }> =
    {};
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
    const entry = {
      id: h.id,
      scope: h.scope,
      paths: extractListField(body, "paths"),
      outOfScope: extractListField(body, "out[- ]of[- ]scope"),
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
export function countEnumeratedFindings(body: string): number {
  let n = 0;
  for (const line of body.split("\n")) {
    if (/^\s{2,}/.test(line)) continue; // indented → sub-point of a finding
    if (/^\s*(?:\d+[.)]\s+\S|[-*]\s+\[[ xX]\]\s*\S)/.test(line)) n += 1;
  }
  return n;
}

/**
 * Slice the markdown subsection following a given `## <name>` heading.
 * Returns text from the line after the heading up to (but not including)
 * the next top-level `## ` heading or end of input. Returns `undefined`
 * when the heading isn't present. JS regex has no `\Z`; this helper
 * gives the same effect with explicit string operations.
 */
export function sliceMarkdownSection(text: string, name: string): string | undefined {
  const headingRe = new RegExp(`^##\\s+${name}\\s*$`, "m");
  const m = text.match(headingRe);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length;
  const after = text.slice(start);
  const nextMatch = after.match(/^##\s/m);
  if (nextMatch && nextMatch.index !== undefined) {
    return after.slice(0, nextMatch.index);
  }
  return after;
}

/** Extract `- key: a, b, c` or `- key: a` from a markdown sub-section. */
function extractListField(body: string, keyPattern: string): string[] {
  const re = new RegExp(`^\\s*[-*]\\s*${keyPattern}\\s*:\\s*(.+?)\\s*$`, "im");
  const m = body.match(re);
  if (!m) return [];
  return (m[1] ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
