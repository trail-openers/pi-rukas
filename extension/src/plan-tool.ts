/**
 * plan-tool — the compiled `start_plan_driver` tool.
 *
 * `/plan` used to be a 473-line prose body sent into PM's context, which PM
 * then executed by hand — with a self-judged "triviality test" and no gate
 * between that self-judgment and `gh issue create`. The fix follows the
 * `start_work_driver` precedent (work-tool.ts): a compiled driver PM calls
 * instead of a prose flow PM re-implements, plus the mode-independent
 * issue-creation guard (issue-creation-guard.ts) that makes the replacement
 * safe by closing every other door.
 *
 * The driver (plan-driver.ts) runs the five-phase pipeline:
 *
 *   Phase 0  Classify   regex on the descriptor (or the `type` param)
 *   Phase 1  Inventory  vipune + `gh issue list` run by the driver; one
 *                       explore dispatch for duplicate risk
 *   Phase 2  Investigate type-specialised explore angles in parallel
 *   Phase 3  Draft      the driver assembles the structured body
 *   Phase 4  Gap gate   one adversarial-developer dispatch; CRITICAL/HIGH
 *                       get one corrective pass, then the residual gaps
 *                       travel with the spec (cap hit, no loop)
 *   Phase 5  File       `gh issue create --body-file` via execp
 *
 * **dryRun is the confirmation seam.** `dryRun: true` returns
 * `{ spec, gaps, priorContext, filed: false }` without filing; PM shows the
 * spec + gap disposition to the operator; on confirmation the driver is
 * re-called with `dryRun` omitted and files. Non-resumable by design (a
 * 2-5 minute flow; re-running is cheaper than a state file).
 *
 * The driver's own filing is a child-process exec — exempt from the
 * tool_call guard by construction, exactly like the work driver's
 * mechanized `gh pr create`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runPlanPipeline } from "./plan-driver.ts";
import type { PlanResult } from "./plan-types.ts";
import { trace } from "./trace.ts";
import { resolveRepoRoot } from "./work-entry.ts";

export function registerPlanTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_plan_driver",
    label: "Start /plan Driver",
    description:
      "Run the compiled /plan pipeline (classify → inventory → type-specialised investigation → draft → adversarial gap gate → file) and file the resulting GitHub issue. This is the ONLY way to create a GitHub issue: direct `gh issue create` (and `gh api` POST to the issues collection) is structurally refused for every role in every mode — the refusal names this tool. Call with dryRun:true FIRST to return { spec, gaps, priorContext, filed:false } without filing; show the spec + gap dispositions to the operator, and on their confirmation re-call with dryRun omitted to file. The result includes issueUrl on success. Epic sub-issues at depth >= 3 get a minimal body with a depth-limit note. Gap gate: PI_ENSEMBLE_PLAN_GAP_GATE=0 skips it for chore/spike types only. Non-resumable: a failed run is re-run, not resumed.",
    parameters: Type.Object({
      descriptor: Type.String({
        description: "Ticket descriptor — one or two sentences describing the intended change.",
      }),
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("bug"),
            Type.Literal("feature"),
            Type.Literal("epic"),
            Type.Literal("chore"),
            Type.Literal("spike"),
          ],
          {
            description:
              "Override the type classification (default: inferred from the descriptor).",
          },
        ),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "Prior /research findings or session facts to treat as established (not re-investigated).",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "Return the structured spec + gap dispositions WITHOUT filing. Call first; on operator confirmation, re-call with dryRun omitted.",
        }),
      ),
    }),
    async execute(_id, raw, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = raw as {
        descriptor: string;
        type?: "bug" | "feature" | "epic" | "chore" | "spike";
        context?: string;
        dryRun?: boolean;
      };
      if (!params.descriptor || params.descriptor.trim().length === 0) {
        return {
          content: [{ type: "text", text: "start_plan_driver requires a non-empty descriptor." }],
          details: { started: false },
        };
      }
      const repoRoot = await resolveRepoRoot(ctx.cwd);
      trace(
        `start_plan_driver → descriptor="${params.descriptor.slice(0, 60)}" type=${params.type ?? "inferred"} dryRun=${!!params.dryRun} repoRoot=${repoRoot}`,
      );
      try {
        const result = await runPlanPipeline(pi, params, repoRoot);
        return {
          content: [
            {
              type: "text",
              text: renderPlanResult(result, params.dryRun === true),
            },
          ],
          details: resultDetails(result, params.dryRun === true),
        };
      } catch (err) {
        trace(`start_plan_driver failed: ${(err as Error).message}`);
        return {
          content: [
            {
              type: "text",
              text: `start_plan_driver failed: ${(err as Error).message}`,
            },
          ],
          details: { started: false, error: (err as Error).message },
        };
      }
    },
  });
}

function renderPlanResult(r: PlanResult, dryRun: boolean): string {
  const head = dryRun
    ? "PLAN DRY-RUN (nothing filed). Show this spec to the operator; on their confirmation re-call start_plan_driver with dryRun omitted to file."
    : r.filed
      ? `PLAN FILED — ${r.issueUrl}`
      : "PLAN COMPLETED — filing failed or was blocked; see details. The spec below is still valid to review.";
  const gaps =
    r.gaps.length > 0
      ? r.gaps.map((g) => `- [${g.severity}] ${g.description} → ${g.resolution}`).join("\n")
      : "- (none)";
  const prior =
    r.priorContext.length > 0
      ? r.priorContext
          .slice(0, 10)
          .map((p) => `- [${p.source}] ${p.fact}`)
          .join("\n")
      : "- (none — cold start)";
  const cap = r.capHit
    ? "\n\nGAP GATE CAP HIT: after the iteration cap, unresolved CRITICAL/HIGH gaps remain. They are listed below and must be resolved with the operator before /work."
    : "";
  return `${head}

Title: ${r.title}
Type: ${r.type}

=== SPEC (the issue body) ===
${r.spec}

=== GAP DISPOSITIONS ===
${gaps}

=== PRIOR CONTEXT ATTRIBUTION ===
${prior}${cap}`;
}

function resultDetails(r: PlanResult, dryRun: boolean): Record<string, unknown> {
  const d: Record<string, unknown> = {
    started: true,
    type: r.type,
    title: r.title,
    filed: r.filed,
    dryRun,
    gapCount: r.gaps.length,
    capHit: r.capHit ?? false,
  };
  if (r.issueUrl) d.issueUrl = r.issueUrl;
  return d;
}
