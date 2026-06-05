/**
 * Deterministic session summary written to vipune on session_shutdown (#23).
 *
 * PM is already instructed (in agents-base/project-manager.md and
 * pi-prompts/work.md) to `vipune add '…'` at the end of each workflow.
 * That's prompt-discipline and fails on interrupted sessions, abandoned
 * /work cycles, or PMs that simply forget. This module makes the write
 * deterministic — it fires from Pi's session_shutdown hook with a
 * structured extract of what the session did.
 *
 * Design rules:
 *   - NO LLM call. The summary is purely extracted from session state we
 *     already have (dispatch counts, outcomes, cwd, duration). Adding a
 *     summarisation pass at shutdown would burn tokens and add latency to
 *     quit.
 *   - Opt-in via `PI_ENSEMBLE_AUTOSAVE=1`. Off by default — we don't want
 *     surprise writes to anyone's vipune.
 *   - Skip on `reason !== "quit"` (reload/fork/resume are not session
 *     boundaries we want to memorialise).
 *   - Skip when nothing meaningful happened (no dispatches).
 *   - Truncate to 1000 chars. Vipune-friendly bounded fact, not an essay.
 *   - Tolerate vipune-not-installed / vipune-failed silently. This is
 *     opportunistic memory, not load-bearing.
 *
 * Concurrency: the `facts` record is mutated from async-jobs settle paths
 * (recordDispatch on startJob/startBatch, recordOutcome in both success and
 * error handlers). All mutations run on Node's single-threaded event loop —
 * each settle handler is one synchronous turn — so there's no true race on
 * the counters. If we ever introduce a Worker-thread or sub-process settle
 * path this assumption breaks and the counters need explicit locking.
 */

import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";

const MAX_SUMMARY_CHARS = 1000;
const VIPUNE_TIMEOUT_MS = 5000;

interface SessionFacts {
  startedAt: number;
  cwd: string;
  /** Dispatches keyed by role. e.g. { developer: 3, ops: 1, explore: 2 } */
  dispatchesByRole: Record<string, number>;
  outcomes: { completed: number; failed: number };
}

const facts: SessionFacts = {
  startedAt: Date.now(),
  cwd: process.cwd(),
  dispatchesByRole: {},
  outcomes: { completed: 0, failed: 0 },
};

function isEnabled(): boolean {
  return process.env.PI_ENSEMBLE_AUTOSAVE === "1";
}

/** Called by async-jobs.startJob/startBatch on every dispatch. */
export function recordDispatch(role: string): void {
  facts.dispatchesByRole[role] = (facts.dispatchesByRole[role] ?? 0) + 1;
}

/** Called by async-jobs settle paths to track outcome counts. */
export function recordOutcome(ok: boolean): void {
  if (ok) facts.outcomes.completed += 1;
  else facts.outcomes.failed += 1;
}

/** Test-only — purge accumulated state between cases. */
export function reset(): void {
  facts.startedAt = Date.now();
  facts.cwd = process.cwd();
  facts.dispatchesByRole = {};
  facts.outcomes = { completed: 0, failed: 0 };
}

/** Test-only snapshot of accumulated facts. */
export function snapshot(): SessionFacts {
  return {
    startedAt: facts.startedAt,
    cwd: facts.cwd,
    dispatchesByRole: { ...facts.dispatchesByRole },
    outcomes: { ...facts.outcomes },
  };
}

/** True when the session has any dispatch — otherwise nothing worth saving. */
export function hadMeaningfulWork(): boolean {
  return Object.values(facts.dispatchesByRole).some((n) => n > 0);
}

function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  if (min < 60) return `${min}m${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h${remMin}m`;
}

/** Pure extract from accumulated session facts — no LLM call, no async IO. */
export function buildSessionSummary(now: number = Date.now()): string {
  const elapsed = fmtElapsed(now - facts.startedAt);
  const date = new Date(facts.startedAt).toISOString().slice(0, 16).replace("T", " ");
  const cwdName = facts.cwd.split("/").pop() || facts.cwd;

  const total = Object.values(facts.dispatchesByRole).reduce((a, b) => a + b, 0);
  const roleBreakdown =
    total > 0
      ? Object.entries(facts.dispatchesByRole)
          .sort(([, a], [, b]) => b - a)
          .map(([role, n]) => `${n} ${role}`)
          .join(", ")
      : "no dispatches";

  let outcomeNote: string;
  if (total === 0) {
    outcomeNote = "";
  } else if (facts.outcomes.failed === 0) {
    outcomeNote = " · all completed cleanly";
  } else {
    outcomeNote = ` · ${facts.outcomes.completed} ok, ${facts.outcomes.failed} failed`;
  }

  const summary = `session ${date} (${elapsed}) · cwd=${cwdName} · ${total} dispatch${total === 1 ? "" : "es"} (${roleBreakdown})${outcomeNote}`;
  return summary.length <= MAX_SUMMARY_CHARS
    ? summary
    : `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

/**
 * Write the summary to vipune. Best-effort: failures are logged via trace
 * (gated by PI_ENSEMBLE_DEBUG) but don't propagate — autosave is
 * opportunistic memory, not a load-bearing path.
 *
 * Uses execFileSync (not exec/execSync) — the summary text is passed as a
 * raw argv element, no shell interpolation; injection-safe by construction.
 * The synchronous variant is appropriate because Pi awaits session_shutdown
 * handlers; an async spawn would risk being abandoned mid-call.
 *
 * `opts.binaryPath` defaults to `"vipune"` (PATH lookup). Tests pass an
 * absolute path to a stub so the ENOENT and timeout failure paths can be
 * exercised without depending on the test runner's PATH resolution
 * (Bun's child_process resolves PATH at process startup, not call time).
 */
export function writeToVipune(summary: string, opts: { binaryPath?: string } = {}): boolean {
  const binary = opts.binaryPath ?? "vipune";
  try {
    execFileSync(binary, ["add", summary], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: VIPUNE_TIMEOUT_MS,
    });
    trace(`session-autosave: wrote summary to vipune (${summary.length} chars)`);
    return true;
  } catch (err) {
    trace(`session-autosave: vipune write failed: ${(err as Error).message}`);
    return false;
  }
}

interface SessionShutdownEvent {
  reason?: string;
  targetSessionFile?: string;
}

export function attach(pi: ExtensionAPI): void {
  const piWithOn = pi as unknown as {
    on?: (event: string, handler: (event: SessionShutdownEvent) => Promise<void> | void) => void;
  };
  piWithOn.on?.("session_shutdown", async (event: SessionShutdownEvent) => {
    if (!isEnabled()) return;
    // Skip on reload / fork / resume / new — those aren't true session boundaries
    // and we'd double-write the same facts on resume.
    if (event.reason && event.reason !== "quit") return;
    if (!hadMeaningfulWork()) return;

    const summary = buildSessionSummary();
    writeToVipune(summary);
  });
}
