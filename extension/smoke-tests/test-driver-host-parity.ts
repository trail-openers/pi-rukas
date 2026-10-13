#!/usr/bin/env bun
/**
 * #1020 — DriverHost parity. The same stubbed /work cycle, run under the
 * Pi-session host (piSessionHost wrapping a recording ExtensionAPI stub) and a
 * recording test host, must leave identical state and eventLog once timestamps
 * are normalised. Only the work cycle is in the invariant; plan / research /
 * lens-review are wired to DriverHost but not compared here.
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

/** Halts the cycle after explore + plan + branch + develop-entry so the run is deterministic. */
async function runUnder(host: DriverHost): Promise<{ state: unknown; sent: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), "driver-host-parity-"));
  const sent: string[] = [];
  const recording: DriverHost = {
    sendUserMessage: (text, options) => {
      sent.push(text);
      host.sendUserMessage(text, options);
    },
  };
  let calls = 0;
  try {
    const ctx: DriverContext = {
      host: recording,
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
    const state = readState(dir, 1020);
    const scrub = (t: string) => normaliseText(t.split(dir).join("<repo>"));
    return { state: normalise(state), sent: sent.map(scrub) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
function normaliseText(t: string): string {
  return t.replace(TS, "<ts>");
}
function normalise(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? normaliseText(x) : x)));
}

// Recording ExtensionAPI stub — the Pi-session side of the parity pair.
const piRecorded: string[] = [];
const fakePi = {
  sendUserMessage: (content: unknown, options?: { deliverAs?: string }) => {
    piRecorded.push(String(content));
    void options;
  },
} as never as Parameters<typeof piSessionHost>[0];

const piRun = await runUnder(piSessionHost(fakePi));
const testRun = await runUnder({
  sendUserMessage: () => undefined,
});

assert(piRun.state !== undefined, "the Pi-session run produced a state file");
assert(
  JSON.stringify(piRun.state) === JSON.stringify(testRun.state),
  "Pi-session host and recording host produce identical state (timestamps normalised)",
);
assert(
  JSON.stringify(piRun.sent) === JSON.stringify(testRun.sent),
  "both hosts receive identical messages",
);
assert(piRecorded.length > 0, "the Pi-session host forwards messages to sendUserMessage");

process.exit(exit);
