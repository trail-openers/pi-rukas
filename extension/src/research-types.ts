/**
 * research-types — shared types for the compiled /research pipeline.
 *
 * The landscape review (outputs/research-driver-landscape.md) found every
 * serious research harness runs plan → budgeted parallel retrieval →
 * explicit verification → durable cited artifact + provenance, while the
 * old /research prose body had only the retrieval step. The driver compiles
 * that deterministic spine (the "light compiled driver" verdict, §4) and
 * leaves judgement — which angles, and the conversation after the artifact —
 * with PM.
 *
 * Single-declaration convention (the plan-driver house pattern): the halt
 * reason union lives here and is referenced by the result type, so a member
 * added on either side is forced onto the other.
 */
import type { PlanPhaseTiming } from "./plan-types.ts";
import { RESEARCH_CLAIM_KINDS } from "./research-reporter.ts";

/**
 * PR-1 ships quick + standard; deep (entailment pass) and adoption
 * (decision-memo mode) land in the follow-up PR and extend this union.
 */
export const RESEARCH_TIERS = ["quick", "standard"] as const;
export type ResearchTier = (typeof RESEARCH_TIERS)[number];

export type ResearchClaimKind = (typeof RESEARCH_CLAIM_KINDS)[number];

/**
 * Verification outcome attached to a claim by the DRIVER (never by the
 * child): url-liveness for url sources, code-grounding (against the pinned
 * commit) for code sources, unchecked for everything else. Deterministic
 * checks only in the standard tier — the report's FaithJudge caveat (<72%
 * F1) is why LLM entailment is deep-tier-only and explicit, never a silent
 * quality claim.
 */
export type ClaimVerification =
  | { check: "url-liveness"; status: "live" | "dead" | "unreachable" }
  | { check: "code-grounding"; status: "grounded" | "ungrounded" }
  | { check: "none"; status: "unchecked" };

export interface ResearchClaim {
  kind: ResearchClaimKind;
  text: string;
  /** URL, `path#symbol` / repo path, doc reference, or "none". */
  source: string;
  sourceKind: "url" | "code" | "doc" | "none";
  /** The SOURCE's date when the child could determine it (RFC3339 or year). */
  sourceDate?: string;
  confidence: "high" | "medium" | "low";
  /**
   * Staleness class (HoH: one outdated passage → ≥20% accuracy drop, so
   * fast-changing facts must be re-verified on reuse): library versions,
   * benchmark numbers, maintainer facts are fast-moving; algorithms and
   * shipped history are stable.
   */
  staleness: "stable" | "fast-moving";
  angle: string;
  verification: ClaimVerification;
}

export interface AngleRun {
  name: string;
  ok: boolean;
  /** The child's short prose summary (the claims are the record). */
  summary: string;
  claims: ResearchClaim[];
}

/** Reasons the pipeline halted without an artifact. */
export type ResearchHaltReason = "no-structured-claims" | "artifact-write-failed";

export interface ResearchMemoryOutcome {
  outcome: "written" | "superseded" | "skipped" | "error";
  id?: string;
  detail?: string;
}

export interface ResearchDriverInput {
  topic: string;
  tier?: ResearchTier;
  /** PM-supplied angle prompts (judgement stays with PM); default derived. */
  angles?: string[];
  context?: string;
}

export interface ResearchResult {
  topic: string;
  tier: ResearchTier;
  artifactPath?: string;
  provenancePath?: string;
  angles: AngleRun[];
  claims: ResearchClaim[];
  /** git rev-parse HEAD at verification time; "unknown" when unresolvable. */
  pinnedCommit: string;
  memory: ResearchMemoryOutcome;
  /**
   * Abstention (report open question 5): zero VERIFIED findings still
   * writes an honest "here is what was checked" artifact — accuracy-only
   * scoring rewards confident fabrication, so the honest empty result is a
   * first-class outcome, not an error.
   */
  abstained: boolean;
  halt?: { reason: ResearchHaltReason; detail: string };
  timings: PlanPhaseTiming[];
}

const CONFIDENCES = ["high", "medium", "low"] as const;
const STALENESS = ["stable", "fast-moving"] as const;
const SOURCE_KINDS = ["url", "code", "doc", "none"] as const;

/**
 * Extract report_research_claim calls from a child's toolUses (the
 * structured record — the prose reply is only a summary). Mirrors
 * extractPlanItems: schema-invalid items are dropped, never guessed at.
 */
export function extractResearchClaims(toolUses: unknown[], angleName: string): ResearchClaim[] {
  const out: ResearchClaim[] = [];
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "report_research_claim" || !t.arguments || typeof t.arguments !== "object")
      continue;
    const a = t.arguments as Record<string, unknown>;
    const kind = typeof a.kind === "string" ? a.kind : "";
    if (!(RESEARCH_CLAIM_KINDS as readonly string[]).includes(kind)) continue;
    const text = typeof a.text === "string" ? a.text.trim() : "";
    if (!text) continue;
    const sourceKind =
      typeof a.sourceKind === "string" && (SOURCE_KINDS as readonly string[]).includes(a.sourceKind)
        ? (a.sourceKind as ResearchClaim["sourceKind"])
        : "none";
    const source = typeof a.source === "string" && a.source.trim() ? a.source.trim() : "none";
    const confidence =
      typeof a.confidence === "string" && (CONFIDENCES as readonly string[]).includes(a.confidence)
        ? (a.confidence as ResearchClaim["confidence"])
        : "low";
    const staleness =
      typeof a.staleness === "string" && (STALENESS as readonly string[]).includes(a.staleness)
        ? (a.staleness as ResearchClaim["staleness"])
        : "fast-moving";
    const sourceDate =
      typeof a.sourceDate === "string" && a.sourceDate.trim() ? a.sourceDate.trim() : undefined;
    const angle = typeof a.angle === "string" && a.angle.trim() ? a.angle.trim() : angleName;
    out.push({
      kind: kind as ResearchClaimKind,
      text,
      source,
      sourceKind: source === "none" ? "none" : sourceKind,
      sourceDate,
      confidence,
      staleness,
      angle,
      verification: { check: "none", status: "unchecked" },
    });
  }
  return out;
}
