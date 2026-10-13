/**
 * work-driver-adversarial-plumb — the plumb-report reader for the adversarial
 * fix pass (#1137). Split from work-driver-adversarial-fix.ts (AGENTS.md §12
 * file-size limit). `plumbQuestion` is the single reader both no-change park
 * branches use; `withNewPlumbReports` records the fix developer's plumb
 * report that is new to this pass. Leaf module: no imports from the fix
 * pass or its handlers.
 */

import type { WorkState } from "./workflow-state.ts";

/** Discloses a fact on the handoff report without parking the pass. */
export function noteFixPass(state: WorkState, note: string, now: number): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        { step: "develop", role: "driver", body: `adversarial fix pass: ${note}`, at: now },
      ],
    },
  };
}

/** The shape plumbQuestion reads (the pipeline-state plumb report record). */
export type PlumbReportLike = { body: string };

/** The marker that identifies a plumb report (the one place both park branches read it). */
export const PLUMB_REPORT_MARKER = /\[ensemble:plumb\]|plumb report|scope-ambiguity/i;

/**
 * The one reader for both no-change park branches: the first report matching
 * the plumb marker, its body embedded as UNTRUSTED developer text — prefix
 * says so, code fences stripped, capped at 300 chars with an ellipsis
 * (display-only; the full body still rides in pipelineState). `null` when none.
 */
export function plumbQuestion(reports: readonly PlumbReportLike[]): string | null {
  const plumb = reports.find((r) => PLUMB_REPORT_MARKER.test(r.body));
  if (!plumb) return null;
  const body = plumb.body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = body.length > 300 ? `${body.slice(0, 299)}…` : body; // ≤300 chars total, ellipsis-marked
  return `developer question (untrusted text): ${capped}`;
}

/**
 * Records the fix developer's plumb report (marker-matched, new to this
 * pass — the develop step records git failures, never the reply itself,
 * which is what made the plumb-with-no-change route dead code).
 */
export function withNewPlumbReports(state: WorkState, priorBodies: ReadonlySet<string>): WorkState {
  const fresh = (state.pipelineState.plumbReports ?? []).filter(
    (r) => !priorBodies.has(r.body) && PLUMB_REPORT_MARKER.test(r.body),
  );
  if (fresh.length === 0) return state;
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [...(state.pipelineState.plumbReports ?? []), ...fresh],
    },
  };
}
