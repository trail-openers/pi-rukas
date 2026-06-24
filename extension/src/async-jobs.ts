import type { Writable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as dispatchDeck from "./dispatch-deck.ts";
import * as lifecycle from "./lifecycle-events.ts";
import type { RunningState } from "./progress.ts";
import * as sessionAutosave from "./session-autosave.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

function totalTokens(result: DispatchResult): number {
  const u = result.usage;
  if (!u) return 0;
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

/**
 * Async-dispatch job registry.
 *
 * Every dispatch tool is fire-and-forget from the LLM's POV: the tool returns
 * a `{ jobId }` handle immediately, the child runs in the background under our
 * supervision, and on completion we push the result back to the parent agent
 * via `pi.sendUserMessage(report, { deliverAs: "steer" })`. Pi delivers the
 * steer as a fresh user turn → new `agent_start` → parent picks up.
 *
 * Why this matters: a synchronous tool call locks the user out of the parent
 * for the full duration of the dispatch (often minutes). Async means the user
 * can interact with the parent at any time while children run in the background.
 *
 * Invariants enforced here (see issue #19):
 *   1. The parent agent ONLY ever sees the child's final assistant text in the
 *      steer report — never the full transcript, never per-turn output.
 *   2. The report header is ~100 chars (jobId, role, turns, elapsed, cost).
 *      Going async adds zero context bloat over sync dispatch.
 *   3. Batched orchestrators (dispatch_parallel, lens review) fire a SINGLE
 *      steer when ALL children complete — never N out-of-order arrivals.
 */

type JobKind = "single" | "batch-member" | "batch-orchestrator";

interface SingleJobState {
  kind: "single";
  jobId: string;
  role: string;
  label: string;
  startedAt: number;
  abort: AbortController;
  /**
   * Who consumes the eventual result.
   *
   *   "pm" (default) — the parent PM session. On completion we push a
   *   formatted report to PM via `pi.sendUserMessage(report, { deliverAs:
   *   "steer" })` so the next PM turn picks it up as `[ensemble:async] …`.
   *   This is the contract every dispatch tool (dispatch_specialist,
   *   dispatch_parallel, adversarial_loop, dispatch_lens_review) relies on.
   *
   *   "driver" — the in-process work-driver (PR1 of the workflow-graph
   *   compilation). The driver awaits the `completion` promise returned by
   *   `startJob` directly. We MUST NOT also send the steer report — that
   *   would inject an `[ensemble:async]` user message PM didn't ask for and
   *   confuse the next turn. Driver-owned jobs are 100% in-process; the
   *   completion promise IS the contract.
   *
   * This single field is the integration seam that lets PM-tool dispatch
   * and driver dispatch coexist on the same async-jobs primitive without a
   * second consumer racing for the result.
   */
  ownerKind: "pm" | "driver";
  /**
   * True when this job is an orchestrator that spawns its OWN inner children
   * sequentially (adversarial_loop + future orchestrators). Set at
   * work-function entry via `markOrchestrator`. Independent of whether a
   * child is active right now — so `dispatch_peek` / `dispatch_steer` can
   * still recognise the job as orchestrator-shape and return the
   * "between rounds" status when activeChild is undefined.
   */
  isOrchestrator?: boolean;
  /**
   * For orchestrator-shaped jobs — pointer to whichever inner child is
   * running right now. Updated by the orchestrator's work function via
   * `setOrchestratorActiveChild`. Read by `dispatch_peek` (to surface the
   * active child's last text) and `dispatch_steer` (to route stdin writes
   * to the currently-running inner child). Cleared between rounds →
   * undefined when the orchestrator is idle between phases.
   */
  activeChild?: {
    role: string;
    label: string;
    /** Dispatch-deck key for the active inner spawn (`${runId}/${tag}`). */
    deckKey: string;
    /** Stdin handle for the active inner Pi --mode rpc child. */
    stdin: Writable;
    startedAt: number;
  };
}

interface BatchMemberJobState {
  kind: "batch-member";
  jobId: string;
  role: string;
  label: string;
  startedAt: number;
  abort: AbortController;
  batchId: string;
}

interface BatchOrchestratorJobState {
  kind: "batch-orchestrator";
  jobId: string;
  role: string; // synthetic, describes the batch ("dispatch_parallel", "lens_review")
  label: string;
  startedAt: number;
  abort: AbortController;
  size: number;
  completed: number;
}

type JobState = SingleJobState | BatchMemberJobState | BatchOrchestratorJobState;

// Hard cap on concurrent jobs. Realistic upper bound: a six-pass lens review
// (1 orchestrator + 6 members) plus a parallel batch (1 + ≤8 members) plus a
// few outstanding singles ≈ 25. 50 leaves comfortable headroom; pathological
// dispatch-without-settle scenarios (e.g., a bug in a settle path) are caught
// before the map grows unbounded. Members count against the same cap as
// orchestrators because they share the same memory profile and abort tree.
const MAX_JOBS = 50;
const jobs = new Map<string, JobState>();

function newJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** "12.3k" / "1.2M" / "456" — bounded to 4-5 chars regardless of input size. */
function fmtTokens(n: number | undefined): string {
  if (!n || n <= 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * "12.3k tokens · cerebras/zai-glm-4.7" — the in-context observables we
 * actually care about: how much context this run consumed and which model
 * produced it. Cost is omitted; for users on flat-rate plans (e.g. Cerebras
 * Coder) it's just noise, and per-token billing users can derive their own
 * cost from the token count if needed.
 */
function fmtUsage(result: {
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  model?: string;
  provider?: string;
}): string {
  const u = result.usage;
  const totalTokens = u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0;
  const tokens = totalTokens > 0 ? ` · ${fmtTokens(totalTokens)} tokens` : "";
  const modelTag = result.model
    ? ` · ${result.provider ? `${result.provider}/` : ""}${result.model}`
    : "";
  return `${tokens}${modelTag}`;
}

/**
 * Bounded report. The body is the child's final assistant text (same bytes
 * sync dispatch would have returned). The header is ~100 chars. NEVER includes
 * raw transcript content.
 */
export function formatSingleReport(jobId: string, label: string, result: DispatchResult): string {
  const turns = result.usage?.turns ?? 0;
  const elapsed = fmtElapsed(result.ms);
  // Three-way status: provider error-stop (synthetic empty assistant message,
  // process exited 0 but the conversation didn't actually produce a reply —
  // see DispatchResult.errorStop), process-level FAILED (non-zero exit), or
  // ok. The error-stop case is visually distinct so PM treats it as failure
  // and routes through the cap-hit handoff doctrine (PR #233).
  let status: string;
  if (result.errorStop) {
    status = "FAILED-PROVIDER-ERROR";
  } else if (result.ok) {
    status = "finished";
  } else {
    status = `FAILED (exit ${result.exitCode ?? "?"})`;
  }
  const head = `[ensemble:async] Subagent \`${label}\` (job ${jobId}) ${status} — ${turns} turns, ${elapsed}${fmtUsage(result)}`;
  let body = result.text?.trim() || "(no output)";
  if (result.errorStop) {
    const errMsgLine = result.errorStop.message
      ? `Provider request error: ${result.errorStop.message}`
      : "Provider request error: (no error message captured from pi-ai)";
    body = [
      errMsgLine,
      "Last text below is the agent's pre-failure activity — VERIFY DIRECTLY before assuming progress (worktree may be unchanged).",
      "",
      body,
    ].join("\n");
  }
  const footer = result.ok
    ? "---\nYou started this async dispatch earlier. Continue the workflow."
    : `---\n(See /runs for full transcript at ${result.transcriptPath ?? "ensemble-runs/"}.)`;
  return `${head}\n\n${body}\n\n${footer}`;
}

function formatFailReport(jobId: string, label: string, err: Error): string {
  const tail = (err.message ?? "").slice(-200);
  return [
    `[ensemble:async] Subagent \`${label}\` (job ${jobId}) FAILED before producing output`,
    `error tail: ${tail}`,
    "",
    "(See /runs for any partial transcript.)",
  ].join("\n");
}

interface BatchReportInput {
  batchLabel: string;
  batchId: string;
  startedAt: number;
  members: Array<{
    jobId: string;
    label: string;
    result: DispatchResult | { failed: true; error: string };
  }>;
}

function formatBatchReport(input: BatchReportInput): string {
  const ms = Date.now() - input.startedAt;
  const totalTokens = input.members.reduce((acc, m) => {
    if ("failed" in m.result) return acc;
    const u = m.result.usage;
    return acc + (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0);
  }, 0);
  const okCount = input.members.filter((m) => !("failed" in m.result) && m.result.ok).length;
  const tokenTag = totalTokens > 0 ? ` · ${fmtTokens(totalTokens)} tokens` : "";
  const head = `[ensemble:async] Batch \`${input.batchLabel}\` (batch ${input.batchId}) finished — ${okCount}/${input.members.length} ok, ${fmtElapsed(ms)}${tokenTag}`;
  const sections = input.members.map((m) => {
    if ("failed" in m.result) {
      return `=== ${m.label} (job ${m.jobId}) — FAILED ===\nerror: ${m.result.error.slice(-200)}`;
    }
    const turns = m.result.usage?.turns ?? 0;
    const elapsed = fmtElapsed(m.result.ms);
    const status = m.result.ok ? "ok" : `fail (exit ${m.result.exitCode ?? "?"})`;
    const body = m.result.text?.trim() || "(no output)";
    return `=== ${m.label} (job ${m.jobId}) — ${status} · ${turns} turns · ${elapsed}${fmtUsage(m.result)} ===\n${body}`;
  });
  const footer = "---\nYou started this async batch earlier. Continue the workflow.";
  return `${head}\n\n${sections.join("\n\n")}\n\n${footer}`;
}

/**
 * Per-job child handle — exposes the child's stdin so dispatch_steer (#153)
 * can write `{ type: "steer", message }` RPC commands to a running child.
 * Lives in `childHandles` for the duration of the job; cleared on settle.
 */
interface ChildHandle {
  stdin: Writable;
  label: string;
  role: string;
}

const childHandles = new Map<string, ChildHandle>();

/** Look up a running child's stdin + label by jobId. Used by dispatch_steer.
 *  Returns undefined when the job has already settled (stdin handle cleaned up). */
export function getChildHandle(jobId: string): ChildHandle | undefined {
  return childHandles.get(jobId);
}

/**
 * Orchestrator active-child registry — used by adversarial_loop (and any
 * future orchestrator that fans out internally) to publish "which inner
 * child is running right now" so `dispatch_peek` and `dispatch_steer` can
 * resolve an orchestrator jobId to the active inner child transparently.
 *
 * Pass `null` to clear (between rounds, or after the orchestrator settles).
 * Pass a child descriptor when starting a new inner phase. The descriptor
 * carries the inner spawn's deck key (for peek to look up live state) and
 * stdin handle (for steer to write into).
 */
export function setOrchestratorActiveChild(
  jobId: string,
  child: { role: string; label: string; deckKey: string; stdin: Writable } | null,
): void {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return;
  if (child === null) {
    state.activeChild = undefined;
  } else {
    state.activeChild = { ...child, startedAt: Date.now() };
  }
}

/**
 * Look up the orchestrator's active inner child. Returns undefined when the
 * jobId isn't an orchestrator, or when the orchestrator is between rounds
 * (no active inner child right now). Used by `dispatch_peek` to surface the
 * active child's live state, and by `dispatch_steer` to route the steer.
 */
export function getOrchestratorActiveChild(
  jobId: string,
):
  | { role: string; label: string; deckKey: string; stdin: Writable; startedAt: number }
  | undefined {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return undefined;
  return state.activeChild;
}

/**
 * Mark a job as orchestrator-shaped — called by the orchestrator's work
 * function at entry, BEFORE the first inner round. Tells `dispatch_peek`
 * and `dispatch_steer` to use the active-child resolution path instead of
 * the regular deck snapshot lookup. Idempotent.
 */
export function markOrchestrator(jobId: string): void {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return;
  state.isOrchestrator = true;
}

/**
 * Probe: is this jobId orchestrator-shaped? True if its work function
 * called `markOrchestrator`. Independent of whether an inner child is
 * currently active — so peek/steer can recognise the job between rounds
 * and return the explicit "between rounds" status.
 */
export function isOrchestratorJob(jobId: string): boolean {
  const state = jobs.get(jobId);
  if (!state || state.kind !== "single") return false;
  return state.isOrchestrator === true;
}

/** Live-progress hooks passed to a job's work function. */
export interface WorkHooks {
  /**
   * Forward a child's RunningState update. Wired to the dispatch deck so the
   * footer can render live activity (#117). Work functions should pass this
   * straight through to spawnSpecialist's onProgress option.
   */
  onProgress: (state: RunningState) => void;
  /**
   * Stdin-handle callback (#153). Called once after the child is spawned,
   * before the kickoff prompt is written. Work functions pass this through
   * to spawnSpecialist's onStdin option so the async-jobs registry can
   * record the handle for dispatch_steer lookups.
   */
  onStdin: (stdin: Writable) => void;
  /**
   * Orchestrator-shaped work functions (adversarial_loop) need to know their
   * own job id so they can register the currently-running inner child via
   * `setOrchestratorActiveChild`. Provided to every work function for
   * symmetry; single dispatches ignore it.
   */
  jobId: string;
}

interface StartJobInput {
  /** Human-readable subagent label (role + optional tag, e.g. "code-review-specialist[security]"). */
  label: string;
  /** Role name for telemetry. */
  role: string;
  /**
   * Work function. Receives an AbortSignal tied to our internal abort
   * controller (NOT the tool's exec signal — that one is gone the moment we
   * return from execute()). Should call spawnSpecialist internally and
   * forward `hooks.onProgress` to it.
   */
  work: (signal: AbortSignal, hooks: WorkHooks) => Promise<DispatchResult>;
  /**
   * Skip the automatic dispatch-deck entry. Set true for orchestrators that
   * fan out internally (lens-review, adversarial) and manage their own
   * per-child deck entries — otherwise the orchestrator's "synthetic" row
   * would mask the real children behind it.
   */
  skipDeck?: boolean;
  /**
   * Who consumes the result. Default "pm" — preserves the existing
   * send-as-steer behaviour every dispatch tool depends on. Set "driver"
   * when an in-process caller (e.g. the work-driver) will await the
   * `completion` promise directly; we then skip the sendUserMessage steer
   * so PM doesn't see a `[ensemble:async]` it didn't ask for.
   *
   * See SingleJobState.ownerKind for the full rationale.
   */
  ownerKind?: "pm" | "driver";
}

export interface StartJobHandle {
  jobId: string;
  /**
   * Resolves with the DispatchResult when the work function settles. Always
   * returned. PM-owned callers normally ignore it (the steer is the
   * contract). Driver-owned callers await this to consume the result
   * directly — `deliverReport` is skipped for them so PM never sees an
   * `[ensemble:async]` it didn't initiate.
   *
   * Note: this promise resolves (not rejects) for both ok and failed
   * dispatches — failure is encoded in `result.ok === false` /
   * `result.errorStop`. It DOES reject if the work function throws
   * (transport / spawn-level errors before any DispatchResult is produced).
   * Driver code should catch that explicitly.
   */
  completion: Promise<DispatchResult>;
}

/**
 * Fire a single async job. Returns immediately with the jobId; the tool's
 * execute() should also return immediately. The report is delivered to the
 * parent via pi.sendUserMessage when the work resolves — UNLESS
 * `input.ownerKind === "driver"`, in which case the in-process caller
 * consumes the result via the `completion` promise and the steer is skipped.
 */
export function startJob(pi: ExtensionAPI, input: StartJobInput): StartJobHandle {
  if (jobs.size >= MAX_JOBS) {
    throw new Error(
      `async-jobs: refusing to start job — ${jobs.size} jobs already in flight (cap ${MAX_JOBS}). This usually indicates a stuck settle path; check 'dispatch_status' or restart Pi.`,
    );
  }
  const ownerKind: "pm" | "driver" = input.ownerKind ?? "pm";
  const jobId = newJobId();
  const abort = new AbortController();
  const state: SingleJobState = {
    kind: "single",
    jobId,
    role: input.role,
    label: input.label,
    startedAt: Date.now(),
    abort,
    ownerKind,
  };
  jobs.set(jobId, state);

  if (!input.skipDeck) {
    dispatchDeck.startEntry(jobId, { label: input.label, role: input.role });
  }
  lifecycle.emitDispatched(jobId, input.label, input.role);
  sessionAutosave.recordDispatch(input.role);

  const hooks: WorkHooks = {
    onProgress: (progress) => {
      if (!input.skipDeck) dispatchDeck.updateEntry(jobId, progress);
    },
    onStdin: (stdin) => {
      childHandles.set(jobId, { stdin, label: input.label, role: input.role });
    },
    jobId,
  };

  const completion = input.work(abort.signal, hooks).then(
    (result) => {
      jobs.delete(jobId);
      childHandles.delete(jobId);
      if (!input.skipDeck) dispatchDeck.clearEntry(jobId);
      // Three-way: ok / FAILED-PROVIDER-ERROR / process-exit-failed. The
      // errorStop branch fires when pi-ai turned an HTTP timeout into a
      // synthetic empty assistant message — the process exited 0, but the
      // run didn't actually produce a usable reply. See spawn.ts collapseEvents
      // and the failure transcript in PR #236 for the shape.
      if (result.errorStop) {
        lifecycle.emitErrored(jobId, input.label, input.role, result.ms, totalTokens(result));
      } else if (result.ok) {
        lifecycle.emitCompleted(jobId, input.label, input.role, result.ms, totalTokens(result));
      } else {
        lifecycle.emitFailed(
          jobId,
          input.label,
          input.role,
          result.ms,
          result.exitCode ?? undefined,
        );
      }
      sessionAutosave.recordOutcome(result.ok);
      // Driver-owned jobs skip the steer: the in-process caller is awaiting
      // `completion` and will route the result through the work-driver's
      // state machine. Posting a steer too would inject a duplicate
      // [ensemble:async] message into PM's session and confuse the next turn.
      if (ownerKind === "pm") {
        const report = formatSingleReport(jobId, input.label, result);
        deliverReport(pi, report);
      }
      trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) finished in ${result.ms}ms`);
      return result;
    },
    (err: Error) => {
      jobs.delete(jobId);
      childHandles.delete(jobId);
      if (!input.skipDeck) dispatchDeck.clearEntry(jobId);
      lifecycle.emitFailed(jobId, input.label, input.role, Date.now() - state.startedAt);
      sessionAutosave.recordOutcome(false);
      if (ownerKind === "pm") {
        const report = formatFailReport(jobId, input.label, err);
        deliverReport(pi, report);
      }
      trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) failed: ${err.message}`);
      // Driver-owned callers want the error surfaced via the promise so
      // they can route it into the state machine; PM-owned callers had the
      // failure delivered as a fail-report steer and would have nothing to
      // do with a rejection here. Re-throw uniformly — PM-owned callers
      // ignore the promise.
      throw err;
    },
  );

  // PM-owned callers (every dispatch tool today) destructure only `jobId`
  // and ignore `completion`. Without this suppressor a rejected completion
  // promise would trigger Node's unhandled-rejection warning. The internal
  // .catch attaches an observer — it does NOT consume the rejection from
  // the perspective of any other observer, so a driver-owned caller's
  // `await completion` still throws as expected.
  completion.catch(() => undefined);

  trace(`async job ${jobId} (${input.label}, owner=${ownerKind}) started`);
  return { jobId, completion };
}

interface StartBatchInput {
  batchLabel: string;
  members: Array<{
    label: string;
    role: string;
    work: (signal: AbortSignal, hooks: WorkHooks) => Promise<DispatchResult>;
  }>;
}

/**
 * Fire a batch: spawn all members concurrently, but deliver ONE steer message
 * when ALL members have settled. This preserves the parent's "I called the
 * tool, I expect one return" mental model — async-batched, not async-N-arrivals.
 */
export function startBatch(
  pi: ExtensionAPI,
  input: StartBatchInput,
): { batchId: string; jobIds: string[] } {
  // Batch slot count: 1 orchestrator + N members. Reject up-front rather than
  // letting some members land and others fail mid-construction.
  const required = 1 + input.members.length;
  if (jobs.size + required > MAX_JOBS) {
    throw new Error(
      `async-jobs: refusing to start batch of ${input.members.length} members — would exceed cap (in-flight=${jobs.size}, required=${required}, cap=${MAX_JOBS}). Check 'dispatch_status' or restart Pi.`,
    );
  }
  const batchId = newJobId();
  const startedAt = Date.now();
  const orchestratorAbort = new AbortController();
  const orchestrator: BatchOrchestratorJobState = {
    kind: "batch-orchestrator",
    jobId: batchId,
    role: input.batchLabel,
    label: input.batchLabel,
    startedAt,
    abort: orchestratorAbort,
    size: input.members.length,
    completed: 0,
  };
  jobs.set(batchId, orchestrator);
  lifecycle.emitDispatched(batchId, input.batchLabel, input.batchLabel);

  // Persistent batch summary row (#139). Registered BEFORE members so its
  // seq is lowest and Pi's alphabetical sort places it first on the footer.
  // The label collapses uniform-role batches to "<role>×N" and mixed batches
  // to a generic count; users get e.g. "batch[explore×3]" or "batch[mixed×3]".
  const uniqueRoles = new Set(input.members.map((m) => m.role));
  const batchDeckLabel =
    uniqueRoles.size === 1
      ? `${[...uniqueRoles][0]}×${input.members.length}`
      : `mixed×${input.members.length}`;
  dispatchDeck.startBatchEntry(batchId, {
    label: batchDeckLabel,
    size: input.members.length,
  });

  const memberJobIds: string[] = [];
  const memberResults: BatchReportInput["members"] = [];

  for (const m of input.members) {
    const jobId = newJobId();
    memberJobIds.push(jobId);
    const memberAbort = new AbortController();
    // If the orchestrator aborts (e.g., session_end), cascade to all members.
    orchestratorAbort.signal.addEventListener("abort", () => memberAbort.abort(), { once: true });
    const memberState: BatchMemberJobState = {
      kind: "batch-member",
      jobId,
      role: m.role,
      label: m.label,
      startedAt,
      abort: memberAbort,
      batchId,
    };
    jobs.set(jobId, memberState);

    dispatchDeck.startEntry(jobId, { label: m.label, role: m.role, batchKey: batchId });
    sessionAutosave.recordDispatch(m.role);
    const memberHooks: WorkHooks = {
      onProgress: (progress) => dispatchDeck.updateEntry(jobId, progress),
      onStdin: (stdin) => {
        childHandles.set(jobId, { stdin, label: m.label, role: m.role });
      },
      jobId,
    };

    void m
      .work(memberAbort.signal, memberHooks)
      .then(
        (result) => {
          jobs.delete(jobId);
          childHandles.delete(jobId);
          dispatchDeck.clearEntry(jobId);
          sessionAutosave.recordOutcome(result.ok);
          memberResults.push({ jobId, label: m.label, result });
        },
        (err: Error) => {
          jobs.delete(jobId);
          childHandles.delete(jobId);
          dispatchDeck.clearEntry(jobId);
          sessionAutosave.recordOutcome(false);
          memberResults.push({
            jobId,
            label: m.label,
            result: { failed: true, error: err.message },
          });
        },
      )
      .finally(() => {
        orchestrator.completed++;
        // Advance the batch row's counter so the user sees "1/3 done · 2 running".
        dispatchDeck.updateBatchProgress(batchId, orchestrator.completed);
        if (orchestrator.completed === orchestrator.size) {
          jobs.delete(batchId);
          dispatchDeck.clearBatchEntry(batchId);
          const batchMs = Date.now() - startedAt;
          const anyFailed = memberResults.some((m) => "failed" in m.result || !m.result.ok);
          const tokens = memberResults.reduce((acc, m) => {
            if ("failed" in m.result) return acc;
            return acc + totalTokens(m.result);
          }, 0);
          if (anyFailed) {
            lifecycle.emitFailed(batchId, input.batchLabel, input.batchLabel, batchMs);
          } else {
            lifecycle.emitCompleted(batchId, input.batchLabel, input.batchLabel, batchMs, tokens);
          }
          const report = formatBatchReport({
            batchLabel: input.batchLabel,
            batchId,
            startedAt,
            members: memberResults,
          });
          deliverReport(pi, report);
          trace(
            `async batch ${batchId} (${input.batchLabel}) finished in ${Date.now() - startedAt}ms`,
          );
        }
      });
  }

  trace(`async batch ${batchId} (${input.batchLabel}, n=${input.members.length}) started`);
  return { batchId, jobIds: memberJobIds };
}

/**
 * Push a report back to the parent agent. `deliverAs: "steer"` queues the
 * message during a streaming turn (delivered before the next LLM call) or
 * directly if the agent is idle.
 */
function deliverReport(pi: ExtensionAPI, report: string): void {
  try {
    pi.sendUserMessage(report, { deliverAs: "steer" });
  } catch (err) {
    trace(`async report delivery failed: ${(err as Error).message}`);
  }
}

/** Snapshot of current jobs for dispatch_status (metadata only — never content). */
export interface JobStatusRow {
  jobId: string;
  kind: JobKind;
  role: string;
  label: string;
  elapsedMs: number;
  batchId?: string;
  batchProgress?: { completed: number; size: number };
}

export function jobStatusSnapshot(): JobStatusRow[] {
  const now = Date.now();
  const out: JobStatusRow[] = [];
  for (const job of jobs.values()) {
    const base = {
      jobId: job.jobId,
      kind: job.kind,
      role: job.role,
      label: job.label,
      elapsedMs: now - job.startedAt,
    };
    if (job.kind === "batch-member") {
      out.push({ ...base, batchId: job.batchId });
    } else if (job.kind === "batch-orchestrator") {
      out.push({
        ...base,
        batchProgress: { completed: job.completed, size: job.size },
      });
    } else {
      out.push(base);
    }
  }
  return out;
}

/** Kill one job by id (best-effort — AbortSignal propagates to spawnSpecialist). */
export function killJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.abort.abort();
  return true;
}

/** Kill everything in flight. Called from session_shutdown so we don't orphan children. */
export function killAllJobs(): number {
  let n = 0;
  for (const job of jobs.values()) {
    job.abort.abort();
    n++;
  }
  return n;
}

/**
 * Test-only: forcibly drain the jobs and childHandles maps without going
 * through the abort+settle cycle. Required for tests that use
 * never-resolving work (`new Promise(() => undefined)`) — aborting such a
 * promise emits the signal but the work function never reacts, so the
 * `.then` cleanup that would remove the entry never runs. Production code
 * never wants this; tests need it for clean isolation against the
 * module-level singleton maps.
 */
export function clearJobsForTesting(): void {
  for (const job of jobs.values()) job.abort.abort();
  jobs.clear();
  childHandles.clear();
}

/**
 * Register the session_shutdown handler that aborts in-flight async jobs.
 * Pi's only documented shutdown hook is `session_shutdown` (`session_end`
 * was a guess we dropped in #23); we register against the documented API
 * directly with proper typing instead of the previous `as unknown as` cast.
 */
export function registerAsyncJobsLifecycle(pi: ExtensionAPI): void {
  const piWithOn = pi as unknown as {
    on?: (event: "session_shutdown", handler: () => Promise<void> | void) => void;
  };
  piWithOn.on?.("session_shutdown", () => {
    const n = killAllJobs();
    if (n > 0) trace(`session_shutdown: aborted ${n} in-flight async jobs`);
  });
}
