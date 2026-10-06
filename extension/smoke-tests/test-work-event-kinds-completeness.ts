#!/usr/bin/env bun
/**
 * #986 — mechanical guard: KNOWN_EVENT_KINDS (the validator's membership
 * tuple) and the WorkEvent["kind"] union must stay in sync, in BOTH
 * directions. The live bug: the driver emitted four kinds
 * (worktree-provisioned #558, safety-net-commit #625, handoff-consolidated
 * #674, worktree-leftover-handled #735) that the tuple omitted, so EVERY
 * cycle that crashed after its branch step refused to resume ("eventLog[N].
 * kind has unknown value").
 *
 * The guard is the offline runtime form the issue mandates:
 *   1. Forward — one minimal, well-formed event of EVERY WorkEvent kind
 *      passes validateDiscriminants with zero "unknown value" findings.
 *      Fails on the pre-fix tuple (one finding per missing kind, naming the
 *      exact value).
 *   2. Reverse — every tuple entry must be a WorkEvent kind (checked here
 *      against the union-derived set; a stale tuple entry — a typo'd kind
 *      with no union member — would stop validating real events instead of
 *      failing loudly).
 *   3. Resume-shaped — a RUNNING state file whose eventLog carries the four
 *      incident kinds validates clean (the #981 incident shape).
 *
 * Kind-level only: the validator is not extended with per-kind field
 * validation (the issue's spec clarification).
 */

import type { WorkEvent } from "../src/workflow-state-events.ts";
import { KNOWN_EVENT_KINDS, validateDiscriminants } from "../src/workflow-state-validate.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal well-formed instance of every WorkEvent union member. Typed as
// the union itself — a union change that drops or renames a kind (or
// changes a required field) fails the type-check, which is the optional
// compile-time half of the guard.
const everyKindEvent: WorkEvent[] = [
  { kind: "step-started", step: "explore", at: 1 },
  { kind: "adversarial-approved", at: 1, jobId: "j1", rounds: 1 },
  { kind: "adversarial-rejected", at: 1, jobId: "j1", rounds: 2, findings: "f" },
  { kind: "adversarial-round", at: 1, round: 1, status: "APPROVED", verdictParsed: true },
  {
    kind: "adversarial-workstream-outcome",
    at: 1,
    workstreamId: "default",
    outcome: "approved",
    roundsExecuted: 1,
  },
  { kind: "dispatch-started", step: "develop", role: "developer", jobId: "j1", label: "l", at: 1 },
  {
    kind: "dispatch-completed",
    step: "develop",
    role: "developer",
    jobId: "j1",
    label: "l",
    ok: true,
    ms: 10,
    at: 1,
  },
  {
    kind: "dispatch-failed-provider",
    step: "develop",
    role: "developer",
    jobId: "j1",
    label: "l",
    ms: 10,
    at: 1,
  },
  {
    kind: "dispatch-failed",
    step: "develop",
    role: "developer",
    jobId: "j1",
    label: "l",
    ms: 10,
    at: 1,
  },
  { kind: "lens-approved", at: 1, jobId: "j1", round: 1 },
  {
    kind: "lens-issues-found",
    at: 1,
    jobId: "j1",
    round: 1,
    findings: "f",
    verdict: "ISSUES_FOUND",
  },
  { kind: "lens-skipped-empty-diff", at: 1, round: 1 },
  {
    kind: "lens-fix-empty-resend",
    at: 1,
    jobId: "j1",
    round: 1,
    worktree: "/wt",
    evidence: "clean",
  },
  {
    kind: "adversarial-skipped-empty-diff",
    at: 1,
    workstreamId: "default",
  },
  { kind: "converge-redispatch", step: "develop", at: 1 },
  { kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 3, nextStep: "ci" },
  { kind: "plumb-report", at: 1, step: "develop", role: "developer", body: "b" },
  { kind: "step-back-triggered", at: 1, theme: "t" },
  {
    kind: "step-back-completed",
    at: 1,
    jobId: "j1",
    sddElement: "constraints",
    diagnosis: "d",
    proposedRevision: "p",
  },
  { kind: "handoff-emitted", at: 1, labelApplied: true },
  { kind: "handoff-consolidated", at: 1, branchName: "feature/x", workstreams: ["default"] },
  { kind: "ci-status", at: 1, status: "pending" },
  { kind: "merged", at: 1, prNumber: 1 },
  { kind: "branches-fanned-out", step: "develop", workstreams: ["a", "b"], at: 1 },
  {
    kind: "branch-completed",
    step: "develop",
    workstreamId: "a",
    ok: true,
    ms: 10,
    at: 1,
  },
  { kind: "branches-converged", step: "develop", verdicts: [{ id: "a", ok: true }], at: 1 },
  { kind: "verify-full-status", at: 1, status: "success", ms: 100 },
  { kind: "verify-flake-recovered", at: 1, step: "develop" },
  { kind: "widening-scan", at: 1, findings: [] },
  { kind: "memory-write", at: 1, outcome: "written", id: "m1", memoryType: "fact" },
  {
    kind: "memory-inject",
    at: 1,
    step: "develop",
    queries: ["q"],
    hits: 1,
    emptyBrief: false,
    ids: ["m1"],
  },
  // #558 / #625 / #674 / #735 — the four kinds the pre-fix tuple omitted
  // (the #986 bug): worktree-provisioned (8b226a5), safety-net-commit
  // (b8af99d), handoff-consolidated (see handoff fragment),
  // worktree-leftover-handled (#730 emitter, issue #735).
  {
    kind: "worktree-provisioned",
    at: 1,
    worktreeId: "default",
    worktreePath: "/wt",
    outcome: "ok",
  },
  {
    kind: "safety-net-commit",
    at: 1,
    workstreamId: "default",
    worktreePath: "/wt",
    commitSha: "abc",
    filesCommitted: 2,
  },
  { kind: "branch-reset", at: 1, branch: "feature/x", oldSha: "a", newSha: "b" },
  { kind: "worktree-leftover-handled", at: 1, path: "/wt", action: "adopt", refs: [] },
  {
    kind: "dispatch-slow",
    at: 1,
    step: "develop",
    role: "developer",
    jobId: "j1",
    label: "l",
    elapsedMs: 1000,
    turns: 1,
    tokens: 10,
  },
  { kind: "fence-recovery-started", at: 1, workstreamId: "a", owners: ["b"] },
];

// The union-derived kind set: the source of truth both directions check
// against (derived, never a second hand-maintained list).
const unionKinds = new Set<string>(everyKindEvent.map((e) => e.kind));

// 1. Forward: one event of EVERY union kind passes the validator with no
// "unknown value" finding. Pre-fix tuple: the four missing kinds each
// produce exactly `eventLog[i].kind has unknown value "<kind>"`.
{
  const findings = validateDiscriminants({
    ...initialState(986, 1000),
    eventLog: everyKindEvent,
  } as unknown as Record<string, unknown>);
  const unknownFindings = findings.filter((f) => f.includes("unknown value"));
  assert(
    unknownFindings.length === 0,
    `every WorkEvent kind validates clean (got ${unknownFindings.length} unknown-kind finding(s): ${unknownFindings.join("; ")})`,
  );
  // No other finding either — the fixtures are well-formed by construction
  // and the guard is kind-level only, so a clean result is the full
  // acceptance, not just "no unknown-value findings".
  assert(findings.length === 0, "validateDiscriminants returns zero findings overall");
}

// 2. Reverse: the tuple has exactly the union's kinds — no more (a typo'd
// entry that no union member can produce would stop validating real events,
// the same drift the forward guard catches, the other way), no fewer (a
// union member the tuple omitted is the #986 bug itself). NOTE: this
// comparison is against the TEST's own fixture set — if a new WorkEvent
// member is forgotten in BOTH the tuple and the fixtures, 38 == 38 passes
// here and nothing does (the smoke tests are not type-checked by
// extension/tsconfig.json). Compile-time completeness of the tuple itself
// is enforced by the #986 exhaustiveness assertion in
// src/workflow-state-validate.ts (`[MissingEventKinds] extends [never]`);
// this check is the runtime backstop for stale/typo'd entries.
assert(
  (KNOWN_EVENT_KINDS as readonly unknown[]).length === unionKinds.size,
  `KNOWN_EVENT_KINDS (${(KNOWN_EVENT_KINDS as readonly unknown[]).length} entries) has exactly the union's ${unionKinds.size} kinds (no typos, no omissions)`,
);

// 3. Resume-shaped: the #981 incident — a RUNNING state file whose eventLog
// carries the four driver-emitted kinds the pre-fix tuple omitted. The
// validator fires only on the resume path (status "running"), so this is
// the shape that actually refused to resume.
{
  const incidentKinds: Array<[string, object]> = [
    [
      "worktree-provisioned",
      {
        kind: "worktree-provisioned",
        at: 1,
        worktreeId: "default",
        worktreePath: "/wt",
        outcome: "ok",
      },
    ],
    [
      "safety-net-commit",
      {
        kind: "safety-net-commit",
        at: 1,
        workstreamId: "default",
        worktreePath: "/wt",
        commitSha: "abc",
        filesCommitted: 2,
      },
    ],
    [
      "handoff-consolidated",
      { kind: "handoff-consolidated", at: 1, branchName: "feature/x", workstreams: ["default"] },
    ],
    [
      "worktree-leftover-handled",
      { kind: "worktree-leftover-handled", at: 1, path: "/wt", action: "adopt", refs: [] },
    ],
  ];
  for (const [name, ev] of incidentKinds) {
    const running = {
      ...initialState(986, 1000),
      eventLog: [ev],
    } as unknown as Record<string, unknown>;
    assert(
      validateDiscriminants(running).length === 0,
      `running state carrying ${name} resumes clean (the #981 shape)`,
    );
  }

  // Contrast (anchors the existing #533 canary, unchanged): an actually
  // unknown kind in a running file STILL produces one finding naming the
  // exact value — the fix extends the known set, it does not loosen it.
  const running = {
    ...initialState(986, 1000),
    eventLog: [{ kind: "not-a-real-kind", at: 3 }],
  } as unknown as Record<string, unknown>;
  const contrast = validateDiscriminants(running);
  assert(
    contrast.length === 1 && contrast[0].includes('"not-a-real-kind"'),
    "an unknown kind still produces exactly one finding naming the value (canary intact)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
