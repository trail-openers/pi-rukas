/**
 * work-driver-lifecycle — lifecycle event emissions for the /work driver.
 */

import {
  emitStepCompleted as _emitStepCompleted,
  emitStepFailed as _emitStepFailed,
  emitStepStarted as _emitStepStarted,
} from "./lifecycle-events.ts";
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
