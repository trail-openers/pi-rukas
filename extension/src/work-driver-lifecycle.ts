/**
 * work-driver-lifecycle — lifecycle event emissions for the /work driver.
 */

import {
  emitStepCompleted as _emitStepCompleted,
  emitStepFailed as _emitStepFailed,
  emitStepStarted as _emitStepStarted,
} from "./lifecycle-events.ts";
import type { DriverOutcome } from "./work-driver.ts";
import * as workWidget from "./work-widget.ts";
import type { WorkStep } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state.ts";

export function emitStepStarted(
  step: WorkStep,
  n: number,
  t: number,
  r: number,
  issue: number,
): void {
  _emitStepStarted(step, n, t, r, issue);
}

export function emitStepFailed(
  step: WorkStep,
  n: number,
  t: number,
  ms: number,
  err: string,
  r: number,
  issue: number,
): void {
  _emitStepFailed(step, n, t, ms, err, r, issue);
}

export function emitStepCompleted(step: WorkStep, n: number, t: number, ms: number): void {
  _emitStepCompleted(step, n, t, ms);
}

export function updateFooter(state: WorkState, startedAt: number): void {
  workWidget.update(state, startedAt);
}

export function clearFooter(issue: number): void {
  workWidget.clear(issue);
}

import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { reportFinalState } from "./work-driver-final-state.ts";
import { checkIssueStatesAtEntry } from "./work-driver-issue-closed.ts";

/**
 * #1472 — cycle-entry refusal for a CLOSED issue.
 *
 * One `issueView` per group member answers BOTH questions — the attention label
 * (read by `checkAttentionLabel` just above) and the issue's own state — so the
 * entry block does not read every issue twice. Unlike the label check, a
 * `--restart` does not override it: the label asks "has a human seen this?"
 * (which --restart answers), a CLOSED issue asks "does a human still want
 * this?" (which only reopening answers). Returns the refusal outcome, or
 * undefined to proceed. An unreadable state never refuses — it traces.
 */
export async function refuseClosedIssue(
  ctx: CycleContext,
  state: WorkState,
): Promise<DriverOutcome | undefined> {
  const states = await checkIssueStatesAtEntry(ctx, { restart: ctx.restart === true });
  if (!states.closed) {
    if (!states.checked) {
      trace(`work-driver: issue-state check did not run for #${ctx.issue}`);
    }
    return undefined;
  }
  const n = states.closed.issue;
  notifyAgent(
    ctx.host,
    [
      `pi-rukas: /work for issue #${n} refused — it is CLOSED.`,
      "",
      "A person closed it while (or before) the cycle ran. The driver dispatched",
      "nothing and merged nothing; the branch and worktrees are untouched.",
      "",
      '--restart does not override a closed issue: it means "I revised the issue",',
      "and a closed issue has not been revised back.",
      "",
      "If the work is still wanted, reopen it first:",
      `  gh issue reopen ${n}`,
      `  /work ${n} --restart`,
    ].join("\n"),
  );
  reportFinalState(ctx, state);
  return { started: false, reason: `issue #${n} is CLOSED` };
}
