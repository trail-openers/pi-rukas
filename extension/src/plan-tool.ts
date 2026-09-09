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
 *   Phase 4  Gap gate   one adversarial-developer dispatch; CRITICAL gets
 *                       one corrective pass (CRITICAL-only terminal rule,
 *                       #664 transposed — HIGH/MEDIUM/LOW never re-draft),
 *                       then the residual findings travel with the spec
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
import { truncateForDisclosure } from "./plan-gaps.ts";
import type { PlanResult } from "./plan-types.ts";
import { trace } from "./trace.ts";
import { resolveRepoRoot } from "./work-entry.ts";

export function registerPlanTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_plan_driver",
    label: "Start /plan Driver",
    description:
      "Run the compiled /plan pipeline (classify → inventory → type-specialised investigation → draft → adversarial gap gate → file) and file the resulting GitHub issue. This is the ONLY way to create a GitHub issue: direct `gh issue create` (and `gh api` POST to the issues collection) is structurally refused for every role in every mode — the refusal names this tool. Call with dryRun:true FIRST to return { spec, gaps, priorContext, filed:false } without filing; show the spec + gap dispositions to the operator, and on their confirmation re-call with dryRun omitted to file. The result includes issueUrl on success. Epic sub-issues at depth >= 3 get a minimal body with a depth-limit note. Gap gate: runs for bug/feature/epic; chore/spike get deterministic validation only. A too-thin descriptor (below the word floor, no code identifier, no context) returns needs-clarification questions without dispatching anything — answer them and re-call. Non-resumable: a failed run is re-run, not resumed.",
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
  // The head must NEVER invite filing a halted draft (vipune fixture run,
  // C1: a draft-invalid halt on a dryRun rendered as a clean pass and the
  // head said "re-call with dryRun omitted to file" — the session read it
  // as the gate approving a spec with zero acceptance criteria). Any
  // filingFailure means the spec is not fileable as-is, dryRun or not.
  const halted = !r.filed && !!r.filingFailure;
  const head = halted
    ? `PLAN ${dryRun ? "DRY-RUN — " : ""}NOT FILEABLE AS-IS (${r.filingFailure?.reason}). Nothing was filed${dryRun ? ", and re-calling without dryRun would NOT file this spec either" : ""} — see the FILING STATUS section below before showing this to the operator.`
    : dryRun
      ? "PLAN DRY-RUN (nothing filed). Show this spec to the operator; on their confirmation re-call start_plan_driver with dryRun omitted to file."
      : r.filed
        ? `PLAN FILED — ${r.issueUrl}`
        : "PLAN COMPLETED — filing failed or was blocked; see the FILING STATUS section below. The spec is still valid to review.";
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
  // D1: the cap message names the ACTUAL cause (discriminated capReason),
  // instead of the old "unresolved CRITICAL/HIGH gaps remain" which was
  // false when a MEDIUM-only NEEDS_ITERATION verdict burned the rounds.
  // #664 transposed: the terminal rule is CRITICAL-only — residual-high
  // (HIGH findings travel in the disclosure) and residual-medium-low both
  // mean the spec FILED; only unresolved-blocking (CRITICAL remains) does
  // not.
  // Adversarial follow-up: the wording is round-count-agnostic. The no-op
  // round elimination means a MEDIUM-only or HIGH-only NEEDS_ITERATION
  // terminates after a SINGLE dispatch — the old text claimed "the
  // reviewer asked for another iteration" / "fresh findings each round",
  // both false when one round ran. Lead with the load-bearing fact (the
  // spec WAS filed), same defect class D1 fixed. The inline list uses the
  // UNION (residualForDisclosure) to match the filed body's residual
  // section, which also uses the union — the old last-round-only list
  // could omit a round-1 finding the body discloses (2-round
  // CRITICAL-then-HIGH case).
  // The old `&& r.gaps.length > 0` guard made gate-unavailable — whose
  // parse yields ZERO gaps — invisible on a dryRun. capHit alone earns the
  // block (vipune fixture run, C1 follow-up).
  let cap = "";
  if (r.capHit) {
    // The inline list renders the SAME union as the filed body's residual
    // section, through the SAME single truncation (truncateForDisclosure) —
    // the two render sites cannot drift (lens review, PR #637 finding 1;
    // the PERFORMANCE lens flagged the drift risk specifically).
    const residual = (r.residualForDisclosure ?? [])
      .map((g) => `[${g.severity}] ${truncateForDisclosure(g.description)}`)
      .join(", ");
    if (r.capReason === "unresolved-blocking") {
      cap =
        "\n\nGAP GATE CAP HIT: after the iteration cap, unresolved CRITICAL gaps remain. They are listed below and must be resolved with the operator before /work. (HIGH findings no longer block filing — they travel in the residual disclosure instead; only CRITICAL stops the gate.)";
    } else if (r.capReason === "residual-high") {
      cap = `\n\nGAP GATE CAP HIT: the reviewer returned HIGH findings alongside MEDIUM/LOW items (${residual}); with no CRITICAL gap the spec is FILED with the residual findings disclosed in the issue body (see '## Residual gap-gate findings'). HIGH findings travel in that disclosure — the terminal rule is CRITICAL-only.`;
    } else if (r.capReason === "residual-medium-low") {
      cap = `\n\nGAP GATE CAP HIT: the reviewer returned only MEDIUM/LOW findings (${residual}); with no CRITICAL gap the spec is FILED with the residual findings disclosed in the issue body (see '## Residual gap-gate findings').`;
    } else if (r.capReason === "verdict-absent") {
      cap =
        "\n\nGAP GATE NOTE: the reviewer never wrote a verdict line; no CRITICAL gap was found, so the spec proceeded — but the absence is recorded here (the gate did not explicitly say READY).";
    } else if (r.capReason === "gate-unavailable") {
      cap =
        "\n\nGAP GATE UNAVAILABLE: the gap-gate dispatch itself failed, so no reviewer ever saw the spec. It was NOT filed — the spec above is still valid to review, but re-run start_plan_driver after the gate failure is addressed (see the FILING STATUS below).";
    } else {
      cap = "\n\nGAP GATE CAP HIT: the iteration cap was reached. See the gap dispositions below.";
    }
  }
  // D7: the filing failure reason is DISCRIMINATED and surfaced — the
  // forge stderr (when there is one) reaches the operator without
  // PI_ENSEMBLE_DEBUG. Rendered on dryRun too (C1): the halt reasons are
  // set BEFORE filing would happen, and hiding them behind !dryRun is what
  // made a rejected draft look like a clean pass.
  let filingStatus = "";
  if (!r.filed && r.filingFailure) {
    const f = r.filingFailure;
    if (
      f.reason === "cap-surface" ||
      f.reason === "gate-unavailable" ||
      f.reason === "needs-clarification" ||
      f.reason === "draft-invalid"
    ) {
      // Deliberate skip (not a failure): the cap routed to surface (a
      // CRITICAL gap remains — CRITICAL-only blocks, #664 transposed; HIGH
      // findings travel in the residual disclosure instead), the gap gate
      // never ran (no reviewer saw the spec — re-run after the gate failure
      // is addressed), the deterministic precheck asked for clarification
      // before any dispatch, or the drafted body failed deterministic
      // validation. The spec is not filed by policy; no forging happened.
      filingStatus = `\n\n=== FILING STATUS ===\nNot filed (by policy): ${f.detail}`;
    } else {
      filingStatus = `\n\n=== FILING STATUS ===\nFiling did not complete. Reason: ${f.reason}${f.detail ? ` — ${f.detail}` : ""}. The spec above is still valid to review and can be re-run after the cause is addressed.`;
    }
  }
  // Failed investigation angles surface HERE too, not only inside the spec
  // body — the operator must see the hole without reading the whole draft.
  const investigation =
    r.failedAngles && r.failedAngles.length > 0
      ? `\n\n=== INVESTIGATION STATUS ===\n${r.failedAngles.length} angle(s) FAILED — their surface is uninvestigated:\n${r.failedAngles.map((a) => `- ${a.name}: ${a.detail}`).join("\n")}`
      : "";
  const timingsLine =
    r.timings && r.timings.length > 0
      ? `\n\n=== TIMINGS ===\n${r.timings.map((t) => `${t.phase} ${fmtMs(t.ms)}`).join(" · ")}`
      : "";
  return `${head}

Title: ${r.title}
Type: ${r.type}

=== SPEC (the issue body) ===
${r.spec}

=== GAP DISPOSITIONS ===
${gaps}

=== PRIOR CONTEXT ATTRIBUTION ===
${prior}${investigation}${cap}${filingStatus}${timingsLine}`;
}

/** Human-readable duration: sub-minute in seconds, else m+s. */
function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
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
    residualForDisclosure: r.residualForDisclosure,
  };
  if (r.issueUrl) d.issueUrl = r.issueUrl;
  if (r.capReason) d.capReason = r.capReason;
  if (r.filingFailure) d.filingFailure = r.filingFailure;
  if (r.failedAngles) d.failedAngles = r.failedAngles;
  if (r.timings) d.timings = r.timings;
  return d;
}
