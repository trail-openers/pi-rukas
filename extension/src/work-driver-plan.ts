/**
 * work-driver-plan — Step 2 (plan) handler + explore/plan reply parsers.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene).
 * `sliceMarkdownSection` is exported because work-driver-branch-develop.ts's
 * `parseWorktreesBlock` reuses the same fenced-section slicer.
 */

import { dispatchCore } from "./dispatch.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { inlinePlanPrompt } from "./work-driver-prompts-early.ts";
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
  let result: DispatchResult;
  try {
    result = await dispatch(ctx.pi, { role: "explore", prompt }, { label: "plan" });
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "plan",
      role: "explore",
      jobId: "unknown",
      label: "plan",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  const event = await buildCompletionEvent(ctx, "plan", "explore", "plan", result);
  next = appendEvent(next, event);
  // Parse workstreams out of the reply. Failure or N=0 collapses to
  // `default` — never blocks the cycle.
  const workstreams = parseWorkstreams(result.text ?? "");
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
    pipelineState: { ...next.pipelineState, workstreams },
  };
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
    out[h.id] = {
      id: h.id,
      scope: h.scope,
      paths: extractListField(body, "paths"),
      outOfScope: extractListField(body, "out[- ]of[- ]scope"),
    };
  }
  return out;
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
