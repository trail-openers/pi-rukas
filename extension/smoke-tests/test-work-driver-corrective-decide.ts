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
import { detailLooksCredential } from "../src/work-driver-verify-credential-screen.ts";
import { correctiveRoundFor } from "../src/work-driver-corrective-admission.ts";
import { depsHintApplies } from "../src/work-driver-verify-record.ts";
import {
  FAIL_HEADER,
  FAIL_HEADER_DETAILS,
  FAIL_HEADER_PASSING,
  FAIL_HEADER_STREAM,
} from "./lib/verify-failure-shapes-fixtures.ts";

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

// ── #1841: a FAIL header whose only evidence is its indented details ────────
// The park this closes: a gate whose whole failing block is
//
//     FAIL  the shell line budget (scripts/budget.max)
//           check-lines: 24639 lines, over the ceiling of 24576.
//           Take out 63 lines.
//     ok    shellcheck and the shell tests of the change
//     skip  the workspace's tests
//
// named no failing line at all, so `assertionLines` returned [] and the decision
// declined with "the per-worktree failures carry no specific failing line" — a
// develop round that one dispatch could have fixed parked instead. With the
// `fail-header` arm the header classifies, the round is earned, and the developer is
// given the indented lines that say WHAT to change rather than only which check went
// red. The ok/skip lines beside the block never reach them.
{
  const header = `verify command \`${CMD}\` failed in ${WT_A}: ${FAIL_HEADER_STREAM}`;
  const d = ctx(perWorktreeGate(WT_A, header));
  assert(
    d.round === true && d.source === "per-workstream",
    `fail-header: a FAIL header with indented details earns the corrective round (${JSON.stringify(d)})`,
  );
  if (d.round) {
    const given = d.targets[0]?.lines ?? [];
    assert(
      given.includes(FAIL_HEADER),
      `fail-header: the developer is given the header that names the check (got ${JSON.stringify(given)})`,
    );
    assert(
      FAIL_HEADER_DETAILS.every((l) => given.includes(l.trim())),
      `fail-header: the developer is given every indented detail line (got ${JSON.stringify(given)})`,
    );
    assert(
      !FAIL_HEADER_PASSING.some((l) => given.includes(l)),
      `fail-header: the ok/skip lines beside the block are never given (got ${JSON.stringify(given)})`,
    );
    assert(
      !given.some((l) => l.includes("verify command")),
      `fail-header: no target line opens with the harness sentence (got ${JSON.stringify(given)})`,
    );
    assert(
      given.every((l) => l.length <= CORRECTIVE_LINE_MAX) && given.length <= CORRECTIVE_MAX_LINES,
      "fail-header: the corrective line bounds still hold",
    );
    // #1841 round 2 (b) — the STORED channel is the assertions alone. This is the
    // list `work-driver-corrective-round.ts` writes as the `corrective-round`
    // event's `evidenceLines`, which `correctiveRoundFor(...).evidence` hands the
    // fix-pass fence to admit a file the round "named": a gate's indented prose
    // under a header must never widen that fence.
    const stored = d.targets[0]?.evidence ?? [];
    assert(
      stored.includes(FAIL_HEADER) &&
        !FAIL_HEADER_DETAILS.some((l) => stored.includes(l.trim())),
      `fail-header: the recorded evidence is the header alone, never a detail line (got ${JSON.stringify(stored)})`,
    );
    assert(
      stored.length < given.length,
      `fail-header: the prompt is the wider channel, the record the narrower one (stored ${stored.length}, given ${given.length})`,
    );
    // The fence reads its admission evidence through `correctiveRoundFor`, whose
    // `evidence` is `evidenceLines.join("\n")` — so the ONE thing that must never
    // appear there is a detail line. Asserted against the function the fence calls,
    // not against the field, so a future join or a widened record fails here.
    const fenceEvidence = correctiveRoundFor(
      [
        {
          kind: "corrective-round",
          at: 1,
          step: "develop",
          workstreamId: "a",
          attempt: 1,
          command: CMD,
          evidenceLines: stored,
        },
      ],
      "a",
    )?.evidence;
    assert(
      fenceEvidence === stored.join("\n") &&
        !FAIL_HEADER_DETAILS.some((l) => (fenceEvidence ?? "").includes(l.trim())),
      `fail-header: the fence's admission evidence is the assertions joined, never a detail (got ${JSON.stringify(fenceEvidence)})`,
    );
    // And a credential under the header is refused by the screen the detail channel
    // asks — the arm `isNonAssertionLine` does not carry (fixtures assembled from
    // pieces: a literal key-shaped string here trips GitHub push protection).
    const b64 = "Q29tcGxldGVseUZhcms=".repeat(3);
    assert(
      FAIL_HEADER_DETAILS.every((l) => detailLooksCredential(l.trim()) === false) &&
        detailLooksCredential(`ssh-${"rsa"} AAAA${b64}`) === true,
      "fail-header: the detail screen refuses an unprefixed base64 blob and leaves the real prose alone",
    );
  }
}

// ── #1841 round 2 (c) — a missing-module DETAIL declines the round ─────────
// The dependency rule used to read the assertions only, so a `FAIL` block whose
// header named the check and whose DETAILS said `Cannot find module 'zod'` earned a
// round against a tree whose dependencies are simply missing — the developer was
// dispatched to "repair" a worktree whose `node_modules` is not there, and the deps
// hint that names the real cause was suppressed. The check now asks both channels.
{
  const missing = `verify command \`${CMD}\` failed in ${WT_A}: ${FAIL_HEADER}\n      Cannot find module 'zod' from x.ts`;
  assert(
    ctx(perWorktreeGate(WT_A, missing)).round === false,
    "missing-module detail: a dependency signature beneath a header declines the round",
  );
  // `depsHintApplies` is a SEPARATE reader with its own documented rule — the hint
  // is suppressed when an ASSERTION was extracted, and here one was (the header),
  // so the hint is suppressed and the operator sees no deps sentence at all. That
  // asymmetry is the residual of this case, recorded rather than papered over:
  // what protects the cycle is the DECISION, which reads both channels and
  // declines. The assertion-only stream the old rule saw carried no signature,
  // which is exactly how the round used to be spent on a missing dependency.
  assert(
    depsHintApplies(missing) === false,
    "missing-module detail: the hint follows its own assertion rule (suppressed here — the decision is what declines)",
  );
  // Control beside it: the same header with an ordinary detail earns the round.
  assert(
    ctx(perWorktreeGate(WT_A, `verify command \`${CMD}\` failed in ${WT_A}: ${FAIL_HEADER_STREAM}`))
      .round === true,
    "missing-module detail control: an ordinary detail still earns the round",
  );
}

// ── #1841 round 2 — a credential under a header never reaches the developer ─
// Fixtures are ASSEMBLED at runtime from pieces; a literal key-shaped string in
// this file trips GitHub push protection.
{
  const b64 = "Q29tcGxldGVseUZhcms=".repeat(3);
  const tell = b64.slice(0, 12);
  const secret = `verify command \`${CMD}\` failed in ${WT_A}: ${FAIL_HEADER}\n      ssh-${"rsa"} AAAA${b64}`;
  const d = ctx(perWorktreeGate(WT_A, secret));
  assert(d.round === true, "secret detail: the header still earns the round");
  const given = d.round ? (d.targets[0]?.lines ?? []) : [];
  const stored = d.round ? (d.targets[0]?.evidence ?? []) : [];
  assert(
    !given.some((l) => l.includes(tell)) && !stored.some((l) => l.includes(tell)),
    `secret detail: no credential reaches the prompt or the fence evidence (prompt ${JSON.stringify(given)}, record ${JSON.stringify(stored)})`,
  );
}

if (exit !== 0) process.exit(exit);
console.log("all corrective-decide assertions passed");
