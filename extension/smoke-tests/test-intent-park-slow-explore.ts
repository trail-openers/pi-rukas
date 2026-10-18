#!/usr/bin/env bun
/**
 * #1385 — a `park` intent verdict ends the cycle at the intent gate, under
 * `--restart` and when the explore dispatch crossed the slow-notice threshold.
 *
 * Cycle example-owner/orchard#cycle-id ran `/work 194 --restart`. Its explore
 * dispatch crossed slow-notice level 1 (20 min) and resolved
 * `INTENT-VERDICT: park` / `PARK-REASON: already-implemented` with zero
 * deliverables. The driver traced the verdict and then ran plan, branch,
 * develop, ... and opened a PR (3 h 31 min, 23.9M tokens).
 *
 * Cause: before #1255 the step router appended drained `dispatch-slow`
 * events at the TAIL of the event log, so the `intent-park` cap-hit was no
 * longer the last event and `nextStep()` fell through to the linear table
 * (explore → plan). `--restart` played no part; it is covered here to pin
 * that it never overrides a park. Fixed by #1255 (`foldSlowEvents`).
 *
 * No real Pi spawn: `dispatchFn` and `issueBodyFetcherFn` are injected.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../src/dispatch.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
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

process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "0";
process.env.PI_ENSEMBLE_VERIFY = "0";

const PARK_REPLY = [
  "INTENT-VERDICT: park",
  "PARK-REASON: already-implemented",
  "",
  "## Spec",
  "",
  "### Intent",
  "Decide 'lost' on the dashboard from the heartbeat.",
  "",
  "### Deliverables",
  "",
  "### Evidence",
  "- lock-aware lost is on main (8bb6ce7) — confirmed",
  "",
].join("\n");

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

async function runCase(opts: { issue: number; restart: boolean; slow: boolean }) {
  const dir = mkdtempSync(path.join(tmpdir(), "intent-park-restart-"));
  const labels: string[] = [];
  try {
    const ctx: DriverContext = {
      host: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
      repoRoot: dir,
      issue: opts.issue,
      restart: opts.restart,
      issueBodyFetcherFn: async (n) => ({
        stdout: `title:\tissue #${n}\nstate:\tOPEN\n\nbody for #${n}`,
      }),
      dispatchFn: async (_pi, spec, o) => {
        labels.push(o?.label ?? spec.role);
        if (o?.label === "explore") {
          // The real cycle's explore crossed slow-notice level 1 mid-dispatch.
          if (opts.slow) {
            o.onSlow?.({
              step: "explore",
              role: "explore",
              jobId: "job-explore",
              label: "explore",
              elapsedMs: 20 * 60_000,
              turns: 40,
              tokens: 1_900_000,
              at: Date.now(),
            });
          }
          return mkResult({ role: "explore", text: PARK_REPLY });
        }
        if (o?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    const after = await readState(dir, opts.issue);
    return { state: after, labels };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of [
  { issue: 1941, restart: false, slow: false, name: "plain" },
  { issue: 1942, restart: true, slow: false, name: "--restart" },
  { issue: 1943, restart: false, slow: true, name: "slow explore" },
  { issue: 1944, restart: true, slow: true, name: "--restart + slow explore (cycle 194)" },
]) {
  const { state, labels } = await runCase(c);
  const caps = (state?.eventLog ?? []).filter((e) => e.kind === "cap-hit");
  const cap = caps[0];
  assert(
    cap?.kind === "cap-hit" && cap.cap === "intent-park",
    `${c.name}: the first cap is intent-park (got ${cap?.kind === "cap-hit" ? cap.cap : "none"})`,
  );
  assert(
    cap?.kind === "cap-hit" && cap.parkReason === "already-implemented",
    `${c.name}: the cap carries the park reason`,
  );
  assert(
    !labels.some((l) => l === "plan" || l.startsWith("developer")),
    `${c.name}: no plan or develop dispatch after the park (dispatched: ${labels.join(", ")})`,
  );
  assert(
    state?.pipelineState.normalisedSpec?.verdict === "park",
    `${c.name}: the state record carries the park verdict`,
  );
  assert(state?.pipelineState.status === "handoff", `${c.name}: the cycle ends in handoff`);
}

process.exit(exit);
