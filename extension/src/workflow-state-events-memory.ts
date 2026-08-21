/**
 * /work workflow state — memory event types.
 *
 * The `memory-write` and `memory-inject` members of the `WorkEvent` union,
 * split out of `workflow-state-events.ts` (AGENTS.md §12 file-size limit).
 * `workflow-state-events.ts` composes the full union from the per-domain
 * fragments defined here, so the union stays a single closed, exhaustive
 * type — `nextStep()` and the schema validator see exactly the same shape.
 *
 * This module owns the rationale for both event kinds; the fragments are
 * referenced by name from the composed union's doc.
 */

import type { WorkStep } from "./workflow-state-events.ts";

/**
 * A memory was written, or refused. Emitted per attempt, not per success —
 * the refusals are the interesting half, and a silent refusal is how the
 * write path would go dead without anyone noticing.
 */
export type MemoryWriteEvent = {
  kind: "memory-write";
  at: number;
  outcome: "written" | "cap" | "refused" | "conflict" | "error";
  /** Present on success. */
  id?: string;
  memoryType?: string;
  /** Why, when the outcome is not `written`. */
  detail?: string;
};

/**
 * A memory brief was composed for a subagent prompt.
 *
 * `emptyBrief` is the load-bearing field. A retrieval leg that returns
 * nothing, forever and silently, is the exact failure this project already
 * shipped once — a 100% empty rate was invisible for the whole life of the
 * feature because nothing recorded it.
 */
export type MemoryInjectEvent = {
  kind: "memory-inject";
  at: number;
  step: WorkStep;
  /** Queries issued, so a leg that asks the wrong thing is diagnosable. */
  queries: string[];
  hits: number;
  emptyBrief: boolean;
  /** Ids injected, so a later citation can be matched back to this brief. */
  ids?: string[];
};

/** The memory event kinds, referenced by name in the composed union's doc. */
export type MemoryEventFragment = MemoryWriteEvent | MemoryInjectEvent;
