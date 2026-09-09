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
import type { GapGateLoopCapReason } from "./plan-gaps.ts";

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
  // #639 DECISION B: the old optional `status` field ("pending" | "resolved",
  // Bug 3 #606) is DELETED. It had ZERO consumers: the only writer was the
  // gap-gate loop's `{ ...g, status: "resolved" }` copy, and the only
  // "reader" was a string-prefix regex on the rendered question — nothing
  // ever read the field. The copy-on-carry invariant that readonly existed to
  // express (the spread-copy in runGapGateLoop) existed ONLY to protect this
  // field, so deleting it makes the invariant unnecessary rather than
  // losing it. Resolved-decision rendering now comes from the structured
  // `resolvedDecisions` parameter to draftSpec (plan-writeback.ts), never
  // from a field on the gap itself.
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
   * The residual union (non-blocking findings across ALL gate rounds,
   * deduped) that the filed body's "## Residual gap-gate findings" section
   * discloses. Carried separately from `gaps` (the LAST round's gaps) so
   * the operator-visible cap message in plan-tool.ts can list the SAME
   * union as the filed body — with the old last-round list, a 2-round
   * CRITICAL-then-HIGH run disclosed the round-1 HIGH in the body but not
   * in the inline cap message. Present only when a residual disclosure
   * was written.
   */
  residualForDisclosure?: PlanGap[];
  /**
   * D1: the ACTUAL reason the gap gate stopped, so the operator-visible
   * text names the cause instead of the old message — "the reviewer asked
   * for another iteration over MEDIUM/LOW items ... the iteration cap was
   * reached" — which the no-op round elimination made false: a MEDIUM-only
   * NEEDS_ITERATION now terminates on a SINGLE dispatch, so neither a
   * second iteration was asked for nor the cap reached.
   * `residual-medium-low` (D2: routed to filing with disclosure, nothing
   * above LOW survived) vs `residual-high` (routed to filing with the
   * residual HIGH findings disclosed — #664 transposed: HIGH no longer
   * blocks, it travels) vs `unresolved-blocking` (a CRITICAL gap remains;
   * CRITICAL-only blocks, HIGH findings travel) vs `verdict-absent` (D3: the
   * reviewer never wrote a verdict line; HIGH/MEDIUM/LOW-only, so READY was
   * acceptable but the absence is recorded) vs `gate-unavailable` (the
   * gap-gate dispatch itself failed, so no reviewer ever saw the spec —
   * not filed, surfaced, matching the all-angles-failed halt).
   *
   * Declared ONCE in plan-gaps.ts (`GapGateLoopCapReason`) and referenced
   * here — a member added on the gap-gate side is forced onto this type,
   * and vice versa (the same single-declaration convention plan-filing.ts
   * carries for FilingFailure; lens review, PR #637 finding 2 — before
   * it, the two unions were structurally identical copies with nothing
   * tying them, and a new member on this side was silently accepted and
   * simply never produced).
   */
  capReason?: GapGateLoopCapReason;
  /**
   * D7: a DISCRIMINATED filing failure (or deliberate skip) carried on the
   * result so the operator-visible text can say WHY the issue did not file
   * — forge-unresolved / create-error (detail carries the forge stderr) /
   * empty-url / cap-surface (the gap-gate cap routed to surface because a
   * CRITICAL gap remains — CRITICAL-only blocks, #664 transposed; the spec
   * was not filed BY POLICY — nothing failed) / gate-unavailable
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
