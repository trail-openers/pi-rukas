#!/usr/bin/env bun
/**
 * lib/lean-nested-submit — replays a child's codemode submissions the way the
 * spawn does, for the #2618 step-level cases.
 *
 * The lean step fixtures hand a `toolUses` array straight to the step, which is
 * exactly the shape the bug destroyed: the step's readers see what the collapse
 * produced, and the collapse never looked at `nestedCalls`. A case that only
 * hand-builds direct `submit_tests` blocks therefore cannot reach the failure.
 *
 * So a case gives this helper what Pi would have put on the child's transcript —
 * assistant toolCall blocks plus the parent `toolResult` carrying its
 * `nestedCalls` rows — and it runs the real `collapseEvents` over them and
 * returns the `DispatchResult` the fake dispatch hands back to the step. Nothing
 * here is a stub of the thing under test: the collapse, the extractors and the
 * step are all production code.
 */

import type { PiMessage } from "../../src/pi-event-shapes.ts";
import { collapseEvents } from "../../src/spawn-collapse-events.ts";
import type { DispatchResult } from "../../src/types.ts";
import { agentEnd } from "../fixtures/nested-call-events.ts";

/** What the fake child did, in Pi's own shapes. */
export interface NestedChildTurn {
  /** The assistant + toolResult messages Pi recorded, in order. */
  messages: PiMessage[];
  /** The child's wall clock, so a case can say how long it spent. */
  ms?: number;
}

/**
 * The `DispatchResult` for a child whose transcript is `turn.messages`.
 *
 * `role` is the caller's, because the step dispatches different roles per step
 * and a case's assertion about idle detection reads it. `ok`/`exitCode` are the
 * healthy arm unless the case says otherwise: a dead child is a different bug.
 */
export function collapsedChild(
  role: string,
  turn: NestedChildTurn,
  over?: Partial<DispatchResult>,
): DispatchResult {
  const result = collapseEvents(
    agentEnd(turn.messages),
    // No fallback message: the arm under test is the agent_end replay. The
    // fallback's behaviour is pinned at the collapse test, where it is honest.
    null,
    role,
    turn.ms ?? 1,
    over?.exitCode ?? 0,
    "",
  );
  // The caller's overrides win LAST: a case that hands back a dead child says so
  // with `ok: false`, and the collapse's `ok: true` must not silently undo it.
  return { ...result, ...(over ?? {}) };
}
