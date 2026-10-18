/**
 * research-angle — one retrieval angle's dispatch + fail-closed classification.
 *
 * Extracted from research-driver.ts at the AGENTS.md §12 size cap. The rule it
 * owns is D8 transposed from the plan driver: an angle is `ok` only when the
 * dispatch succeeded AND produced ≥1 structured claim. A failed angle keeps its
 * own `failure` string so the artifact names the hole rather than reporting a
 * quiet absence, and `fullText` stays on the returned object because the
 * `parallel-outcome:` / `backend:` markers sit at the END of a reply — the
 * fallback classifier must see them, not the 500-char summary.
 */
import type { ResearchDispatchFn } from "./research-driver.ts";
import { RESEARCH_DISPATCH_TIMEOUT_MS, RESEARCH_EXTRA_ARGS } from "./research-driver.ts";
import { type ParallelOutcome, wigoloAnglePrompt } from "./research-fallback.ts";
import { surfaceForAngle } from "./research-fallback.ts";
import type { AngleRun, ResearchClaim } from "./research-types.ts";
import { extractResearchClaims } from "./research-types.ts";
import { trace } from "./trace.ts";

/** The angle spec shape (research-angles.ts) as this helper needs it. */
export interface AngleDispatchSpec {
  name: string;
  prompt: string;
}

/**
 * Dispatch one angle and classify it. A rejecting dispatch (or a throwing stub)
 * never sinks the retrieval barrier — the angle stays failed and its summary
 * carries the error, so the other angles and the artifact survive it.
 */
export async function runResearchAngle(
  dispatch: ResearchDispatchFn,
  pi: Parameters<ResearchDispatchFn>[0],
  a: AngleDispatchSpec,
  backend: AngleRun["backend"],
  reason: ParallelOutcome | undefined,
  ctx: {
    priorBlock: string;
    fallbackLine: string;
    repoRoot: string;
    /** #1541 — the async job's signal, so dispatch_kill SIGTERMs a live angle
     *  instead of only refusing the next phase. */
    signal?: AbortSignal;
  },
): Promise<AngleRun & { fullText: string }> {
  const prompt =
    backend === "parallel"
      ? `${ctx.fallbackLine}${ctx.priorBlock}${a.prompt}`
      : `${ctx.fallbackLine}${ctx.priorBlock}${wigoloAnglePrompt(a, surfaceForAngle(a.name), reason ?? "unparseable")}`;
  let r: Awaited<ReturnType<ResearchDispatchFn>>;
  try {
    r = await dispatch(
      pi,
      { role: "explore", prompt, cwd: ctx.repoRoot },
      {
        label: `research-${a.name}`.slice(0, 24),
        timeoutMs: RESEARCH_DISPATCH_TIMEOUT_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        extraArgs: RESEARCH_EXTRA_ARGS,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace(`research-driver: dispatch rejected for ${a.name}: ${msg}`);
    return {
      name: a.name,
      ok: false,
      summary: `dispatch rejected: ${msg}`,
      claims: [],
      backend,
      failure: msg,
      fullText: `dispatch rejected: ${msg}`,
    };
  }
  const claims: ResearchClaim[] = extractResearchClaims(r.toolUses, a.name);
  // #893 — raw count of report_research_claim toolUses (schema-valid or not),
  // keyed off `name` only, distinct from the post-extraction `claims.length`.
  // Zero raw calls = the reporter tool was never called (possibly never
  // loaded); >0 with zero valid claims = the calls were schema-invalid or
  // prose-only.
  const rawCalls = (r.toolUses ?? []).filter((tu) => {
    if (!tu || typeof tu !== "object") return false;
    return (tu as { name?: string }).name === "report_research_claim";
  }).length;
  const ok = r.ok && !r.errorStop && claims.length > 0;
  return {
    name: a.name,
    ok,
    summary: r.text.trim().slice(0, 500),
    claims,
    backend,
    failure: ok
      ? undefined
      : !r.ok
        ? "dispatch failed or timed out"
        : r.errorStop
          ? "provider error mid-stream"
          : rawCalls === 0
            ? "0 report_research_claim calls — reporter may not have loaded (check pi version / --extension)"
            : "returned no structured claims",
    rawClaimCalls: rawCalls,
    fullText: r.text,
  };
}
