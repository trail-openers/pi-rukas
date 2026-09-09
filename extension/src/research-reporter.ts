/**
 * Companion Pi extension loaded into each /research angle child.
 *
 * Registers a single `report_research_claim` tool with a TypeBox-validated
 * schema. Each angle specialist calls it ONCE per structured claim; Pi
 * validates the params in-process and the parent (research-types.ts:
 * extractResearchClaims) reads every call from the child's tool_use events.
 * Same pattern and rationale as report_plan_item (plan-reporter.ts),
 * report_finding (lens review) and report_policy (#407): a schema-validated
 * tool call has no text to parse, so the prose-line-splitting defect class
 * cannot exist.
 *
 * The field set implements the landscape report's per-finding contract
 * (claim / source / confidence / support / staleness — outputs/
 * research-driver-landscape.md §Executive summary 5.2): every claim carries
 * its source and a staleness class, so the driver can verify deterministically
 * (URL liveness, commit-pinned code grounding) and the artifact can date what
 * it asserts.
 *
 * No execution logic — acknowledging the call is enough. Loaded via
 * `pi --no-extensions --extension <path-to-this-file>`; never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const RESEARCH_CLAIM_KINDS = ["finding", "contradiction", "gap", "signal"] as const;

interface ResearchClaimInput {
  kind: string;
  text: string;
  source: string;
  sourceKind: string;
  sourceDate?: string;
  confidence: string;
  staleness: string;
  angle?: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_research_claim",
    label: "Report Research Claim",
    description:
      "Report ONE structured research claim. Call once per claim — do not batch. The claim goes in `text` (one complete, self-contained sentence); every claim MUST name its source. Do NOT emit claims as prose lists or JSON in your reply; only these tool calls count.",
    parameters: Type.Object({
      kind: Type.Union(
        RESEARCH_CLAIM_KINDS.map((k) => Type.Literal(k)),
        {
          description:
            "finding (a fact you established, with its source), contradiction (two sources disagree — name both in text), gap (a question you could not answer reliably), signal (a named metric for an adoption decision, e.g. an OpenSSF Scorecard score or release cadence).",
        },
      ),
      text: Type.String({
        description:
          "The claim — one complete, self-contained sentence (no bullets, no preamble). For a contradiction, state both sides and their sources.",
      }),
      source: Type.String({
        description:
          "Where this claim is checkable: a full URL, a repo path (optionally `path#symbol` for a code claim), a doc reference (library@version page), or the literal string 'none' when no source exists (prefer kind 'gap' in that case).",
      }),
      sourceKind: Type.Union(
        [Type.Literal("url"), Type.Literal("code"), Type.Literal("doc"), Type.Literal("none")],
        {
          description:
            "url = web source (the driver checks liveness); code = this repo's code (the driver checks the path/symbol exists at the pinned commit); doc = versioned library docs; none = unsourced.",
        },
      ),
      sourceDate: Type.Optional(
        Type.String({
          description:
            "The SOURCE's publication/update date when you can determine it (RFC3339 date or a year). Omit when unknown — never guess.",
        }),
      ),
      confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
        description:
          "high = directly verified in the source; medium = single credible source; low = inferred or secondhand.",
      }),
      staleness: Type.Union([Type.Literal("stable"), Type.Literal("fast-moving")], {
        description:
          "fast-moving = likely to change with releases (versions, benchmark numbers, maintainer/pricing facts, API surfaces); stable = unlikely to change (algorithms, published history, shipped decisions).",
      }),
      angle: Type.Optional(
        Type.String({
          description: "The research angle that produced this claim; omit if not applicable.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as unknown as ResearchClaimInput;
      return {
        content: [
          {
            type: "text",
            text: `recorded research claim (${params.kind}): ${String(params.text ?? "").slice(0, 120)}`,
          },
        ],
        details: { ...params, angle: params.angle ?? "" },
      };
    },
  });
}
