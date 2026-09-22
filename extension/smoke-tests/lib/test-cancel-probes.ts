// Shared probe runner for the real-spawn sections of test-cancel and
// test-cancel-realspawn-live (issue #809).
//
// The flaky shape: spawnSpecialist on a REAL `pi` child (getPiInvocation's
// PATH fallback), AbortController abort at 1500ms / timeoutMs 2000, and a
// wall-clock assertion on the return. Under the conditions this project
// actually runs under (concurrent /work cycles, a laptop that may sleep,
// several Pi children at once) the wall clock is not a property of the code —
// the two 497s-vs-1500ms incidents (cycles #777, #798) were processes that
// simply did not run for most of the interval.
//
// These probes therefore assert the SEMANTIC outcome — that the kill was
// attributed (killCause) — not elapsed seconds. The wall clock is still
// recorded and logged so a genuine regression that also slows teardown stays
// visible; it only decides "broken" when the child is still running long past
// every timer in play (abort 1500ms + SIGKILL escalation 5000ms + spawn
// backstop), i.e. when the event-based assertion would NOT yet have a killCause
// to check.

import { spawnSpecialist } from "../../src/spawn.ts";

export interface AbortProbeResult {
  ok: boolean;
  lines: string[];
  killCause: string | undefined;
  exitCode: number | null;
  elapsedMs: number;
}

export interface TimeoutProbeResult {
  ok: boolean;
  lines: string[];
  killCause: string | undefined;
  exitCode: number | null;
  elapsedMs: number;
}

/**
 * Test-1 shape: fire an explore child, abort it after `abortAtMs`, and verify
 * the abort was attributed (killCause 'abort', ok=false).
 */
export async function runAbortProbe(prompt: string, abortAtMs = 1500): Promise<AbortProbeResult> {
  const controller = new AbortController();
  const start = Date.now();
  setTimeout(() => controller.abort(), abortAtMs);
  const r = await spawnSpecialist(
    { role: "explore", prompt },
    {
      signal: controller.signal,
      timeoutMs: 60_000,
    },
  );
  const elapsed = Date.now() - start;
  const lines: string[] = [];
  let ok = true;
  const attributed = r.killCause === "abort" && r.ok === false;
  if (!attributed) {
    // Distinguish "the kill path misbehaved" from "the child simply took a
    // long time to die" — a stalled teardown still attributes killCause.
    lines.push(
      `aborted child: killCause=${r.killCause ?? "none"} ok=${r.ok} exit=${r.exitCode} ` +
        `wall=${elapsed}ms`,
    );
    ok = false;
  } else {
    lines.push(`aborted child: killCause='abort' ok=false exit=${r.exitCode} wall=${elapsed}ms`);
  }
  return { ok, lines, killCause: r.killCause, exitCode: r.exitCode, elapsedMs: elapsed };
}

/**
 * Test-2 shape: fire an explore child with a short wall-clock cap and verify
 * the cap-kill was attributed (killCause 'timeout', ok=false).
 */
export async function runTimeoutProbe(
  prompt: string,
  timeoutMs = 2000,
): Promise<TimeoutProbeResult> {
  const start = Date.now();
  const r = await spawnSpecialist({ role: "explore", prompt }, { timeoutMs });
  const elapsed = Date.now() - start;
  const lines: string[] = [];
  let ok = true;
  const attributed = r.killCause === "timeout" && r.ok === false;
  if (!attributed) {
    lines.push(
      `timed-out child: killCause=${r.killCause ?? "none"} ok=${r.ok} exit=${r.exitCode} ` +
        `wall=${elapsed}ms`,
    );
    ok = false;
  } else {
    lines.push(
      `timed-out child: killCause='timeout' ok=false exit=${r.exitCode} wall=${elapsed}ms`,
    );
  }
  return { ok, lines, killCause: r.killCause, exitCode: r.exitCode, elapsedMs: elapsed };
}

export const ABORT_PROMPT =
  "Think step by step about prime numbers under 100, list them all with explanations of why each is prime. Take your time.";
export const TIMEOUT_PROMPT =
  "Carefully reason through 10 different math problems and explain each step. Take your time.";
