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
 * quick = 1 angle + liveness; standard = derived angle set + full
 * deterministic verification; deep = standard + ONE scoped LLM entailment
 * pass (explicit, never silent — FaithJudge <72% F1); adoption = the
 * OSS-adoption decision-memo mode (fixed signal/alternatives/fit angles +
 * a synthesis child whose recommendation is embedded in the memo artifact).
 */
export const RESEARCH_TIERS = ["quick", "standard", "deep", "adoption"] as const;
export type ResearchTier = (typeof RESEARCH_TIERS)[number];

/** Deep-tier entailment verdict for one claim (absent = never judged). */
export type ClaimSupport = "full" | "partial" | "none" | "unreachable";

export type ResearchClaimKind = (typeof RESEARCH_CLAIM_KINDS)[number];

/**
 * The DERIVED source kind — what the source CONTENT is (http(s) → url;
 * a path inside the repo → code; an absolute/~/. path outside it → local;
 * an external repo → external-code; anything else → doc), as opposed to
 * the child's self-reported sourceKind, which is kept verbatim on the
 * claim. Content wins: a URL the child labelled "code" is still a URL.
 */
export type SourceKindDerived = "url" | "code" | "local" | "external-code" | "doc";

/** One part of a compound source: its own derived kind and check status. */
export interface VerificationPart {
  source: string;
  kind: SourceKindDerived;
  status: string;
}

/**
 * Verification outcome attached to a claim by the DRIVER (never by the
 * child). Deterministic checks only in the standard tier — the report's
 * FaithJudge caveat (<72% F1) is why LLM entailment is deep-tier-only and
 * explicit, never a silent quality claim.
 *
 * url-liveness: any http(s) source (liveness-checked; compound sources
 * carry the best part status — live if any part is live, unreachable if
 * none is live and any is unreachable, dead otherwise — with `parts`
 * recording each part so the provenance sidecar can print them from claim
 * data alone; the liveness cap marks excess parts `skipped-cap`, which
 * never promote the status).
 * code-grounding: a repo-relative path, checked at the PINNED commit
 * (path present in the tree; a symbol present IN THAT FILE at that
 * commit).
 * local-file: an absolute/home-relative/./ path outside the repo, checked
 * by stat — never fetched.
 * none: no deterministic check applies (doc references, "none"), or the
 * check could not run (an external repo with no checkable URL, an
 * unknown pinned commit). The `reason` says why, so "no check applies"
 * stays distinguishable from "the check could not be run".
 */
export type ClaimVerification =
  | {
      check: "url-liveness";
      status: "live" | "dead" | "unreachable" | "skipped-cap";
      parts?: VerificationPart[];
    }
  | { check: "code-grounding"; status: "grounded" | "ungrounded"; parts?: VerificationPart[] }
  | { check: "local-file"; status: "local-present" | "local-missing"; parts?: VerificationPart[] }
  | {
      check: "none";
      status: "unchecked" | "skipped-cap";
      reason?: string;
      parts?: VerificationPart[];
    };

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
  /**
   * Deep tier only: does the cited source actually support the claim?
   * Annotation, never a silent upgrade — a "none" additionally excludes
   * the finding from the abstention count (a claim its own source does not
   * support is not a verified finding).
   */
  support?: ClaimSupport;
}

export interface AngleRun {
  name: string;
  ok: boolean;
  /** The child's short prose summary (the claims are the record). */
  summary: string;
  claims: ResearchClaim[];
  /**
   * Which backend produced this angle's claims (the driver previously had
   * no idea — #773): `parallel` (the default, the baked-in recipe) or
   * `wigolo` (the one-shot fallback re-dispatch after a classified
   * Parallel failure). Rendered in the angle summaries.
   */
  backend: "parallel" | "wigolo";
  /**
   * Why the angle failed (always set when `ok` is false): "dispatch
   * failed or timed out", "provider error mid-stream", "0
   * report_research_claim calls — reporter may not have loaded (check pi
   * version / --extension)", "returned no structured claims", or the
   * dispatch rejection's message. Rendered in the angle summaries (mirrors
   * plan-investigate.ts's failure strings).
   */
  failure?: string;
  /**
   * Raw count of `report_research_claim` toolUses on the child (schema-
   * valid or not). #893: keys the per-angle "reporter may not have loaded"
   * diagnostic and the whole-run `reporter-silent` halt off the RAW call
   * count, not the post-extraction `claims.length`, so a schema-invalid
   * child is told apart from a child that never had the tool.
   */
  rawClaimCalls?: number;
}

/**
 * Reasons the pipeline halted without an artifact. `no-structured-claims`
 * is the schema-invalid / prose-only case (the child made tool calls that
 * did not parse, or made none at all but NOT every angle was silent);
 * `reporter-silent` is the raw zero-calls case (no angle ever called the
 * reporter at all — the channel, not the child's output, is suspect);
 * `reporter-missing` is the pre-spawn stat failure (the reporter extension
 * path does not exist — no angle was ever dispatched).
 */
export type ResearchHaltReason =
  | "no-structured-claims"
  | "reporter-silent"
  | "reporter-missing"
  | "artifact-write-failed";

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
  /** Deep tier: whether the entailment pass ran ("unavailable" = dispatch failed; claims stay unannotated). */
  entailment?: "ran" | "unavailable";
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
