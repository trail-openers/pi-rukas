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

export type LifecycleKind = "dispatched" | "completed" | "failed" | "steered";

export interface LifecycleDetails {
  kind: LifecycleKind;
  jobId: string;
  /** Display label, e.g. "developer" or "lens_review" or "dispatch_parallel". */
  label: string;
  /** Role for telemetry; same as label for synthetic orchestrator labels. */
  role: string;
  /** Elapsed ms for completed/failed; omitted for dispatched. */
  elapsedMs?: number;
  /** Total tokens (input + output + cache) for completed; omitted for dispatched/failed. */
  totalTokens?: number;
  /** Exit code for failed; omitted otherwise. */
  exitCode?: number;
  /** Steer message (truncated for scrollback) — set for kind="steered" only. */
  steerMessage?: string;
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

/** Emit a steer scrollback entry (#153). The `message` is truncated for display
 *  but the full payload was delivered to the child via RPC stdin separately. */
export function emitSteered(jobId: string, label: string, role: string, message: string): void {
  emit({ kind: "steered", jobId, label, role, steerMessage: message });
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
    case "steered": {
      const msg = (d.steerMessage ?? "").replaceAll(/\s+/g, " ").trim();
      const truncated = msg.length > 80 ? `${msg.slice(0, 79)}…` : msg;
      return `▸ ensemble: ⤳ steered ${d.label} · "${truncated}"`;
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
    case "steered":
      return theme.fg("warning", content);
  }
}
