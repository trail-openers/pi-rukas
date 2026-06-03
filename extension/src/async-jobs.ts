import type { Writable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as dispatchDeck from "./dispatch-deck.ts";
import * as lifecycle from "./lifecycle-events.ts";
import type { RunningState } from "./progress.ts";
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
function formatSingleReport(jobId: string, label: string, result: DispatchResult): string {
  const turns = result.usage?.turns ?? 0;
  const elapsed = fmtElapsed(result.ms);
  const status = result.ok ? "finished" : `FAILED (exit ${result.exitCode ?? "?"})`;
  const head = `[ensemble:async] Subagent \`${label}\` (job ${jobId}) ${status} — ${turns} turns, ${elapsed}${fmtUsage(result)}`;
  const body = result.text?.trim() || "(no output)";
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
}

/**
 * Fire a single async job. Returns immediately with the jobId; the tool's
 * execute() should also return immediately. The report is delivered to the
 * parent via pi.sendUserMessage when the work resolves.
 */
export function startJob(pi: ExtensionAPI, input: StartJobInput): { jobId: string } {
  const jobId = newJobId();
  const abort = new AbortController();
  const state: SingleJobState = {
    kind: "single",
    jobId,
    role: input.role,
    label: input.label,
    startedAt: Date.now(),
    abort,
  };
  jobs.set(jobId, state);

  if (!input.skipDeck) {
    dispatchDeck.startEntry(jobId, { label: input.label, role: input.role });
  }
  lifecycle.emitDispatched(jobId, input.label, input.role);

  const hooks: WorkHooks = {
    onProgress: (progress) => {
      if (!input.skipDeck) dispatchDeck.updateEntry(jobId, progress);
    },
    onStdin: (stdin) => {
      childHandles.set(jobId, { stdin, label: input.label, role: input.role });
    },
  };

  void input.work(abort.signal, hooks).then(
    (result) => {
      jobs.delete(jobId);
      childHandles.delete(jobId);
      if (!input.skipDeck) dispatchDeck.clearEntry(jobId);
      if (result.ok) {
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
      const report = formatSingleReport(jobId, input.label, result);
      deliverReport(pi, report);
      trace(`async job ${jobId} (${input.label}) finished in ${result.ms}ms`);
    },
    (err: Error) => {
      jobs.delete(jobId);
      childHandles.delete(jobId);
      if (!input.skipDeck) dispatchDeck.clearEntry(jobId);
      lifecycle.emitFailed(jobId, input.label, input.role, Date.now() - state.startedAt);
      const report = formatFailReport(jobId, input.label, err);
      deliverReport(pi, report);
      trace(`async job ${jobId} (${input.label}) failed: ${err.message}`);
    },
  );

  trace(`async job ${jobId} (${input.label}) started`);
  return { jobId };
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
    const memberHooks: WorkHooks = {
      onProgress: (progress) => dispatchDeck.updateEntry(jobId, progress),
      onStdin: (stdin) => {
        childHandles.set(jobId, { stdin, label: m.label, role: m.role });
      },
    };

    void m
      .work(memberAbort.signal, memberHooks)
      .then(
        (result) => {
          jobs.delete(jobId);
          childHandles.delete(jobId);
          dispatchDeck.clearEntry(jobId);
          memberResults.push({ jobId, label: m.label, result });
        },
        (err: Error) => {
          jobs.delete(jobId);
          childHandles.delete(jobId);
          dispatchDeck.clearEntry(jobId);
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

/** Kill everything in flight. Called from session_end so we don't orphan children. */
export function killAllJobs(): number {
  let n = 0;
  for (const job of jobs.values()) {
    job.abort.abort();
    n++;
  }
  return n;
}

/** Hooked into the extension `session_end` event (or comparable shutdown signal). */
export function registerAsyncJobsLifecycle(pi: ExtensionAPI): void {
  // Pi's extension API doesn't expose a uniform "session_end" event today, so
  // we register on whatever lifecycle signal is available. If none, the
  // extension process exit will tear down children via SIGTERM anyway.
  const anyPi = pi as unknown as {
    on?: (event: string, handler: () => void | Promise<void>) => void;
  };
  anyPi.on?.("session_end", () => {
    const n = killAllJobs();
    if (n > 0) trace(`session_end: aborted ${n} in-flight async jobs`);
  });
  anyPi.on?.("session_shutdown", () => {
    const n = killAllJobs();
    if (n > 0) trace(`session_shutdown: aborted ${n} in-flight async jobs`);
  });
}
