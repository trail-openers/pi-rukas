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
 * #708 — uses pi.appendEntry + pi.registerEntryRenderer, NOT pi.sendMessage.
 * The pre-#708 premise ("custom messages are not forwarded to the model —
 * zero context cost") was false: Pi's convertToLlm case "custom" unconditionally
 * converts every custom message to a user message with no excludeFromContext
 * check, so every lifecycle line WAS injected into LLM context as a user
 * message (and, on the steer path, mid-stream sends landed in the steering
 * queue and broke tool-call adjacency). appendEntry writes a CustomEntry that
 * does NOT participate in LLM context — zero context cost, as intended.
 * Display is now renderer-driven (there is no display flag on entries): the
 * registered EntryRenderer computes the line at render time via
 * formatLine(entry.data) + applyTheme(...), so emit only persists structured
 * data. If the renderer is never registered (older Pi, or entry API
 * unavailable) lines are silently not shown — no error is raised.
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
import * as scrollback from "./lifecycle-scrollback.ts";
import type { EntryRenderTheme } from "./lifecycle-scrollback.ts";
import { trace } from "./trace.ts";

// The scrollback half (lifecycle-scrollback.ts) owns the line formatter and
// the theme switch; these re-exports keep every existing importer's path and
// the offline suite's byte-identity pin pointing at one implementation.
export {
  type EntryRenderTheme,
  formatLine,
  renderLifecycleEntryLine,
} from "./lifecycle-scrollback.ts";

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
  | "step-retry"
  /**
   * #1403 — a one-line operator notice emitted from INSIDE a step handler,
   * for the outcome the handler knows and the step-boundary lines do not.
   * Used for a develop child whose ENGINE DIED: the router emits the cap's
   * `step-failed` line at the boundary, this line says the pass died while
   * the handler still knows which workstream and what it left behind — so
   * the console never reads `develop done` over a dead pass.
   */
  | "step-notice"
  /**
   * #1415 — the driver's own verify gate, announced while it runs. The
   * step-boundary lines bracket the STEP; a develop step that dispatches for
   * 19 minutes and then verifies for 22 showed one `started` and one
   * `finished` with 22 minutes of nothing between them (tehas cycle 261), so
   * an operator watching a live cycle could not tell the gate from a hang.
   * These two are the gate's own pair, emitted before and after the exec.
   */
  | "verify-started"
  | "verify-completed";

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
  role?: string;
  /** Elapsed ms for completed/failed/errored/step-completed/step-failed. */
  elapsedMs?: number;
  /** Total tokens (input + output + cache); set for completed/errored/step-completed. */
  totalTokens?: number;
  /** Exit code for failed; omitted otherwise. */
  exitCode?: number;
  /** Steer message (truncated for scrollback) — set for kind="steered" only. */
  steerMessage?: string;
  /**
   * #543 F2 — who sent the steer. The PM `dispatch_steer` tool is the original
   * source ("pm-tool"); the work-driver's own caps steer with "driver-loop-detector"
   * (F1) and "driver-budget" (F6). Rendered as a trailing tag so the scrollback
   * line shows WHY the child was nudged without opening the state file.
   * Omitted for pm-tool steers to keep the pre-#543 line byte-identical.
   */
  steerSource?: string;
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
   * For `step-notice` it carries the whole notice.
   */
  reason?: string;
  /**
   * #299 — set on step-completed when the step succeeded after one or more
   * retries. The scrollback line appends "recovered after retry" so a
   * transient failure's earlier ↻ line doesn't stand as the last word.
   */
  recovered?: boolean;
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
  /**
   * #288 — which cycle this line belongs to.
   *
   * Without it, two concurrent cycles entering `develop` emit byte-identical
   * scrollback: `▸ ensemble: ▶ step 4/9 develop started`, twice. There is
   * nothing in the payload, the label or the theme to tell them apart, so a
   * failure line gives the operator a coin-flip on which issue to investigate.
   * Rendered only when more than one cycle is live, so single-cycle output is
   * unchanged.
   */
  issue?: number;
  /**
   * #1415 — the verify command, on the `verify-*` kinds only. Truncated for
   * display by the formatter; the full command lives on the event-log entry.
   */
  command?: string;
  /**
   * #1415 — what the gate ran against (`"consolidated"` or a worktree
   * basename), on the `verify-*` kinds only. Without it two `verify-completed
   * · success` lines from one develop round — the per-worktree leg and the
   * consolidated probe — are the same line.
   */
  target?: string;
  /**
   * #1415 — which tier of the project's gate this run is (`"full"`,
   * `"fast"`, `"full-second-tier"`). Optional: a caller that does not classify
   * its command leaves it absent rather than guessing.
   */
  tier?: string;
  /**
   * #1415 — the run's verdict, on `verify-completed` only. `timeout` is kept
   * distinct from `failure`: a run killed at its bound judged nothing (#1324).
   */
  status?: "success" | "failure" | "skipped" | "timeout";
  /** #1415 — the verdict came from a previous passing run, not a new exec. */
  reused?: boolean;
}

/**
 * How many cycles are currently live. Set by the work-widget, which already
 * tracks exactly this; lifecycle lines only need the count to decide whether
 * disambiguation is worth the width.
 */
/**
 * How many cycles are currently live. The renderer (lifecycle-scrollback.ts)
 * owns the count that decides whether the `#N ` tag is worth its width; this
 * is the entry point callers (the work-widget) use to update it.
 */
export function setLiveCycleCount(n: number): void {
  scrollback.setLiveCycleCount(n);
}

let activePi: ExtensionAPI | undefined;

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_LIFECYCLE === "1";
}

/** The shape Pi's registerEntryRenderer callback is typed against locally. */
type EntryRenderFn = (
  entry: { customType: string; data?: unknown },
  options: { expanded: boolean },
  theme: EntryRenderTheme,
) => unknown;

export function attach(pi: ExtensionAPI): void {
  activePi = pi;
  const piWithEntryApi = pi as unknown as {
    registerEntryRenderer?: (type: string, renderer: EntryRenderFn) => void;
    appendEntry?: (type: string, data?: unknown) => void;
  };
  if (typeof piWithEntryApi.registerEntryRenderer !== "function") {
    // Older Pi without the entry-API pair: degrade to a silent no-op rather
    // than throwing. In the entry model there is nothing to fall back to at
    // emit time (appendEntry is the only write), so emit() also checks the
    // guard and skips the appendEntry call entirely — no entry is persisted.
    trace("lifecycle-events: registerEntryRenderer unavailable; lifecycle lines will not be shown");
    return;
  }
  piWithEntryApi.registerEntryRenderer(CUSTOM_TYPE, (entry, _options, theme) => {
    const styled = scrollback.renderLifecycleEntryLine(entry.data, theme);
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
 *  but the full payload was delivered to the child via RPC stdin separately.
 *  `source` (#543 F2) tags the steering actor; the PM tool path omits it so the
 *  line renders exactly as before. */
export function emitSteered(
  jobId: string,
  label: string,
  role: string,
  message: string,
  source?: string,
): void {
  emit({ kind: "steered", jobId, label, role, steerMessage: message, steerSource: source });
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
  issue?: number,
): void {
  emit({
    kind: "step-started",
    jobId: step,
    label: step,
    role: step,
    stepNumber,
    stepTotal,
    round,
    issue,
  });
}

export function emitStepCompleted(
  step: string,
  stepNumber: number,
  stepTotal: number,
  elapsedMs: number,
  totalTokens?: number,
  round?: number,
  recovered?: boolean,
  issue?: number,
): void {
  emit({
    kind: "step-completed",
    issue,
    jobId: step,
    label: step,
    role: step,
    stepNumber,
    stepTotal,
    elapsedMs,
    totalTokens,
    round,
    recovered,
  });
}

export function emitStepFailed(
  step: string,
  stepNumber: number,
  stepTotal: number,
  elapsedMs: number,
  reason?: string,
  round?: number,
  issue?: number,
): void {
  emit({
    kind: "step-failed",
    issue,
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
  issue?: number,
): void {
  emit({
    kind: "step-retry",
    issue,
    jobId: step,
    label: step,
    role: step,
    stepNumber,
    stepTotal,
    round: attempt,
    reason,
  });
}

/**
 * #1403 — an in-step operator notice. NOT a `step-failed`: the router emits
 * that for the cap at the boundary, and two failure lines would double-report
 * one event. Carries prose only, so a handler can say what it saw while it
 * still knows which workstream died and what it left behind.
 */
export function emitStepNotice(step: string, message: string, issue?: number): void {
  emit({ kind: "step-notice", issue, jobId: step, label: step, reason: message });
}

/**
 * #1415 — the driver's verify gate is about to execute `command`. Emitted
 * BEFORE the exec so the console carries a line for the whole duration of a
 * multi-minute gate, not only after it returns.
 *
 * `jobId` is the step: the gate has no dispatch of its own (it is driver
 * code, not a child), so the step is the only correlation key that exists.
 */
export function emitVerifyStarted(args: {
  step: string;
  command: string;
  target: string;
  tier?: string;
  issue?: number;
}): void {
  emit({
    kind: "verify-started",
    jobId: args.step,
    label: args.step,
    role: args.step,
    command: args.command,
    target: args.target,
    tier: args.tier,
    issue: args.issue,
  });
}

/** #1415 — the gate returned from `command` after `ms`. See `emitVerifyStarted`. */
export function emitVerifyCompleted(args: {
  step: string;
  command: string;
  target: string;
  tier?: string;
  status: "success" | "failure" | "skipped" | "timeout";
  ms: number;
  reused?: boolean;
  issue?: number;
}): void {
  emit({
    kind: "verify-completed",
    jobId: args.step,
    label: args.step,
    role: args.step,
    command: args.command,
    target: args.target,
    tier: args.tier,
    status: args.status,
    elapsedMs: args.ms,
    reused: args.reused,
    issue: args.issue,
  });
}

function emit(details: LifecycleDetails): void {
  if (isQuiet()) return;
  if (!activePi) return;
  // Graceful-degradation mirror of the attach() guard: when the entry-API
  // pair was unavailable, nothing was registered, so no entry may be
  // persisted either (unregistered customType entries render nowhere and
  // would only pollute the session store).
  const piWithEntryApi = activePi as unknown as {
    registerEntryRenderer?: (type: string, renderer: EntryRenderFn) => void;
    appendEntry?: (type: string, data?: unknown) => void;
  };
  if (typeof piWithEntryApi.registerEntryRenderer !== "function") return;
  if (typeof piWithEntryApi.appendEntry !== "function") {
    trace("lifecycle-events: appendEntry unavailable; lifecycle line dropped");
    return;
  }
  try {
    // No pre-formatted content slot: the renderer computes display text at
    // render time from entry.data (see attach()).
    piWithEntryApi.appendEntry(CUSTOM_TYPE, details);
  } catch (err) {
    trace(`lifecycle-events: appendEntry failed: ${(err as Error).message}`);
  }
}
