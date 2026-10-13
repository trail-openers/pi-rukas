/**
 * work-driver-adversarial-plumb — the plumb-report reader for the adversarial
 * fix pass (#1137). Split from work-driver-adversarial-fix.ts (AGENTS.md §12
 * file-size limit). `plumbQuestion` is the single reader both no-change park
 * branches use; `withNewPlumbReports` records the fix developer's plumb
 * report that is new to this pass. Leaf module: no imports from the fix
 * pass or its handlers.
 */

import { postPassFault } from "./work-driver-adversarial-fix-scope.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import type { WorkState } from "./workflow-state.ts";

/** Bound on the findings carried in an event / the fix prompt (state-file hygiene). */
export const FIX_FINDINGS_MAX = 4000;

/**
 * Cuts one sibling's findings to `max` characters and says so, so a cut
 * is never silent.
 */
export function capWithMarker(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} chars omitted]`;
}

/**
 * A mixed first-pass fan-out parks on the infra cap, which would otherwise
 * drop the parsed siblings. Each parsed sibling's verdict and findings go to
 * the handoff as a plumb report.
 */
export function withParsedSiblings(
  state: WorkState,
  outcomes: readonly AdversarialOutcome[],
  now: number,
): WorkState {
  const parsed = outcomes.filter((o) => o.fixRequested || (!o.ok && !o.infra && !o.threw));
  if (parsed.length === 0) return state;
  const body = parsed
    .map((o) => {
      const status = o.records[o.records.length - 1]?.status ?? "parsed verdict";
      const text = (o.fixRequested ? o.fixFindings : o.rejectionText) ?? "(no findings text)";
      return `[workstream ${o.id}] ${status}:\n${capWithMarker(text, FIX_FINDINGS_MAX)}`;
    })
    .join("\n\n---\n\n");
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      plumbReports: [
        ...(state.pipelineState.plumbReports ?? []),
        {
          step: "adversarial",
          role: "driver",
          body: `mixed fan-out: parsed sibling verdicts kept alongside the infra cap:\n${body}`,
          at: now,
        },
      ],
    },
  };
}

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

/** The post-pass read's reason when the pass changed nothing (postPassFault). */
export const NO_CHANGE_REASON = /byte-identical|nothing was fixed/i;

/**
 * The fix developer's plumb question from reports NEW to this pass. A stale
 * question from an earlier pass is never presented as this pass's.
 */
export function freshPlumbQuestion(
  state: WorkState,
  priorBodies: ReadonlySet<string>,
): string | null {
  const fresh = (state.pipelineState.plumbReports ?? []).filter((r) => !priorBodies.has(r.body));
  return plumbQuestion(fresh);
}

/** True only when the post-pass read proves the pass changed nothing. */
export async function noChangeProven(
  execFn: Parameters<typeof postPassFault>[0],
  plans: Parameters<typeof postPassFault>[1],
  baseSha: string,
): Promise<boolean> {
  const check = await postPassFault(execFn, plans, baseSha);
  return check.reason !== undefined && NO_CHANGE_REASON.test(check.reason);
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
