#!/usr/bin/env bun
/**
 * #1020 — DriverHost parity. The same stubbed /work cycle, run under the
 * Pi-session host (piSessionHost wrapping a recording ExtensionAPI stub) and a
 * recording test host, must leave identical state and eventLog once run-local
 * values are normalised. Messages are compared at the bottom of each host (what
 * reaches the transport), not at the driver call site, so the message
 * comparison can fail if piSessionHost drops or rewrites a send.
 *
 * Scope of the invariant — driver-level sends only. `dispatchFn` is stubbed, so
 * `dispatchCore` / `startJob` (the DispatchHost half: report delivery and the
 * slow-run steer) never run under either host and are NOT compared here; their
 * steer delivery is covered by test-async-dispatch.ts. Plan / research / lens-review are wired to DriverHost but not
 * compared here either.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type DriverHost, piSessionHost } from "../src/work-driver-host.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const EXPLORE_REPLY = [
  "INTENT-VERDICT: proceed",
  "",
  "## Spec",
  "",
  "### Intent",
  "Implement issue #1020.",
  "",
  "### Deliverables",
  "- d1: implement the change [paths: src/a.ts]",
].join("\n");

const mockIssueBody = async (issue: number) => ({
  stdout: `title:\tmock #${issue}\nstate:\tOPEN\n\nnon-empty mock body`,
});

/** A message as it reached the transport: text plus the deliverAs it carried. */
interface Sent {
  text: string;
  deliverAs: unknown;
}

const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
/** Wall-clock fields: epoch-ms numbers under `*At` / `at` keys. */
const TIME_KEY = /(At|^at)$/;
/** Elapsed-time fields: real measured durations, never equal across two runs. */
const DURATION_KEY = /^(ms|elapsedMs|durationMs)$/;
/** Keys holding generated job ids (per run, not comparable across runs). */
const JOB_KEY = /^(jobId|inFlightJobIds|jobIds)$/;

/**
 * Normalise a value so neither side can differ by a run-local value: the tmp
 * repo path becomes <repo>, wall-clock fields become <ts>, measured durations
 * become <ms>, and each generated job id becomes a stable first-seen
 * placeholder (<job1>, <job2>, ...) so the same job referenced twice still
 * compares equal. Everything else is compared exactly, including event order.
 */
function canon(v: unknown, dir: string): unknown {
  const jobs = new Map<string, string>();
  const placeholder = (id: string): string => {
    let p = jobs.get(id);
    if (p === undefined) {
      p = `<job${jobs.size + 1}>`;
      jobs.set(id, p);
    }
    return p;
  };
  const walk = (x: unknown, key?: string): unknown => {
    if (Array.isArray(x)) {
      return x.map((e) =>
        key !== undefined && JOB_KEY.test(key) && typeof e === "string" ? placeholder(e) : walk(e),
      );
    }
    if (x !== null && typeof x === "object") {
      return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val, k)]));
    }
    if (typeof x === "string") {
      if (key !== undefined && JOB_KEY.test(key)) return placeholder(x);
      if (key === "transcriptPath") return "<transcript>";
      return x.split(dir).join("<repo>").replace(ISO_TS, "<ts>");
    }
    if (typeof x === "number" && key !== undefined) {
      if (TIME_KEY.test(key)) return "<ts>";
      if (DURATION_KEY.test(key)) return "<ms>";
    }
    return x;
  };
  return walk(v);
}

/**
 * Halts the cycle after explore + plan + branch + develop-entry so the run is
 * deterministic. `host` is the host under test; `sink` records what reaches the
 * bottom of that host (the transport), not what the driver emitted.
 */
async function runUnder(
  host: DriverHost,
  sink: Sent[],
  emittedSink: unknown[],
): Promise<{
  state: unknown;
  sent: unknown;
  emitted: unknown;
  eventKinds: string[];
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "driver-host-parity-"));
  let calls = 0;
  try {
    const ctx: DriverContext = {
      host,
      repoRoot: dir,
      issue: 1020,
      issueBodyFetcherFn: mockIssueBody,
      dispatchFn: async (_h, spec) => {
        calls++;
        if (calls >= 5) throw new Error("parity: halt before adversarial");
        return {
          role: spec.role,
          ok: true,
          text: spec.role === "explore" ? EXPLORE_REPLY : "stub output",
          toolUses: [],
          ms: 1,
          exitCode: 0,
          transcriptPath: "/tmp/parity.json",
        } as never;
      },
    } as unknown as DriverContext;
    await runWorkDriver(ctx).catch(() => undefined);
    const state = await readState(dir, 1020);
    const eventKinds = (state?.eventLog ?? []).map((e) => String(e.kind));
    return {
      state: canon(state, dir),
      sent: canon(sink, dir),
      emitted: canon(emittedSink, dir),
      eventKinds,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Pi-session side: piSessionHost → recording ExtensionAPI stub. The stub is the
// bottom of this host, so `piSent` is what reached the Pi API.
const piSent: Sent[] = [];
const fakePi = {
  sendUserMessage: (content: unknown, options?: { deliverAs?: unknown }) => {
    piSent.push({ text: String(content), deliverAs: options?.deliverAs });
  },
} as never as Parameters<typeof piSessionHost>[0];

// Test side: the recording host is itself the bottom, so `testSent` is what it received.
const testSent: Sent[] = [];
// S4a (#1162) — the recording host also captures every `emit`, so the emitted
// sequence can be compared with the final eventLog.
const testEmitted: unknown[] = [];
const recordingHost: DriverHost = {
  sendUserMessage: (text, options) => {
    testSent.push({ text, deliverAs: options.deliverAs });
  },
  emit: (event) => {
    testEmitted.push(event);
  },
};

const piRun = await runUnder(piSessionHost(fakePi), piSent, []);
const testRun = await runUnder(recordingHost, testSent, testEmitted);

assert(piRun.eventKinds.length > 0, "the Pi-session run appended events to the eventLog");
assert(
  piRun.eventKinds.includes("step-started") && piRun.eventKinds.length >= 3,
  "the cycle progressed past its first step (explore, plan, ... recorded)",
);
assert(
  JSON.stringify(piRun.state) === JSON.stringify(testRun.state),
  "Pi-session host and recording host produce identical state + eventLog (timestamps, durations, repo path, job ids normalised)",
);
assert(
  testRun.emitted !== undefined &&
    JSON.stringify(testRun.emitted) ===
      JSON.stringify((testRun.state as { eventLog: unknown }).eventLog),
  "the recording host's emitted events equal the final eventLog, in order (S4a emit choke point)",
);
assert(
  piSent.length > 0 && JSON.stringify(piRun.sent) === JSON.stringify(testRun.sent),
  "both hosts' transports receive identical messages (text and deliverAs, normalised)",
);
assert(
  piSent.length > 0 &&
    testSent.length > 0 &&
    piSent.every((m) => m.deliverAs === "steer") &&
    testSent.every((m) => m.deliverAs === "steer"),
  'every driver message is delivered with deliverAs "steer" on both hosts',
);

process.exit(exit);
