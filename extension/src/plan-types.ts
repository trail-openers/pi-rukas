/**
 * plan-types — the shared types and phase-0 primitives for the compiled
 * /plan pipeline. Split out of plan-driver.ts to keep each module under the
 * 500-line hard limit (AGENTS.md §12). Phase 0 (classify + title) lives here
 * because it is pure, stateless, and consumed by both the driver and the
 * tests.
 *
 * The `FilingFailure` type is a type-only import from plan-filing.ts —
 * erased at compile time, so no runtime edge between the two modules.
 */
import type { FilingFailure } from "./plan-filing.ts";

export const PLAN_TYPES = ["bug", "feature", "epic", "chore", "spike"] as const;
export type PlanType = (typeof PLAN_TYPES)[number];

/**
 * The spec depth at which epic sub-issues stop getting a full spec. At
 * depth >= EPIC_SUB_ISSUE_DEPTH_LIMIT a sub-issue is filed with a minimal
 * body (task + acceptance criteria + out-of-scope) plus a note telling the
 * operator to run `start_plan_driver` on the descriptor for the full spec.
 * Tracked as an internal counter — never a schema parameter — so a
 * misaligned client cannot recurse the depth past the cap.
 */
export const EPIC_SUB_ISSUE_DEPTH_LIMIT = 3;

export interface PlanGap {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  description: string;
  resolution: string;
  /**
   * Bug 3 (#606): whether this gap is still open. Gaps carried into a
   * round-2 re-draft's Open Questions section are re-reviewed against the
   * revised spec — they render as `status: resolved` there — while fresh
   * findings from the reviewer stay `pending`.
   */
  status?: "pending" | "resolved";
}

export interface PlanResult {
  type: PlanType;
  title: string;
  spec: string;
  gaps: PlanGap[];
  priorContext: { source: string; fact: string }[];
  filed: boolean;
  issueUrl?: string;
  capHit?: boolean;
  /**
   * D1: the ACTUAL reason the gap gate stopped, so the operator-visible
   * text names the cause instead of claiming "unresolved CRITICAL/HIGH gaps
   * remain" when a MEDIUM-only NEEDS_ITERATION verdict burned the rounds.
   * `residual-medium-low` (D2: routed to filing with disclosure) vs
   * `unresolved-blocking` (not filed, surfaced) vs `verdict-absent` (D3: the
   * reviewer never wrote a verdict line; MEDIUM/LOW-only, so READY was
   * acceptable but the absence is recorded) vs `gate-unavailable` (the
   * gap-gate dispatch itself failed, so no reviewer ever saw the spec —
   * not filed, surfaced, matching the all-angles-failed halt).
   */
  capReason?: "residual-medium-low" | "unresolved-blocking" | "verdict-absent" | "gate-unavailable";
  /**
   * D7: a DISCRIMINATED filing failure (or deliberate skip) carried on the
   * result so the operator-visible text can say WHY the issue did not file
   * — forge-unresolved / create-error (detail carries the forge stderr) /
   * empty-url / cap-surface (the gap-gate cap routed to surface, so the
   * spec was not filed BY POLICY — nothing failed) / gate-unavailable
   * (the gap-gate dispatch itself failed, so no reviewer ever saw the spec)
   * — instead of the generic "filing failed or was blocked".
   *
   * The reason union is declared once in plan-filing.ts (FilingFailure) and
   * referenced here — a member added on the filing side is forced onto this
   * type, and vice versa.
   */
  filingFailure?: FilingFailure;
}

export interface PlanDriverInput {
  descriptor: string;
  type?: PlanType;
  context?: string;
  dryRun?: boolean;
  /** Internal: epic recursion depth. Never agent-settable. */
  depth?: number;
}

// ---------------------------------------------------------------------------
// Phase 0 — classify
// ---------------------------------------------------------------------------

const TYPE_TRIGGER_WORDS: Record<PlanType, RegExp> = {
  bug: /\b(broken|breaks|failing?|error|fail|doesn'?t work|does not work|regression)\b/i,
  feature: /\b(add|support|implement|introduce|feature)\b/i,
  epic: /\b(epic|overhaul|redesign|multi-?issue)\b/i,
  chore: /\b(chore|refactor|rename|bump|tidy|cleanup)\b/i,
  spike: /\b(spike|investigate|research|feasib\w*)\b/i,
};

export function classifyPlanType(descriptor: string, param?: PlanType): PlanType {
  if (param && (PLAN_TYPES as readonly string[]).includes(param)) return param;
  for (const t of PLAN_TYPES) {
    if (TYPE_TRIGGER_WORDS[t].test(descriptor)) return t;
  }
  return "feature";
}

const TITLE_PREFIX: Record<PlanType, string> = {
  bug: "Bug: ",
  feature: "feat: ",
  epic: "EPIC: ",
  chore: "chore: ",
  spike: "research: ",
};

export function planTitle(descriptor: string, type: PlanType): string {
  const d = descriptor.trim().replace(/\s+/g, " ");
  const first = d.split(/\s+/).slice(0, 8).join(" ");
  const clipped = d.length > 64 ? `${first.slice(0, 63)}…` : first;
  return `${TITLE_PREFIX[type]}${clipped}`;
}
