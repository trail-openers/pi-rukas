/**
 * plan-types — the shared types and phase-0 primitives for the compiled
 * /plan pipeline. Split out of plan-driver.ts to keep each module under the
 * 500-line hard limit (AGENTS.md §12). Phase 0 (classify + title) lives here
 * because it is pure, stateless, and consumed by both the driver and the
 * tests.
 */

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
