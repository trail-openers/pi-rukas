#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: #308/#309 failure cause taxonomy tests (classifyFailureCause /
 * failureCauseReason) via testFailureCauseTaxonomy().
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { formatSingleReport } from "../src/async-jobs.ts";
import { isRateLimit429Msg } from "../src/types.ts";
import { classifyFailureCause, failureCauseReason } from "../src/work-driver-failure-taxonomy.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// ---------------------------------------------------------------------------
// #308/#309 — Failure cause taxonomy tests
// ---------------------------------------------------------------------------

async function testFailureCauseTaxonomy() {
  console.log("--- failure-cause-taxonomy (#308/#309) ---");

  // Helper for dispatch-failed event shape
  const mkEvent = (
    overrides: Partial<{
      kind: string;
      errorTail?: string;
      killCause?: string;
      providerMessage?: string;
    }> = {},
  ) => ({
    kind: "dispatch-failed" as const,
    errorTail: undefined,
    killCause: undefined,
    providerMessage: undefined,
    ...overrides,
  });

  // --- classifyFailureCause: timeout self-kill never retries ---
  {
    const cls = classifyFailureCause(mkEvent({ killCause: "timeout", kind: "dispatch-failed" }));
    assert(cls.cause === "self-killed:timeout", "timeout → self-killed:timeout");
    assert(cls.shouldRetry === false, "timeout → shouldRetry=false");
    assert(cls.maxRetries === 0, "timeout → maxRetries=0");
  }

  // --- classifyFailureCause: inactivity retries at most once ---
  {
    const cls = classifyFailureCause(mkEvent({ killCause: "inactivity", kind: "dispatch-failed" }));
    assert(cls.cause === "self-killed:inactivity", "inactivity → self-killed:inactivity");
    assert(cls.shouldRetry === true, "inactivity → shouldRetry=true");
    assert(cls.maxRetries === 1, "inactivity → maxRetries=1");
  }

  // --- classifyFailureCause: abort never retries ---
  {
    const cls = classifyFailureCause(mkEvent({ killCause: "abort", kind: "dispatch-failed" }));
    assert(cls.cause === "self-killed:abort", "abort → self-killed:abort");
    assert(cls.shouldRetry === false, "abort → shouldRetry=false");
    assert(cls.maxRetries === 0, "abort → maxRetries=0");
  }

  // --- classifyFailureCause: 429 rate-limit never retries ---
  {
    const cls = classifyFailureCause(
      mkEvent({
        kind: "dispatch-failed-provider",
        providerMessage:
          "Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
      }),
    );
    assert(cls.cause === "rate-limited:429", "429 → rate-limited:429");
    assert(cls.shouldRetry === false, "429 → shouldRetry=false");
    assert(cls.maxRetries === 0, "429 → maxRetries=0");
  }

  // --- classifyFailureCause: transport severance retries ---
  {
    const cls = classifyFailureCause(mkEvent({ kind: "dispatch-failed-provider" }));
    assert(cls.cause === "provider-severed", "errorStop → provider-severed");
    assert(cls.shouldRetry === true, "provider-severed → shouldRetry=true");
    assert(cls.maxRetries >= 2, "provider-severed → maxRetries >= 2 (adversarial needs depth)");
  }

  // --- classifyFailureCause: generic crash retries once ---
  {
    const cls = classifyFailureCause(mkEvent({ errorTail: "segmentation fault" }));
    assert(cls.cause === "crashed", "generic errorTail → crashed");
    assert(cls.shouldRetry === true, "crashed → shouldRetry=true");
    assert(cls.maxRetries === 1, "crashed → maxRetries=1");
  }

  // --- classifyFailureCause: unknown event kind → crashed-unknown (never retries) ---
  {
    const cls = classifyFailureCause(mkEvent({ kind: "unknown-event-type" }));
    assert(cls.cause === "crashed-unknown", "unknown kind → crashed-unknown");
    assert(cls.shouldRetry === false, "crashed-unknown → shouldRetry=false");
    assert(cls.maxRetries === 0, "crashed-unknown → maxRetries=0");
  }

  // --- failureCauseReason: operator-facing strings ---
  {
    const reasonTimeout = failureCauseReason(mkEvent({ killCause: "timeout" }));
    assert(
      reasonTimeout.includes("wall-clock timeout"),
      `timeout reason mentions timeout: ${reasonTimeout}`,
    );

    const reasonInactivity = failureCauseReason(mkEvent({ killCause: "inactivity" }));
    assert(
      reasonInactivity.includes("inactivity watchdog"),
      `inactivity reason mentions inactivity: ${reasonInactivity}`,
    );

    const reasonAbort = failureCauseReason(mkEvent({ killCause: "abort" }));
    assert(reasonAbort.includes("abort"), `abort reason mentions abort: ${reasonAbort}`);

    const reason429 = failureCauseReason(
      mkEvent({
        kind: "dispatch-failed-provider",
        providerMessage:
          "Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
      }),
    );
    assert(
      reason429.includes("429") && reason429.includes("cannot help"),
      `429 reason names rate-limit: ${reason429}`,
    );

    const reasonSevered = failureCauseReason(mkEvent({ kind: "dispatch-failed-provider" }));
    assert(
      reasonSevered.includes("provider/transport"),
      `severed reason names provider error: ${reasonSevered}`,
    );
  }

  // --- formatSingleReport: self-killed timeout ---
  {
    const report = formatSingleReport(
      "job-1",
      "developer",
      mkResult({
        ok: false,
        exitCode: 137,
        killCause: "timeout",
        killBudgetMs: 90 * 60 * 1000,
        text: "",
      }),
    );
    assert(
      report.includes("self-killed"),
      `self-kill timeout is tagged distinctly: ${report.split("\n")[0]}`,
    );
    assert(
      !report.includes("terminated mid-stream"),
      "self-kill timeout does NOT emit terminated mid-stream badge",
    );
    assert(
      !report.includes("FAILED-PROVIDER-ERROR"),
      "self-kill timeout is NOT tagged as provider error",
    );
  }

  // --- formatSingleReport: self-killed inactivity ---
  {
    const report = formatSingleReport(
      "job-2",
      "ops",
      mkResult({
        ok: false,
        exitCode: 143,
        killCause: "inactivity",
        text: "",
      }),
    );
    assert(
      report.includes("inactivity"),
      `self-kill inactivity is tagged distinctly: ${report.split("\n")[0]}`,
    );
    assert(
      !report.includes("FAILED-PROVIDER-ERROR"),
      "self-kill inactivity is NOT tagged as provider error",
    );
    assert(
      !report.includes("terminated mid-stream"),
      "self-kill inactivity does NOT emit terminated mid-stream badge",
    );
  }

  // --- formatSingleReport: 429 rate-limit ---
  {
    const report = formatSingleReport(
      "job-3",
      "developer",
      mkResult({
        ok: true,
        exitCode: 0,
        errorStop: {
          reason: "error",
          message: "Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
        },
        text: "",
      }),
    );
    assert(report.includes("429"), `429 is named in report: ${report.split("\n")[0]}`);
    assert(report.includes("cannot help"), "429 report states retrying cannot help");
    assert(
      !report.includes("terminated mid-stream"),
      "429 does NOT emit terminated mid-stream badge",
    );
    assert(!report.includes("FAILED-PROVIDER-ERROR"), "429 is NOT tagged as FAILED-PROVIDER-ERROR");
  }

  // --- formatSingleReport: genuine provider error (errorStop, no 429) ---
  {
    const report = formatSingleReport(
      "job-4",
      "developer",
      mkResult({
        ok: true,
        exitCode: 0,
        errorStop: {
          reason: "error",
          message: "TypeError: fetch failed",
        },
        text: "partial work output",
      }),
    );
    assert(
      report.includes("FAILED-PROVIDER-ERROR"),
      `genuine provider error is tagged: ${report.split("\n")[0]}`,
    );
    assert(
      report.includes("TypeError: fetch failed"),
      "provider error message is surfaced in report",
    );
  }

  // --- formatSingleReport: abort ---
  {
    const report = formatSingleReport(
      "job-5",
      "ops",
      mkResult({
        ok: false,
        exitCode: 130,
        killCause: "abort",
        text: "",
      }),
    );
    assert(
      report.includes("cancelled") || report.includes("abort"),
      `abort is named distinctly: ${report.split("\n")[0]}`,
    );
    assert(!report.includes("FAILED-PROVIDER-ERROR"), "abort is NOT tagged as provider error");
    assert(
      !report.includes("terminated mid-stream"),
      "abort does NOT emit terminated mid-stream badge",
    );
  }

  // --- F1 regression: failureCauseReason with killCause overrides kind ---
  // The RETRY_ONCE branch (adversarial/lens-review) now calls
  // failureCauseReason(tail) instead of the raw "provider error" / "subagent failed"
  // strings. This ensures killCause is surfaced even when kind is
  // dispatch-failed-provider (e.g. a 429 or wall-clock self-kill).
  {
    // dispatch-failed-provider with killCause:timeout → reason names timeout, NOT "provider error"
    const timeoutProvider = failureCauseReason(
      mkEvent({
        kind: "dispatch-failed-provider",
        killCause: "timeout",
      }),
    );
    assert(
      timeoutProvider.includes("wall-clock timeout") || timeoutProvider.includes("killed"),
      `F1: RETRY_ONCE timeout reason names self-kill (got: ${timeoutProvider})`,
    );
    assert(
      !timeoutProvider.includes("provider error"),
      `F1: RETRY_ONCE timeout reason must NOT say "provider error" (got: ${timeoutProvider})`,
    );

    // dispatch-failed with killCause:timeout → reason names timeout, NOT "subagent failed"
    const timeoutFailed = failureCauseReason(
      mkEvent({
        kind: "dispatch-failed",
        killCause: "timeout",
        errorTail: "some trailing error text",
      }),
    );
    assert(
      timeoutFailed.includes("wall-clock timeout") || timeoutFailed.includes("killed"),
      `F1: RETRY_ONCE timeout (dispatch-failed) reason names self-kill (got: ${timeoutFailed})`,
    );
    assert(
      !timeoutFailed.includes("subagent failed"),
      `F1: RETRY_ONCE timeout reason must NOT say "subagent failed" (got: ${timeoutFailed})`,
    );
  }

  // --- F2: shared 429 pattern prevents formatSingleReport / startJob lifecycle disagreement ---
  // Both formatSingleReport and startJob's lifecycle handler (async-jobs.ts) use
  // isRateLimit429Msg. Verify the shared helper matches the patterns we expect
  // so the two paths cannot disagree.
  {
    // Standard 429 message from Pi
    assert(
      isRateLimit429Msg(
        "Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
      ),
      "F2: 429 with 'retry delay' + '429 status' is detected",
    );

    // Variant: 429 status first
    assert(
      isRateLimit429Msg("HTTP 429 status — rate limit exceeded"),
      "F2: '429 status' alone is detected",
    );

    // Variant: retry delay without explicit 429 word
    assert(
      isRateLimit429Msg("Provider requested 120s retry delay due to 429 rate-limit"),
      "F2: 'retry delay' + '429' in any order is detected",
    );

    // Non-429 provider error — must NOT match
    assert(
      !isRateLimit429Msg("TypeError: fetch failed"),
      "F2: generic error is NOT detected as 429",
    );

    // undefined input
    assert(!isRateLimit429Msg(undefined), "F2: undefined message is NOT detected as 429");

    // formatSingleReport for 429 must NOT contain "terminated mid-stream"
    // (this is the user-visible consequence of the lifecycle + report agreement)
    const r429 = formatSingleReport(
      "f2-job",
      "developer",
      mkResult({
        ok: true,
        exitCode: 0,
        errorStop: {
          reason: "error",
          message: "Server requested 86399s retry delay (max: 60s). 429 status code (no body)",
        },
        text: "partial output",
      }),
    );
    assert(
      !r429.includes("terminated mid-stream"),
      "F2: 429 report must NOT contain terminated mid-stream",
    );
    assert(r429.includes("429"), "F2: 429 report MUST name the rate-limit");
  }
}

await testFailureCauseTaxonomy();

console.log(`\nexit ${exit}`);
process.exit(exit);
