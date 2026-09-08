/**
 * plan-angles — Phase-2 investigation angle definitions for /plan.
 *
 * The per-ticket-type angle table plus the prompt construction that appends
 * the structured-reporting instructions (report_plan_item, plan-reporter.ts).
 * Split out of plan-draft.ts to keep each module under the 500-line hard
 * limit (AGENTS.md §12).
 */
import { VIPUNE_PRECEDENCE_NOTE, priorContextHasVipune, renderPriorContext } from "./plan-draft.ts";
import { PLAN_ITEM_KINDS } from "./plan-reporter.ts";
import type { PlanType } from "./plan-types.ts";

export interface Angle {
  name: string;
  /** undefined angle prompt = the angle is conditional; decided per run. */
  build: (ctx: {
    type: PlanType;
    descriptor: string;
    priorContext: { source: string; fact: string }[];
    codeIdentifiers: string[];
  }) => string | undefined;
}

const ANGLES: Record<PlanType, Angle[]> = {
  bug: [
    {
      name: "reproduction-surface",
      build: ({ descriptor }) =>
        `Determine concrete steps to reproduce this bug: "${descriptor}". Find: the error messages and logs relevant to it (codebase_memory_search_code + git log), environment specifics that matter, flakiness factors, and the existing test cases that should have caught it. Return findings + evidence + confidence + gaps.`,
    },
    {
      name: "affected-code",
      build: ({ descriptor }) =>
        `Identify the files, functions and call sites affected by this bug: "${descriptor}". For each, capture exact path:line, the function/component name, and why it is in-scope. Use codebase_memory_search_code. Return affected[] + references + gaps.`,
    },
    {
      name: "test-surface",
      build: ({ descriptor }) =>
        `Catalogue the existing tests near the work area for this bug: "${descriptor}". List file paths + key test names to extend or that are missing, golden-fixture candidates, and coverage gaps the fix should close. Return existingTests[] + goldenFixtureCandidates[] + coverageGaps[].`,
    },
  ],
  feature: [
    {
      name: "prior-art",
      build: ({ descriptor, codeIdentifiers }) => {
        if (codeIdentifiers.length === 0) return undefined;
        return `Look for prior art for this feature: "${descriptor}". Check existing implementations and patterns with codebase_memory_search_code (candidate identifiers: ${codeIdentifiers.join(", ")}). Return priorArt[] (source, summary, reuse opportunity) + conventions[] + gaps.`;
      },
    },
    {
      name: "interfaces-and-contracts",
      build: ({ descriptor, codeIdentifiers }) => {
        if (codeIdentifiers.length === 0) return undefined;
        return `Map the type contracts, data shapes and API boundaries this feature touches: "${descriptor}". Function signatures to implement or conform to, structures passed in/out, external contracts. Candidate identifiers: ${codeIdentifiers.join(", ")}. Include typed references where possible (path/file.ts:NN — exported interface X). Return contracts[] + dataShapes[] + references (file paths, no colons).`;
      },
    },
    {
      name: "test-surface",
      build: ({ descriptor }) =>
        `Catalogue the existing tests near the work area for this feature: "${descriptor}". File paths + key test names to extend, golden-fixture candidates, coverage gaps to close. Return existingTests[] + goldenFixtureCandidates[] + coverageGaps[].`,
    },
  ],
  epic: [
    {
      name: "decomposition-surface",
      build: ({ descriptor }) =>
        `Break this epic into natural sub-issues: "${descriptor}". For each: a title proposal, a brief scope, dependencies on other sub-issues, and a suggested ordering. Return subIssues[] (title, scope, deps, order).`,
    },
    {
      name: "success-criteria",
      build: ({ descriptor }) =>
        `How do we know this epic is done? "${descriptor}". Outcome metrics, user-visible behaviour, technical milestones. Return criteria[] (type, description, measurement).`,
    },
  ],
  chore: [
    {
      name: "scope-validation",
      build: ({ descriptor }) =>
        `Is this actually a chore vs a feature/bug in disguise? "${descriptor}". What is the smallest viable change? What scope-creep risks exist that should be split into separate tickets? Return isChore + smallestViableChange + scopeCreepRisks[].`,
    },
    {
      name: "affected-files",
      build: ({ descriptor }) =>
        `List the files this chore will touch: "${descriptor}". For each: path + change type (rename/refactor/delete/config-bump). Return affected[].`,
    },
  ],
  spike: [
    {
      name: "scoping",
      build: ({ descriptor }) =>
        `Scope this spike: "${descriptor}". What is the time-box, the expected deliverable (a decision, prototype or write-up — NOT shipped code), and the success criteria? Return timebox + deliverable + successCriteria.`,
    },
  ],
};

export function anglePromptsFor(
  type: PlanType,
  descriptor: string,
  priorContext: { source: string; fact: string }[],
  codeIdentifiers: string[],
): { name: string; prompt: string }[] {
  return ANGLES[type]
    .map((a) => ({
      name: a.name,
      prompt: buildAnglePrompt(a, type, descriptor, priorContext, codeIdentifiers),
    }))
    .filter((x) => x.prompt !== undefined)
    .map((x) => ({ name: x.name, prompt: x.prompt as string }));
}

const PLAN_REPORTER_PROMPT = [
  "## How to report items — STRUCTURED, not prose",
  "For each structured item you identify, call the `report_plan_item` tool ONCE (one call per item, never batched; never as prose or JSON in your reply — only the tool calls count). Fields:",
  `  - kind: one of ${PLAN_ITEM_KINDS.map((k) => `"${k}"`).join(" | ")}`,
  "  - text: the item — one complete, self-contained item (no bullet marker, no preamble, no heading)",
  "  - angle: your angle name (omit if not applicable)",
  "Kind meanings: acceptance-criterion = a testable outcome; test-surface-item = an existing test to extend or a missing one to add (file + name); edge-case = a pitfall, failure mode or boundary condition the implementer must handle; sub-issue = one sub-ticket of this epic (title + brief scope); reference = a file/pattern already in the work area (path + why it matters); out-of-scope = something this ticket must NOT do. If you found nothing of a kind, do not call it for that kind.",
].join("\n");

function buildAnglePrompt(
  angle: Angle,
  type: PlanType,
  descriptor: string,
  priorContext: { source: string; fact: string }[],
  codeIdentifiers: string[],
): string | undefined {
  const task = angle.build({ type, descriptor, priorContext, codeIdentifiers });
  if (!task) return undefined;
  // #633: cap the prior-context block at the child-prompt render site only —
  // renderPriorContext shares the 2000-char cap with the gap-gate prompt and
  // adds a truncation marker. draftSpec (the FILED body) renders priorContext
  // uncapped (D2), so the full operator context still reaches the filed spec.
  // D6: the precedence note is appended when any prior entry is vipune-sourced
  // (a prior snapshot — may be stale; live context wins on conflict).
  const prior =
    priorContext.length > 0
      ? `PM has already established (DO NOT re-investigate):\n${renderPriorContext(priorContext)}\n${priorContextHasVipune(priorContext) ? `${VIPUNE_PRECEDENCE_NOTE}\n\n` : ""}`
      : "";
  const taskLine = `INVESTIGATION (angle: ${angle.name}, ticket type: ${type})\n\n${prior}${task}\n\n`;
  return `${taskLine}${PLAN_REPORTER_PROMPT}\nWhen you have finished all tool calls, write a SHORT prose summary (2-4 sentences) of what you confirmed. The tool calls are the record; the prose is only a human-readable summary.`;
}
