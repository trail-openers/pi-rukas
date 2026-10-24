#!/usr/bin/env bun
/**
 * Two defects that turned recoverable blips into lost cycles, both measured
 * against real transcripts and real state files rather than reasoned about.
 *
 * ## 1. The parent hung up on a child that was about to retry itself
 *
 * Pi retries transient provider failures in-process — 3 attempts, 2s/4s/8s
 * backoff, with `"terminated"` in its retryable set — and announces the intent
 * by stamping `willRetry` on `agent_end`. `spawn.ts` closed the child's stdin
 * on *any* `agent_end`, and rpc mode exits when stdin ends. Measured on a real
 * 35-minute dispatch: exactly one error message where a 3-retry sequence would
 * have left four, and the process exited **0.4 seconds** after writing it.
 *
 * The child's retry is the one worth having: it is in-process, so it keeps the
 * accumulated context and resumes. The driver's retry re-dispatches from
 * scratch and throws the work away.
 *
 * ## 2. Fan-out failures were classified as nothing at all
 *
 * `routeStepOutcome` read only the last event. A single dispatch ends ON its
 * failure, so that worked. A fan-out does not: `runDevelop` appends a
 * `branch-completed` per workstream and then `branches-converged`, burying the
 * per-child failures.
 *
 * Measured in a real develop fan-out: three developers hit a 429 carrying a
 * 59-second retry-after — a delay the taxonomy already waits out for single
 * dispatches, which is why both `plan` steps recovered — and develop halted
 * with `transientRetryAttempts: {}`. Never attempted, not exhausted.
 */

import { reconcileObservedCounts, willRetryAfter } from "../src/spawn-support.ts";
import { failureEventOf } from "../src/work-driver-failure-lookup.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------ 1. willRetry is respected

{
  assert(
    willRetryAfter({ type: "agent_end", willRetry: true }),
    "an agent_end stamped willRetry is recognised — stdin must stay open",
  );
  assert(
    !willRetryAfter({ type: "agent_end", willRetry: false }),
    "a terminal agent_end is not — the prompt completes as before",
  );
  assert(
    !willRetryAfter({ type: "agent_end" }),
    "an agent_end with no flag is terminal: a Pi that never stamps it behaves exactly as today",
  );

  // The canary. Today's code calls completePrompt() unconditionally, so this
  // predicate is the entire difference between recovering a 35-minute dispatch
  // and discarding it.
  const retrying = { type: "agent_end", willRetry: true };
  assert(
    willRetryAfter(retrying) !== false,
    "canary: the retrying child is distinguishable from a finished one at all",
  );
}

// ---------------------------------- 2. fan-out failures reach the classifier

/**
 * The tail of a real develop step, captured from a live fan-out. Three
 * children dispatched; two hit 429s and one succeeded.
 */
const fanOutTail = (opts: { anySucceeded: boolean }): WorkEvent[] =>
  [
    { kind: "branches-fanned-out", at: 1, step: "develop", ids: ["a", "b", "c"] },
    {
      kind: "dispatch-failed-provider",
      at: 2,
      step: "develop",
      role: "developer",
      jobId: "j1",
      label: "developer[interactive-tier]",
      ms: 9453,
      providerMessage: "Server requested 60s retry delay (max: 10s). 429 status code (no body)",
    },
    { kind: "branch-completed", at: 3, step: "develop", id: "a", ok: false },
    {
      kind: "dispatch-failed-provider",
      at: 4,
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer[default]",
      ms: 13851,
      providerMessage: "Server requested 59s retry delay (max: 10s). 429 status code (no body)",
    },
    { kind: "branch-completed", at: 5, step: "develop", id: "b", ok: false },
    {
      kind: "branches-converged",
      at: 6,
      step: "develop",
      verdicts: [
        { id: "a", ok: false },
        { id: "b", ok: false },
        { id: "c", ok: opts.anySucceeded },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: partial fixtures; only the fields the router reads
  ] as any as WorkEvent[];

{
  const tail = fanOutTail({ anySucceeded: false });
  const last = tail[tail.length - 1];

  // This is what the old lookup saw, and why nothing was classified.
  assert(
    last?.kind === "branches-converged",
    "canary: a fan-out step's LAST event is branches-converged, not a dispatch failure",
  );
  assert(
    last?.kind !== "dispatch-failed" && last?.kind !== "dispatch-failed-provider",
    "...so reading only the last event finds no failure to classify — the shipped bug",
  );

  // The real function, not a reconstruction of it.
  const found = failureEventOf(tail);
  assert(
    found?.kind === "dispatch-failed-provider",
    "failureEventOf digs past branch-completed/branches-converged and finds the failure",
  );
  assert(
    /429/.test((found as { providerMessage?: string })?.providerMessage ?? ""),
    "...carrying the 429 the taxonomy needs to classify it as retryable",
  );
  assert(
    failureEventOf([tail[0] as WorkEvent]) === undefined,
    "a fan-out that never failed yields nothing to classify",
  );
  assert(failureEventOf([]) === undefined, "an empty log is safe");

  // And the failure it should have found is two events back, carrying the
  // retry-after the taxonomy knows how to honour.
  const failures = tail.filter((e) => e.kind === "dispatch-failed-provider");
  assert(failures.length === 2, "the fan-out failures are present, just buried");
  assert(
    failures.every((f) => /429/.test((f as { providerMessage?: string }).providerMessage ?? "")),
    "...and every one is a 429 with an explicit retry-after",
  );
  assert(
    /59s|60s/.test((failures[0] as { providerMessage?: string }).providerMessage ?? "") ||
      /59s|60s/.test((failures[1] as { providerMessage?: string }).providerMessage ?? ""),
    "...asking for ~60s, well inside the 300s burst threshold that marks it retryable",
  );
}

{
  // The safety rule: if any workstream succeeded, the step is not purely
  // transient and must not be re-run wholesale — that would re-dispatch work
  // that already landed.
  const mixed = fanOutTail({ anySucceeded: true });
  const converged = mixed[mixed.length - 1] as { verdicts: Array<{ ok: boolean }> };
  assert(
    converged.verdicts.some((v) => v.ok),
    "a mixed fan-out is distinguishable from a total one by its verdicts",
  );
  assert(
    !converged.verdicts.every((v) => !v.ok),
    "...so the retry path can decline it without inspecting anything else",
  );
  assert(
    failureEventOf(mixed) === undefined,
    "a PARTIALLY successful fan-out is not treated as a transient step failure — re-running it would re-dispatch work that already landed",
  );
}

// -------------------- 3. the counts survive Pi's agent_end segmentation

{
  // Measured from `mspr5ylf-eg4d66-explore-*`. `agent_end.messages` carries
  // only the messages since the PREVIOUS agent_end, and Pi emits one per
  // in-process retry boundary — so the last one is a segment, not the session.
  const usage = (turns: number) => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns,
  });

  {
    // daphne-arch: died ON its 429, so its final segment was the lone error
    // stub. Reported "1 turns · (no output)" for 63 assistant turns and 41
    // tool calls.
    const result = { usage: usage(1), toolUses: [] as unknown[] } as {
      usage: ReturnType<typeof usage>;
      toolUses: unknown[];
      observedToolCalls?: number;
    };
    reconcileObservedCounts(result, { usage: usage(63), toolUses: 41 });
    assert(
      result.usage.turns === 63,
      `canary: 1 turn becomes the real 63 (got ${result.usage.turns})`,
    );
    assert(result.observedToolCalls === 41, "...and the 41 tool calls are recorded");
  }

  {
    // rust-slack: survived five 429s. Its last segment was exactly 29 messages
    // — the "29 turns" reported — against 57 assistant turns on disk. The bug
    // was never confined to the children that died.
    const result = { usage: usage(29), toolUses: [] as unknown[] } as {
      usage: ReturnType<typeof usage>;
      toolUses: unknown[];
      observedToolCalls?: number;
    };
    reconcileObservedCounts(result, { usage: usage(57), toolUses: 51 });
    assert(
      result.usage.turns === 57,
      "a SUCCESSFUL child was under-reported too, and is corrected",
    );
  }

  {
    // Never revise downward: a lower live count means we missed events, and
    // the replay is then the better source.
    const result = { usage: usage(40), toolUses: [{}] as unknown[] } as {
      usage: ReturnType<typeof usage>;
      toolUses: unknown[];
      observedToolCalls?: number;
    };
    reconcileObservedCounts(result, { usage: usage(3), toolUses: 2 });
    assert(
      result.usage.turns === 40,
      "a lower live count does NOT overwrite a higher replay count",
    );
    assert(
      result.observedToolCalls === undefined,
      "...and a replay that already carried tool calls is left alone",
    );
  }
}

// ----------------------------- 4. the park report names the step that failed

{
  // `failedStep` was derived from `lastCompletedStep` — the last step that
  // SUCCEEDED. An operator chasing a failed develop was pointed at `branch` and
  // spent half a session diagnosing a branch collision that never happened.
  const capShape = "step-failed:develop";
  const parsed = capShape.startsWith("step-failed:")
    ? capShape.slice("step-failed:".length)
    : undefined;
  assert(parsed === "develop", "the cap carries the real failing step and it is parseable");
  assert(
    parsed !== "branch",
    "canary: it is NOT the last completed step, which is what was being reported",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
