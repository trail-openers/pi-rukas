// Shared probe runner for the fake-pi sections of test-cancel and the
// real-spawn sections of test-cancel-realspawn-live (issue #809).
//
// The wall-clock rationale (why these probes assert killCause attribution
// instead of elapsed seconds, what the two 497s-vs-1500ms incidents were,
// and the cost tradeoff of keeping the real-spawn variant as a -live test)
// is documented in test-cancel.ts's file header. This file is the shared
// implementation of that design.

import { spawnSpecialist } from "../../src/spawn.ts";

// One shape for both probes: the only real difference between them is whether
// an abort signal is in flight. Keep it a single interface — the two are the
// same concept (a spawn probe returning an attributed-kill result), and two
// identical interfaces silently drift the moment a field is added to one.
export interface ProbeResult {
  ok: boolean;
  lines: string[];
  killCause: string | undefined;
  exitCode: number | null;
  elapsedMs: number;
}

// Small shared test-harness helper. Each smoke test file in this suite is
// standalone and self-terminated (a single `process.exit(exit)` at the end)
// with its own local exit counter; `assert` is the one piece this PR
// extracted so both cancel-test files use the same shape. It prints the
// same ✓/✗ line as the per-file helpers it replaced; the exit code is
// tracked by the caller's own counter (see each test file).
export function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
  }
}

/**
 * The abort probe's pass/fail predicate, exported so test-cancel's self-check
 * exercises the SAME predicate the probe itself uses — a test that cannot go
 * RED is decorative (the shape test-file-size-limit.ts applies to itself).
 */
export function abortProbePasses(p: ProbeResult): boolean {
  return p.killCause === "abort" && p.ok === false;
}

// The timeout probe's pass/fail predicate, same reasoning as above.
export function timeoutProbePasses(p: ProbeResult): boolean {
  return p.killCause === "timeout" && p.ok === false;
}

// One kill probe; the abort variant is the signal variant of this. The
// `controller` timer is cleared in a finally so a late abort can never fire
// after spawnSpecialist has resolved (which would keep the event loop alive
// for the remainder of abortAtMs and could attribute a kill the probe already
// finished on). The pass/fail check uses the exported predicate so the
// self-check in test-cancel exercises the same code that actually runs.
async function runKillProbe(
  prompt: string,
  opts: { controller?: AbortController; abortAtMs?: number; timeoutMs: number },
  expected: "abort" | "timeout",
): Promise<ProbeResult> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.controller && opts.abortAtMs !== undefined) {
    timer = setTimeout(() => opts.controller.abort(), opts.abortAtMs);
  }
  let r: Awaited<ReturnType<typeof spawnSpecialist>>;
  try {
    r = await spawnSpecialist(
      { role: "explore", prompt },
      {
        signal: opts.controller?.signal,
        timeoutMs: opts.timeoutMs,
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  const elapsed = Date.now() - start;
  const attributed =
    expected === "abort"
      ? r.killCause === "abort" && r.ok === false
      : r.killCause === "timeout" && r.ok === false;
  const label = expected === "abort" ? "aborted child" : "timed-out child";
  const lines = attributed
    ? [`${label}: killCause='${expected}' ok=false exit=${r.exitCode} wall=${elapsed}ms`]
    : [
        `${label}: killCause=${r.killCause ?? "none"} ok=${r.ok} exit=${r.exitCode} ` +
          `wall=${elapsed}ms`,
      ];
  return {
    ok: attributed,
    lines,
    killCause: r.killCause,
    exitCode: r.exitCode,
    elapsedMs: elapsed,
  };
}

/**
 * Abort probe: fire an explore child, abort it after `abortAtMs`, and verify
 * the kill was attributed (killCause 'abort', ok=false).
 */
export function runAbortProbe(prompt: string, abortAtMs = 1500): Promise<ProbeResult> {
  const controller = new AbortController();
  return runKillProbe(prompt, { controller, abortAtMs, timeoutMs: 60_000 }, "abort");
}

/**
 * Timeout probe: fire an explore child with a short wall-clock cap and verify
 * the cap-kill was attributed (killCause 'timeout', ok=false).
 */
export function runTimeoutProbe(prompt: string, timeoutMs = 2000): Promise<ProbeResult> {
  return runKillProbe(prompt, { timeoutMs }, "timeout");
}

export const ABORT_PROMPT =
  "Think step by step about prime numbers under 100, list them all with explanations of why each is prime. Take your time.";
export const TIMEOUT_PROMPT =
  "Carefully reason through 10 different math problems and explain each step. Take your time.";
