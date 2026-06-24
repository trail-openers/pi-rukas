/**
 * Lifecycle scrollback entries for dispatch transitions (#118).
 *
 * Where the dispatch deck (#117) shows ephemeral live activity in the footer,
 * lifecycle events are the *durable* record in the chat scrollback. Three
 * transitions emit one-line entries each:
 *
 *   ▸ ensemble: dispatched developer · df8a-7r
 *   ▸ ensemble: ✓ developer finished · 2m31s · 14.3k tokens
 *   ▸ ensemble: ✗ developer failed · 2m31s · exit 1 — see report
 *
 * Uses pi.sendMessage with `display: true` (visible to user) but the message
 * type is custom and not declared as LLM-bound — Pi's `convertToLlm` does not
 * forward custom messages to the model. Zero context cost.
 *
 * Lens-review and adversarial orchestrators emit only at the OVERALL
 * dispatch/complete/fail transition (not per child) — otherwise a six-pass
 * review would spam 12 entries (6 dispatched + 6 completed) for one user
 * action.
 *
 * Opt-out: PI_ENSEMBLE_QUIET_LIFECYCLE=1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatTokens } from "./progress.ts";
import { trace } from "./trace.ts";

const CUSTOM_TYPE = "ensemble:lifecycle";

export type LifecycleKind =
  | "dispatched"
  | "completed"
  | "failed"
  | "errored"
  | "steered"
  | "step-started"
  | "step-completed"
  | "step-failed"
  /**
   * PR5 — a RETRY_ONCE-classified step (adversarial, lens-review) hit a
   * dispatch-failed and the driver is re-running it. Distinct from
   * step-failed so the scrollback signals "transient — retrying" vs
   * "permanent — handoff". One event per retry attempt.
   */
  | "step-retry";

export interface LifecycleDetails {
  kind: LifecycleKind;
  /**
   * For dispatch/steer kinds: the async-jobs jobId. For step-* kinds:
   * the workflow-driver step name (e.g., "adversarial", "lens-review")
   * so the scrollback line can carry it directly.
   */
  jobId: string;
  /** Display label. For step-* kinds, this is the step name. */
  label: string;
  /** Role for telemetry; same as label for synthetic orchestrator labels. */
  role: string;
  /** Elapsed ms for completed/failed/errored/step-completed/step-failed. */
  elapsedMs?: number;
  /** Total tokens (input + output + cache); set for completed/errored/step-completed. */
  totalTokens?: number;
  /** Exit code for failed; omitted otherwise. */
  exitCode?: number;
  /** Steer message (truncated for scrollback) — set for kind="steered" only. */
  steerMessage?: string;
  /**
   * Step ordinal for step-* kinds (1-indexed). Pair with stepTotal to render
   * "step 5/9". Plain dispatches omit both.
   */
  stepNumber?: number;
  /** Total step count for step-* kinds. */
  stepTotal?: number;
  /**
   * Failure reason for step-failed (e.g., "subagent ABORT", "cap-hit:
   * ci-retry"). Shown after the elapsed metric on the scrollback line so
   * the user knows WHY the step failed without opening the state file.
   */
  reason?: string;
  /**
   * Sub-round counter for steps that iterate within a cycle (PR4 label
   * polish). adversarial / lens-review / lens-fix all run multiple times
   * during a fix loop, and `develop` re-enters on ci-status:failure.
   * `(round N)` is appended to the scrollback line when set so the user
   * can tell apart "first adversarial gate" from "third adversarial
   * gate" without checking the state file. Omitted on first entry of a
   * step (round 1 — no suffix needed) and on steps that never iterate
   * (explore, plan, branch, commit-pr, step-back, ci, handoff, merged).
   */
  round?: number;
}

let activePi: ExtensionAPI | undefined;

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_LIFECYCLE === "1";
}

export function attach(pi: ExtensionAPI): void {
  activePi = pi;
  const piWithRenderer = pi as unknown as {
    registerMessageRenderer?: (
      type: string,
      renderer: (
        message: { content: string; details?: unknown },
        options: unknown,
        theme: { fg: (style: string, text: string) => string },
      ) => unknown,
    ) => void;
  };
  if (typeof piWithRenderer.registerMessageRenderer !== "function") {
    trace("lifecycle-events: registerMessageRenderer unavailable; default render will be used");
    return;
  }
  piWithRenderer.registerMessageRenderer(CUSTOM_TYPE, (message, _options, theme) => {
    const details = message.details as LifecycleDetails | undefined;
    const styled = applyTheme(details, message.content, theme);
    return new Text(styled, 0, 0);
  });
}

/** Test-only — drop active pi reference. */
export function detach(): void {
  activePi = undefined;
}

export function emitDispatched(jobId: string, label: string, role: string): void {
  emit({ kind: "dispatched", jobId, label, role });
}

export function emitCompleted(
  jobId: string,
  label: string,
  role: string,
  elapsedMs: number,
  totalTokens?: number,
): void {
  emit({ kind: "completed", jobId, label, role, elapsedMs, totalTokens });
}

export function emitFailed(
  jobId: string,
  label: string,
  role: string,
  elapsedMs: number,
  exitCode?: number,
): void {
  emit({ kind: "failed", jobId, label, role, elapsedMs, exitCode });
}

/**
 * Distinct from emitFailed (process-level non-zero exit): the child exited 0
 * but its final assistant message had `stopReason: "error"` with empty content
 * — typically a provider HTTP timeout or transport failure that pi-ai turned
 * into a synthetic message. Visually marked with ⚠ so the user spots the
 * mid-stream termination in scrollback without digging into transcripts.
 */
export function emitErrored(
  jobId: string,
  label: string,
  role: string,
  elapsedMs: number,
  totalTokens?: number,
): void {
  emit({ kind: "errored", jobId, label, role, elapsedMs, totalTokens });
}

/** Emit a steer scrollback entry (#153). The `message` is truncated for display
 *  but the full payload was delivered to the child via RPC stdin separately. */
export function emitSteered(jobId: string, label: string, role: string, message: string): void {
  emit({ kind: "steered", jobId, label, role, steerMessage: message });
}

/**
 * Step-level lifecycle events for the work-driver (PR2). Distinct from the
 * per-dispatch events above: the work-driver runs 9 STEPS, each of which
 * may dispatch one or more subagents. Adversarial and lens-review steps
 * call into existing orchestrator functions (`runAdversarialLoop` /
 * `runLensReview`) that bypass startJob → bypass `emitDispatched/Completed`.
 * The PR #239 live test on issue #553 made those two steps invisible in
 * scrollback. Step-level emitters surface them uniformly.
 *
 * `step` is the step name (e.g. "adversarial"); `stepNumber/stepTotal`
 * render as "5/9" for at-a-glance progress.
 */
export function emitStepStarted(
  step: string,
  stepNumber: number,
  stepTotal: number,
  round?: number,
): void {
  emit({
    kind: "step-started",
    jobId: step,
    label: step,
    role: step,
    stepNumber,
    stepTotal,
    round,
  });
}

export function emitStepCompleted(
  step: string,
  stepNumber: number,
  stepTotal: number,
  elapsedMs: number,
  totalTokens?: number,
  round?: number,
): void {
  emit({
    kind: "step-completed",
    jobId: step,
    label: step,
    role: step,
    stepNumber,
    stepTotal,
    elapsedMs,
    totalTokens,
    round,
  });
}

export function emitStepFailed(
  step: string,
  stepNumber: number,
  stepTotal: number,
  elapsedMs: number,
  reason?: string,
  round?: number,
): void {
  emit({
    kind: "step-failed",
    jobId: step,
    label: step,
    role: step,
    stepNumber,
    stepTotal,
    elapsedMs,
    reason,
    round,
  });
}

/**
 * PR5 — a RETRY_ONCE step (adversarial, lens-review) had its dispatch
 * fail and the driver is re-running it. `attempt` is the new attempt
 * number (i.e., the retry count + 1; first retry is attempt=2). Reason
 * carries why the previous attempt failed for scrollback context.
 */
export function emitStepRetry(
  step: string,
  stepNumber: number,
  stepTotal: number,
  attempt: number,
  reason?: string,
): void {
  emit({
    kind: "step-retry",
    jobId: step,
    label: step,
    role: step,
    stepNumber,
    stepTotal,
    round: attempt,
    reason,
  });
}

function emit(details: LifecycleDetails): void {
  if (isQuiet()) return;
  const text = formatLine(details);
  if (!activePi) return;
  try {
    activePi.sendMessage({
      customType: CUSTOM_TYPE,
      content: text,
      display: true,
      details,
    });
  } catch (err) {
    trace(`lifecycle-events: sendMessage failed: ${(err as Error).message}`);
  }
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** Pure formatter for the scrollback line — string-only, theme-agnostic. */
export function formatLine(d: LifecycleDetails): string {
  switch (d.kind) {
    case "dispatched":
      return `▸ ensemble: dispatched ${d.label} · ${d.jobId}`;
    case "completed": {
      const tokens =
        d.totalTokens && d.totalTokens > 0 ? ` · ${formatTokens(d.totalTokens)} tokens` : "";
      const elapsed = d.elapsedMs != null ? ` · ${fmtElapsed(d.elapsedMs)}` : "";
      return `▸ ensemble: ✓ ${d.label} finished${elapsed}${tokens}`;
    }
    case "failed": {
      const elapsed = d.elapsedMs != null ? ` · ${fmtElapsed(d.elapsedMs)}` : "";
      const exit = d.exitCode != null ? ` · exit ${d.exitCode}` : "";
      return `▸ ensemble: ✗ ${d.label} failed${elapsed}${exit} — see report`;
    }
    case "errored": {
      const tokens =
        d.totalTokens && d.totalTokens > 0 ? ` · ${formatTokens(d.totalTokens)} tokens` : "";
      const elapsed = d.elapsedMs != null ? ` · ${fmtElapsed(d.elapsedMs)}` : "";
      return `▸ ensemble: ⚠ ${d.label} terminated mid-stream${elapsed}${tokens} — provider request error, see report`;
    }
    case "steered": {
      const msg = (d.steerMessage ?? "").replaceAll(/\s+/g, " ").trim();
      const truncated = msg.length > 80 ? `${msg.slice(0, 79)}…` : msg;
      return `▸ ensemble: ⤳ steered ${d.label} · "${truncated}"`;
    }
    case "step-started": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const round = d.round && d.round > 1 ? ` (round ${d.round})` : "";
      return `▸ ensemble: ▶ step ${ordinal}${d.label}${round} started`;
    }
    case "step-completed": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const round = d.round && d.round > 1 ? ` (round ${d.round})` : "";
      const tokens =
        d.totalTokens && d.totalTokens > 0 ? ` · ${formatTokens(d.totalTokens)} tokens` : "";
      const elapsed = d.elapsedMs != null ? ` · ${fmtElapsed(d.elapsedMs)}` : "";
      return `▸ ensemble: ✓ step ${ordinal}${d.label}${round} finished${elapsed}${tokens}`;
    }
    case "step-failed": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const round = d.round && d.round > 1 ? ` (round ${d.round})` : "";
      const elapsed = d.elapsedMs != null ? ` · ${fmtElapsed(d.elapsedMs)}` : "";
      const reason = d.reason ? ` · ${d.reason}` : "";
      return `▸ ensemble: ✗ step ${ordinal}${d.label}${round} failed${elapsed}${reason}`;
    }
    case "step-retry": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const attempt = d.round ? ` attempt ${d.round}` : "";
      const reason = d.reason ? ` · prior failure: ${d.reason}` : "";
      return `▸ ensemble: ↻ step ${ordinal}${d.label} retrying${attempt}${reason}`;
    }
  }
}

function applyTheme(
  details: LifecycleDetails | undefined,
  content: string,
  theme: { fg: (style: string, text: string) => string },
): string {
  if (!details) return theme.fg("dim", content);
  switch (details.kind) {
    case "dispatched":
      return theme.fg("dim", content);
    case "completed":
      return theme.fg("success", content);
    case "failed":
      return theme.fg("error", content);
    case "errored":
      // Same colour as `failed` — both surface in scrollback as something
      // gone wrong; the line text itself distinguishes the failure mode.
      return theme.fg("error", content);
    case "steered":
      return theme.fg("warning", content);
    case "step-started":
      // Step-level events use a different visual weight than dispatches —
      // dim for start to keep the eye drawn to the success/failure line.
      return theme.fg("dim", content);
    case "step-completed":
      return theme.fg("success", content);
    case "step-failed":
      return theme.fg("error", content);
    case "step-retry":
      // Warning colour — transient, not yet a failure but worth noticing.
      return theme.fg("warning", content);
  }
}
