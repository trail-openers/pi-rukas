/**
 * headless/caps — the published `cap` vocabulary of the headless result
 * (#1326). A host switches on these values instead of hard-coding strings it
 * found in pi-rukas source.
 *
 * A cap is either a fixed literal (`round-cap`) or a template, a prefix plus
 * one parameter (`verify-failed:develop`, `branch-ahead:3`). Both lists are
 * checked against the driver's `WorkCapLiteral` union at compile time: a cap
 * added to the union without being listed here fails `tsc`, so the published
 * list cannot fall behind the caps the driver can emit.
 */

import type { WorkCapLiteral } from "../workflow-state-events-caps.ts";
import type { WorkStep } from "../workflow-state-events.ts";
import { WORK_STEPS } from "../workflow-state-schema.ts";

/** Template caps: the prefix before `:` and what the parameter after it is. */
export const CAP_TEMPLATES = {
  "verify-failed": "step",
  /** #1324 — the step's verify command hit its time bound (not a code failure). */
  "verify-timeout": "step",
  "step-failed": "step",
  "driver-crash": "step",
  /** The number of commits the local branch is ahead of origin. */
  "branch-ahead": "count",
} as const;

type CapTemplate = keyof typeof CAP_TEMPLATES;
type TemplateCap = `${CapTemplate}:${string}`;
export type FixedCap = Exclude<WorkCapLiteral, TemplateCap>;

/** Every fixed-literal cap the driver can record, sorted. */
export const FIXED_CAPS = [
  "adversarial-infra-failure",
  "adversarial-loop",
  "awaiting-human-merge",
  "ci-retry",
  "commit-pr-incomplete-consolidation",
  "consolidated-verify-conflict",
  "consolidated-verify-consolidation-created",
  "consolidation-incomplete",
  "cross-group-conflict",
  "deadline",
  "deferred-creation:develop",
  "develop-incomplete-deliverables",
  "developer-timeout",
  "existing-pr-detected",
  "explore-already-complete",
  "explore-bodies-empty",
  "explore-needs-clarification",
  "fence-violation:develop",
  "integration-verify-failed",
  "integration-worktree-violation",
  "intent-park",
  "lens-diff-unreadable",
  "lens-fix-not-integrated",
  "lens-fix-reposition",
  "loop-detected",
  "no-review-outcome",
  "ops-merge-base-mismatch",
  "plan-timeout",
  "repeat-finding-seam",
  "repo-root-residue",
  "review-incomplete",
  "round-cap",
  "step-back-revise-spec",
  "token-budget",
  "wall-clock",
] as const satisfies readonly FixedCap[];

// Compile-time exhaustiveness (the #986 pattern): a fixed cap in the union
// but not in FIXED_CAPS — or a new template family — names itself here.
type MissingCaps = Exclude<FixedCap, (typeof FIXED_CAPS)[number]>;
const _capsExhaustive: [MissingCaps] extends [never] ? true : MissingCaps = true;
void _capsExhaustive;

/** The `cap` of a headless result: the driver's own literal type. */
export type HeadlessCap = WorkCapLiteral;

/** The vocabulary as `--capabilities` publishes it. */
export function capVocabulary(): {
  fixed: readonly string[];
  templates: { prefix: string; parameter: string; values?: readonly string[] }[];
} {
  return {
    fixed: FIXED_CAPS,
    templates: Object.entries(CAP_TEMPLATES).map(([name, parameter]) =>
      parameter === "step"
        ? { prefix: `${name}:`, parameter, values: WORK_STEPS }
        : { prefix: `${name}:`, parameter },
    ),
  };
}

/** The step a `<template>:<step>` cap names, if it is one. */
export function capStep(cap: string): WorkStep | undefined {
  const i = cap.indexOf(":");
  if (i < 0) return undefined;
  const family = cap.slice(0, i) as CapTemplate;
  const param = cap.slice(i + 1);
  if (CAP_TEMPLATES[family] !== "step") return undefined;
  return (WORK_STEPS as readonly string[]).includes(param) ? (param as WorkStep) : undefined;
}
