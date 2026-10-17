#!/usr/bin/env bun
/**
 * #1367 / #1368 — the headless result gives the reason behind a cap as stable
 * fields (`issues[].failure`), and usage per role with failed dispatches
 * included (`issues[].usage.byRole`).
 *
 *   - a provider outage behind `step-failed:<step>` is `kind: "provider"` with
 *     the provider's message; a crashed child is `process` with its error tail
 *   - a timed-out child is `timeout`; a verify cap is `verify` with its evidence
 *   - a cap with no failure is `cap`; a merge carries no `failure`
 *   - a failed dispatch from an earlier step is not blamed for a later cap
 *   - `byRole` rows add up to the total and include failed dispatches
 *   - `--capabilities` publishes the kinds and the two features
 *
 * Offline and pure: builds states in memory.
 */
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { FAILURE_KINDS } from "../src/headless/failure.ts";
import { projectIssue } from "../src/headless/result.ts";
import type { WorkEvent, WorkStep } from "../src/workflow-state-events.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function build(events: WorkEvent[], status: WorkState["pipelineState"]["status"]): WorkState {
  let s = initialState(7);
  for (const e of events) s = appendEvent(s, e);
  return { ...s, pipelineState: { ...s.pipelineState, status } };
}
const usage = (n: number) => ({
  input: n,
  output: 1,
  cacheRead: 2,
  cacheWrite: 0,
  cost: 0.25,
  turns: 3,
});
const base = (at: number, role: string, step: WorkStep = "develop") =>
  ({ step, role, jobId: `j${at}`, label: role, ms: 10, at }) as const;
const ok = (at: number, role: string, n: number): WorkEvent => ({
  kind: "dispatch-completed",
  ...base(at, role),
  ok: true,
  usage: usage(n),
});
const capHit = (cap: string, at: number, extra: Record<string, unknown> = {}): WorkEvent =>
  ({ kind: "cap-hit", cap, at, reviewRound: 1, nextStep: "handoff", ...extra }) as WorkEvent;

// ── A provider outage behind step-failed:develop.
{
  const s = build(
    [
      { kind: "step-started", step: "develop", at: 1 },
      ok(2, "developer", 100),
      {
        kind: "dispatch-failed-provider",
        ...base(3, "developer"),
        providerMessage: "503 Service Unavailable: upstream connect error",
        usage: usage(10),
      },
      capHit("step-failed:develop", 4, { evidence: "the developer dispatch failed" }),
      { kind: "step-started", step: "handoff", at: 5 },
    ],
    "handoff",
  );
  const f = projectIssue(s, "f").failure;
  assert(f?.kind === "provider", `a provider error stop is kind provider (${f?.kind})`);
  assert(f?.step === "develop" && f.role === "developer", "step and role name the failed dispatch");
  assert(
    f?.providerMessage === "503 Service Unavailable: upstream connect error",
    "providerMessage is carried",
  );
  assert(typeof f?.cause === "string" && f.cause.length > 0, `cause is classified (${f?.cause})`);
  assert(typeof f?.message === "string" && f.message.length > 0, "message is set");
  assert(f?.evidence === "the developer dispatch failed", "the cap's evidence is carried");
}

// ── A crashed child and a timed-out child.
{
  const crashed = build(
    [
      { kind: "step-started", step: "commit-pr", at: 1 },
      {
        kind: "dispatch-failed",
        ...base(2, "ops", "commit-pr"),
        exitCode: 1,
        errorTail: `${"x".repeat(5000)}fatal: not a git repository`,
      },
      capHit("step-failed:commit-pr", 3),
    ],
    "handoff",
  );
  const f = projectIssue(crashed, "f").failure;
  assert(f?.kind === "process" && f.exitCode === 1, "a non-zero exit is kind process");
  assert(
    (f?.errorTail?.length ?? 0) <= 2000 && f?.errorTail?.endsWith("not a git repository") === true,
    "errorTail keeps the bounded end of the output",
  );
  const timedOut = build(
    [
      { kind: "step-started", step: "develop", at: 1 },
      { kind: "dispatch-failed", ...base(2, "developer"), killCause: "timeout", exitCode: null },
      capHit("developer-timeout", 3),
    ],
    "handoff",
  );
  const t = projectIssue(timedOut, "f").failure;
  assert(t?.kind === "timeout" && t.killCause === "timeout", "a timeout kill is kind timeout");
  assert(t?.exitCode === null, "a signal-killed child has exitCode null");
}

// ── #1243 — a provider outage parks with its own cap, and the host reads it as
// `kind: "provider"` so it can re-queue the cycle itself. A real failure of the
// work keeps `step-failed:<step>` and stays `process`.
{
  const outage = build(
    [
      { kind: "step-started", step: "adversarial", at: 1 },
      {
        kind: "dispatch-failed-provider",
        ...base(2, "adversarial-loop", "adversarial"),
        providerMessage: "Request timed out.",
        providerRepeats: 2,
        usage: usage(9),
      },
      capHit("provider-unavailable", 3, {
        evidence: "provider/transport error: Request timed out. · cause=provider-severed",
      }),
    ],
    "handoff",
  );
  const f = projectIssue(outage, "f").failure;
  assert(f?.kind === "provider", `provider-unavailable is kind provider (${f?.kind})`);
  assert(
    f?.cause === "provider-severed",
    `cause is the endpoint's, classified (${f?.cause})`,
  );
  assert(
    f?.providerMessage === "Request timed out.",
    `the endpoint's own message reaches the host (${f?.providerMessage})`,
  );
  assert(
    (f?.message ?? "").includes("Request timed out."),
    `message names the fault, not the cap string (${f?.message})`,
  );
  // A cap of the same name with no failed dispatch behind it is still `provider`:
  // the cap itself carries the diagnosis, and a host re-queueing on `provider`
  // must not depend on the event log surviving intact.
  const bare = build(
    [{ kind: "step-started", step: "adversarial", at: 1 }, capHit("provider-unavailable", 2)],
    "handoff",
  );
  assert(
    projectIssue(bare, "f").failure?.kind === "provider",
    "provider-unavailable with no dispatch is still kind provider",
  );
  // The contrast that makes the cap worth having: a crashed child behind the
  // same step's cap is NOT a provider park, so a caller does not re-queue a
  // defect forever.
  const real = build(
    [
      { kind: "step-started", step: "adversarial", at: 1 },
      { kind: "dispatch-failed", ...base(2, "adversarial-loop", "adversarial"), exitCode: 1 },
      capHit("step-failed:adversarial", 3),
    ],
    "handoff",
  );
  assert(
    projectIssue(real, "f").failure?.kind === "process",
    "a crashed child stays kind process — not something to re-queue",
  );
}

// ── Caps with no failed dispatch.
{
  const verify = build(
    [
      { kind: "step-started", step: "develop", at: 1 },
      ok(2, "developer", 1),
      capHit("verify-failed:develop", 3, {
        evidence: "- verify command exited 1\n- 2 tests failed",
      }),
    ],
    "handoff",
  );
  const v = projectIssue(verify, "f").failure;
  assert(v?.kind === "verify", "verify-failed is kind verify");
  assert(v?.message === "verify command exited 1", "message is the evidence's first line");
  assert(v?.role === undefined && v.cause === undefined, "no dispatch is blamed");

  const kinds: [string, string][] = [
    ["verify-timeout:develop", "timeout"],
    ["verify-env:develop", "environment"],
    ["driver-crash:plan", "driver"],
    ["round-cap", "cap"],
    ["awaiting-human-merge", "cap"],
  ];
  for (const [cap, kind] of kinds) {
    const s = build([{ kind: "step-started", step: "develop", at: 1 }, capHit(cap, 2)], "handoff");
    const f = projectIssue(s, "f").failure;
    assert(f?.kind === kind, `${cap} is kind ${kind} (${f?.kind})`);
    assert(f?.message === cap, `${cap} with no evidence: message is the cap`);
  }
}

// ── A failed dispatch from an earlier step is not blamed; a merge has no failure.
{
  const s = build(
    [
      { kind: "step-started", step: "explore", at: 1 },
      { kind: "dispatch-failed-provider", ...base(2, "explore", "explore"), providerMessage: "x" },
      ok(3, "explore", 1),
      { kind: "step-started", step: "develop", at: 4 },
      ok(5, "developer", 1),
      capHit("step-failed:develop", 6),
    ],
    "handoff",
  );
  const f = projectIssue(s, "f").failure;
  assert(f?.kind === "process" && f.role === undefined, "an earlier step's failure is not blamed");
  const merged = build(
    [
      { kind: "step-started", step: "ci", at: 1 },
      capHit("ci-retry", 2),
      { kind: "merged", at: 3, prNumber: 9 },
    ],
    "merged",
  );
  assert(projectIssue(merged, "f").failure === undefined, "a merge carries no failure");
}

// ── usage.byRole includes failed dispatches and adds up to the total.
{
  const s = build(
    [
      { kind: "step-started", step: "develop", at: 1 },
      ok(2, "developer", 100),
      { kind: "dispatch-failed", ...base(3, "developer"), exitCode: 1, usage: usage(20) },
      {
        kind: "dispatch-failed-provider",
        ...base(4, "adversarial", "adversarial"),
        usage: usage(5),
      },
      { kind: "dispatch-failed", ...base(5, "adversarial", "adversarial"), exitCode: 1 },
      capHit("adversarial-infra-failure", 6),
    ],
    "handoff",
  );
  const u = projectIssue(s, "f").usage;
  const dev = u?.byRole.developer;
  const adv = u?.byRole.adversarial;
  assert(dev?.dispatches === 2 && dev.input === 120, "developer row includes the failed dispatch");
  assert(
    adv?.dispatches === 2 && adv.input === 5,
    "adversarial row counts a dispatch with no usage",
  );
  const rows = Object.values(u?.byRole ?? {});
  const sum = (k: "input" | "output" | "turns" | "dispatches" | "cost") =>
    rows.reduce((a, r) => a + r[k], 0);
  assert(
    u !== undefined &&
      sum("input") === u.input &&
      sum("output") === u.output &&
      sum("turns") === u.turns &&
      sum("dispatches") === u.dispatches &&
      Math.abs(sum("cost") - u.cost) < 1e-9,
    "byRole rows add up to the total",
  );
  const empty = projectIssue(build([], "running"), "f").usage;
  assert(
    empty !== undefined && Object.keys(empty.byRole).length === 0,
    "no dispatch: empty byRole",
  );
}

// ── --capabilities publishes the kinds and the features.
{
  const caps = buildCapabilities();
  assert(
    JSON.stringify(caps.contracts.resultSchema.failureKinds) === JSON.stringify(FAILURE_KINDS),
    "resultSchema.failureKinds is FAILURE_KINDS",
  );
  assert(
    caps.features.failureReason === true && caps.features.usageByRole === true,
    "features.failureReason and features.usageByRole are true",
  );
}

process.exit(exit);
