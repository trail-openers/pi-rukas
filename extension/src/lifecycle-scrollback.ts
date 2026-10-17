/**
 * lifecycle-scrollback — the pure presentation half of a lifecycle entry
 * (#118, #299, #1403).
 *
 * Split out of `lifecycle-events.ts` for module-size hygiene (AGENTS.md §12):
 * `lifecycle-events.ts` owns the emitting side (the `emitX` helpers, the
 * `appendEntry` path and its graceful-degradation guards) and this module owns
 * the reading side — how one `LifecycleDetails` becomes the one line the user
 * sees, and how that line is coloured.
 *
 * Both halves are pure: no Pi API, no module state, no I/O. That is what makes
 * the split safe and what the offline suite pins: `renderLifecycleEntryLine`
 * must stay byte-identical to `applyTheme(details, formatLine(details), theme)`,
 * which is only a meaningful assertion while the two are one composition
 * rather than two independently-written renderers.
 */

import type { LifecycleDetails } from "./lifecycle-events.ts";
import { formatTokens } from "./progress.ts";

/** How many cycles are currently live. Set by the work-widget, which already
 * tracks exactly this; lifecycle lines only need the count to decide whether
 * disambiguation is worth the width.
 */
let liveCycleCount = 0;
export function setLiveCycleCount(n: number): void {
  liveCycleCount = n;
}

/** The `#N ` tag, or "" when a single cycle makes it noise. */
function cycleTag(issue: number | undefined): string {
  return issue !== undefined && liveCycleCount > 1 ? `#${issue} ` : "";
}

/** The theme surface the renderer needs; the fake theme in the suite matches it. */
export type EntryRenderTheme = { fg: (style: string, text: string) => string };

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
      // #299 — name the failure class honestly: this shape is a transport-
      // level verdict from the child's HTTP client (stream severed mid-body
      // or client retry-exhaustion), not proof the endpoint is down.
      return `▸ ensemble: ⚠ ${d.label} terminated mid-stream${elapsed}${tokens} — provider/transport error (stream severed or client retry-exhaustion), see report`;
    }
    case "steered": {
      const msg = (d.steerMessage ?? "").replaceAll(/\s+/g, " ").trim();
      const truncated = msg.length > 80 ? `${msg.slice(0, 79)}…` : msg;
      const source = d.steerSource ? ` [${d.steerSource}]` : "";
      return `▸ ensemble: ⤳ steered ${d.label}${source} · "${truncated}"`;
    }
    case "step-started": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const round = d.round && d.round > 1 ? ` (round ${d.round})` : "";
      return `▸ ensemble: ${cycleTag(d.issue)}▶ step ${ordinal}${d.label}${round} started`;
    }
    case "step-completed": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const round = d.round && d.round > 1 ? ` (round ${d.round})` : "";
      const tokens =
        d.totalTokens && d.totalTokens > 0 ? ` · ${formatTokens(d.totalTokens)} tokens` : "";
      const elapsed = d.elapsedMs != null ? ` · ${fmtElapsed(d.elapsedMs)}` : "";
      const recovered = d.recovered ? " · recovered after retry" : "";
      return `▸ ensemble: ${cycleTag(d.issue)}✓ step ${ordinal}${d.label}${round} finished${elapsed}${tokens}${recovered}`;
    }
    case "step-failed": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const round = d.round && d.round > 1 ? ` (round ${d.round})` : "";
      const elapsed = d.elapsedMs != null ? ` · ${fmtElapsed(d.elapsedMs)}` : "";
      const reason = d.reason ? ` · ${d.reason}` : "";
      return `▸ ensemble: ${cycleTag(d.issue)}✗ step ${ordinal}${d.label}${round} failed${elapsed}${reason}`;
    }
    case "step-notice":
      // #1403 — the step is not "done"; the message says what died. From inside
      // the handler, so there is no ordinal to render.
      return `▸ ensemble: ${cycleTag(d.issue)}! ${d.label}: ${d.reason ?? ""}`;
    case "step-retry": {
      const ordinal = d.stepNumber && d.stepTotal ? `${d.stepNumber}/${d.stepTotal} ` : "";
      const attempt = d.round ? ` attempt ${d.round}` : "";
      const reason = d.reason ? ` · prior failure: ${d.reason}` : "";
      return `▸ ensemble: ${cycleTag(d.issue)}↻ step ${ordinal}${d.label} retrying${attempt}${reason}`;
    }
  }
}

function applyTheme(
  details: LifecycleDetails | undefined,
  content: string,
  theme: EntryRenderTheme,
): string {
  if (!details) return theme.fg("dim", content);
  switch (details.kind) {
    case "dispatched":
      return theme.fg("dim", content);
    case "completed":
      return theme.fg("success", content);
    case "failed":
      return theme.fg("error", content);
    case "step-notice":
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

/**
 * Compute the styled one-line display for a CustomEntry's data at render time.
 * Exported (test-only in practice) so the offline suite can pin that the
 * registered renderer's output is byte-identical to
 * applyTheme(details, formatLine(details), theme).
 */
export function renderLifecycleEntryLine(data: unknown, theme: EntryRenderTheme): string {
  const details = data as LifecycleDetails | undefined;
  // applyTheme handles the missing-details path (dim render of the fallback
  // line); formatLine is only reached when data is a well-shaped details
  // object — an untyped entry.data is not a lifecycle payload.
  const text = details ? formatLine(details) : "";
  return applyTheme(details, text, theme);
}
