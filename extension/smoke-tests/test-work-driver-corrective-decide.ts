#!/usr/bin/env bun
/**
 * #1667 — the corrective develop round's decision, pure (no git, no dispatch).
 *
 * Pins each no-round exemption with a positive control beside it, the
 * per-workstream and consolidated attribution, the dependency rule (an evidence
 * line that names a missing dependency declines the round and keeps the deps
 * hint), the deps-hint suppression, and the line bounds.
 */

import {
  CORRECTIVE_LINE_MAX,
  CORRECTIVE_MAX_LINES,
  type CorrectiveGateView,
  decideCorrectiveRound,
} from "../src/work-driver-corrective-decide.ts";
import type { WorkEvent } from "../src/workflow-state.ts";
import { depsHintApplies } from "../src/work-driver-verify-record.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const WT_A = "/repo/.worktrees/issue-1-a";
const WT_B = "/repo/.worktrees/issue-1-b";
const WORKTREES = { a: WT_A, b: WT_B };
const CMD = "sh check.sh";
const NO_EVENTS: WorkEvent[] = [];

/** The #1579 failure stream: a FAILED marker, then the ✗ assertion line. */
const CANCEL_TEXT = `verify command \`${CMD}\` failed in ${WT_A}: FAILED: extension/smoke-tests/test-cancel.ts\n✗ extension/smoke-tests/test-cancel.ts: 520 lines (exceeds 500-line hard limit)`;
const PLAIN_TEXT = `verify command \`${CMD}\` failed in ${WT_A}: something went wrong`;

/** A per-workstream verify failure gate: one failing record, in worktree `cwd`. */
function perWorktreeGate(
  cwd: string,
  text: string,
  extra: Partial<CorrectiveGateView> = {},
): CorrectiveGateView {
  return {
    ok: false,
    failures: [text],
    verifyRun: { status: "ran", command: CMD, failures: [text], perWorktree: [{ cwd, text }] },
    ...extra,
  };
}

const ctx = (gate: CorrectiveGateView, eventLog: WorkEvent[] = NO_EVENTS) =>
  decideCorrectiveRound(gate, { eventLog, worktrees: WORKTREES });

// ── positive control: the #1579 shape earns a round for its own workstream ──
{
  const d = ctx(perWorktreeGate(WT_A, CANCEL_TEXT));
  assert(d.round === true, "control: a ✗ line in one worktree's own verify earns a round");
  if (d.round) {
    assert(
      d.source === "per-workstream" && d.targets.length === 1 && d.targets[0]?.id === "a",
      "attribution: the round targets the worktree that failed, with its own lines",
    );
    assert(
      (d.targets[0]?.lines ?? []).every((l) => l.startsWith("✗")),
      "attribution: the ✗ line is what the developer is given, not the FAILED marker",
    );
  }
}

// ── no-round exemptions, each beside the control above ──
{
  // A line that reports no failure is still not an assertion, even when the
  // sentence around it contains the word "failed": the whole stream below is
  // the harness's own "verify command failed in <cwd>: something went wrong"
  // echo with nothing behind it, and #1667's exemption is that a developer
  // dispatched to it has no line to act on. The shared table's job (#1762) is
  // to tell that echo from `test.sh: failed checks (1)`, which does name one.
  const plain = ctx(perWorktreeGate(WT_A, PLAIN_TEXT));
  assert(
    plain.round === false,
    "no-assertion: a failure whose only line is the harness echo gets no round",
  );

  const timeout = `[verify-timeout] verify command \`${CMD}\` exceeded its 10-min timeout in ${WT_A}`;
  assert(
    ctx(perWorktreeGate(WT_A, `${timeout}\n✗ x: y`)).round === false,
    "timeout: a failure stream carrying the timeout marker yields no round (even beside a ✗ line)",
  );

  assert(
    ctx({ ...perWorktreeGate(WT_A, CANCEL_TEXT), baselineRedOnly: true }).round === false,
    "baseline-red: a verify command red at base gets no round",
  );

  assert(
    ctx({ ...perWorktreeGate(WT_A, CANCEL_TEXT), flakeRecovered: true }).round === false,
    "flake-recovered: a recovered verify never reaches the trigger",
  );

  const withScope: CorrectiveGateView = {
    ...perWorktreeGate(WT_A, CANCEL_TEXT),
    failures: [CANCEL_TEXT, 'worktree "a": has uncommitted changes but no commit ahead of base'],
  };
  assert(
    ctx(withScope).round === false,
    "non-verify failure: a scope or commit failure beside the verify failure gets no round",
  );

  const resumed = ctx(perWorktreeGate(WT_A, CANCEL_TEXT), [
    {
      kind: "corrective-round",
      at: 1,
      step: "develop",
      workstreamId: "a",
      attempt: 1,
      command: CMD,
      evidenceLines: [],
    },
  ]);
  assert(
    resumed.round === false,
    "resume: a cycle whose log already holds the round gets no second one",
  );

  const conflict = `cherry-pick / apply conflict in ${WT_A}\n✗ x: y`;
  assert(
    ctx(perWorktreeGate(WT_A, conflict)).round === false,
    "cap: a cherry-pick conflict keeps its own cap and gets no round",
  );
}

// ── decision 1: a dependency signature on an evidence line ──
{
  const deps = `verify command \`${CMD}\` failed in ${WT_A}: ✗ Cannot find module 'zod' from x.ts`;
  assert(
    ctx(perWorktreeGate(WT_A, deps)).round === false,
    "deps: an extracted evidence line naming a missing dependency declines the round",
  );
  assert(
    depsHintApplies(deps) === true,
    "deps: the deps hint stays when the dependency line is the evidence",
  );

  const nonDeps = `verify command \`${CMD}\` failed in ${WT_A}:\n✗ a.ts wrong\nNo such file or directory node_modules/x`;
  assert(
    depsHintApplies(nonDeps) === false,
    "deps hint: suppressed when assertion lines were extracted",
  );
  assert(
    depsHintApplies("Cannot find module 'zod'") === true,
    "deps hint: unchanged when no assertion line was extracted (whole-output signature)",
  );
}

// ── attribution across N=2 ──
{
  const gate: CorrectiveGateView = {
    ok: false,
    failures: [CANCEL_TEXT],
    verifyRun: {
      status: "ran",
      command: CMD,
      failures: [CANCEL_TEXT],
      perWorktree: [{ cwd: WT_B, text: CANCEL_TEXT }],
    },
  };
  const d = ctx(gate);
  assert(
    d.round === true && d.targets.length === 1 && d.targets[0]?.id === "b",
    "N=2: only the workstream whose own worktree failed is dispatched",
  );
}
{
  // Only the consolidated run failed: every workstream is given its lines.
  const gate: CorrectiveGateView = {
    ok: false,
    failures: ["consolidated failure"],
    verifyRun: {
      status: "ran",
      command: CMD,
      failures: ["consolidated failure"],
      perWorktree: [],
      consolidatedRaw: "✗ c.ts: bad assertion",
    },
  };
  const d = ctx(gate);
  assert(
    d.round === false,
    "consolidated-only N=2: with several workstreams the round declines (no line is attributable)",
  );
  const one = decideCorrectiveRound(gate, { eventLog: NO_EVENTS, worktrees: { a: WT_A } });
  assert(
    one.round === true &&
      one.source === "consolidated" &&
      one.targets.length === 1 &&
      one.targets[0]?.id === "a",
    "consolidated-only N=1: the one workstream is given the consolidated lines",
  );
  // A worktree failure that carries no assertion still attributes the failure:
  // the consolidated lines are not given to anyone.
  const attributed: CorrectiveGateView = {
    ok: false,
    failures: [PLAIN_TEXT, "consolidated failure"],
    verifyRun: {
      status: "ran",
      command: CMD,
      failures: [PLAIN_TEXT, "consolidated failure"],
      perWorktree: [{ cwd: WT_A, text: PLAIN_TEXT }],
      consolidatedRaw: "✗ c.ts: bad assertion",
    },
  };
  assert(
    ctx(attributed).round === false,
    "attribution: a per-worktree failure without lines blocks the consolidated fallback",
  );
}

// ── bounds: at most CORRECTIVE_MAX_LINES lines, each cut ──
{
  const many = Array.from({ length: 20 }, (_, i) => `✗ test ${i} fails`).join("\n");
  const long = `✗ ${"x".repeat(CORRECTIVE_LINE_MAX + 50)}`;
  const text = `verify command \`${CMD}\` failed in ${WT_A}\n${many}\n${long}`;
  const d = ctx(perWorktreeGate(WT_A, text));
  const lines = d.round && d.targets[0] ? d.targets[0].lines : [];
  assert(
    lines.length === CORRECTIVE_MAX_LINES,
    `bounds: a developer is given at most ${CORRECTIVE_MAX_LINES} lines`,
  );
  assert(
    lines.every((l) => l.length <= CORRECTIVE_LINE_MAX + 1),
    "bounds: each line is cut to the line limit",
  );
}

// ── the record: "not-run" is not "ran and nothing failed" ──
{
  const notRun: CorrectiveGateView = {
    ok: false,
    failures: [CANCEL_TEXT],
    verifyRun: { status: "not-run" },
  };
  assert(ctx(notRun).round === false, "not-run: a gate whose verify command never ran gets no round");
  assert(
    ctx(perWorktreeGate(WT_A, CANCEL_TEXT)).round === true,
    "not-run control: the same failure from a run that did happen earns the round",
  );
}

// ── a failing worktree with no assertion line is reported as skipped, not dropped ──
{
  const plainB = `verify command \`${CMD}\` failed in ${WT_B}: something went wrong`;
  const gate: CorrectiveGateView = {
    ok: false,
    failures: [CANCEL_TEXT, plainB],
    verifyRun: {
      status: "ran",
      command: CMD,
      failures: [CANCEL_TEXT, plainB],
      perWorktree: [
        { cwd: WT_A, text: CANCEL_TEXT },
        { cwd: WT_B, text: plainB },
      ],
    },
  };
  const d = ctx(gate);
  assert(
    d.round === true && d.targets.length === 1 && d.skipped.length === 1,
    "skipped: the worktree without an assertion line is not targeted, and is reported",
  );
  assert(
    d.round === true && (d.skipped[0] ?? "").includes(WT_B),
    "skipped: the report names the worktree that was skipped",
  );
}

if (exit !== 0) process.exit(exit);
console.log("all corrective-decide assertions passed");
