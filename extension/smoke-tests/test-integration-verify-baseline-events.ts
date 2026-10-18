#!/usr/bin/env bun
/**
 * #1404 — what the commit-pr baseline probe LEAVES BEHIND, and what it costs.
 *
 * Split from `test-integration-verify-baseline-probe.ts` for the 500-line cap
 * (AGENTS.md §12); that file keeps the attribution decisions, this one keeps
 * the consequences of the continue path. Those are different questions with
 * different failure modes: the parser can be right and the cycle still broken,
 * because a push with a red gate has to be *recorded*, has to be *reversible*
 * (the escape hatch), and must not slow down the cycles that were never sick.
 *
 * Three claims, each of which fails silently if nobody checks it:
 *
 *  1. the event. A cycle that pushed on a red gate is the one state an operator
 *     reads afterward and thinks "the gate was green". The dedicated event is
 *     the only record that says otherwise, and it must not disturb the event-log
 *     tail `nextStep()` routes on — appending a routing-significant event here
 *     would change the state machine by the back door.
 *  2. the escape hatch. `PI_ENSEMBLE_INTEGRATION_VERIFY_BASELINE_PROBE=0` must
 *     restore the pre-feature behaviour exactly, including the push being
 *     withheld. A knob that only changes the message is not an escape hatch.
 *  3. the cost. A green gate must never spawn a probe, or fixing four parked
 *     cycles would make every healthy cycle slower than the bug did.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { integrate } from "../src/work-driver-integrate.ts";
import { finalizeCommitPrState } from "../src/work-driver-commit-pr-events.ts";
import { initialState } from "../src/workflow-state.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { execFileP, redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-baseline-ev-"));

try {
  // ── the probe records the continue in the event log, and routes nothing
  {
    const f = await redGateFixture(root, "bp-event", ["tests/test-red.ts"], {
      "notes.md": "x\n",
    });
    const base = initialState(1404, 1000);
    const res = {
      ok: true as const,
      empty: false as const,
      workstreams: ["default"],
      preExistingOnly: true,
      preExistingFailures: ["smoke-tests/test-gate-red.ts", "smoke-tests/test-gate-red-2.ts"],
    };
    const continued = finalizeCommitPrState(
      base,
      2000,
      1500,
      ["default"],
      "feature/issue-1404",
      99,
      res as never,
      { ok: false, error: "not exercised" } as never,
      undefined,
      false,
      f.baseSha,
    );
    const ev = continued.eventLog.filter((e) => e.kind === "consolidated-verify-pre-existing");
    assert(
      ev.length === 1 &&
        ev[0]?.kind === "consolidated-verify-pre-existing" &&
        ev[0].step === "commit-pr" &&
        ev[0].failures.length === 2 &&
        ev[0].baseSha === f.baseSha,
      `#1404: continuing on pre-existing-only failures appends a dedicated event naming the tests and the base (${JSON.stringify(ev)})`,
    );
    // Routing must be untouched: the event is appended BEFORE the step's
    // completion event, which is the tail `nextStep()` reads.
    const tail = continued.eventLog[continued.eventLog.length - 1];
    assert(
      tail?.kind === "dispatch-completed",
      `#1404: the new event never becomes the event-log tail nextStep() routes on (tail is ${tail?.kind})`,
    );
    // Mutation check: the same call with no pre-existing verdict adds nothing.
    const clean = finalizeCommitPrState(
      base,
      2000,
      1500,
      ["default"],
      "feature/issue-1404",
      99,
      { ...res, preExistingOnly: undefined, preExistingFailures: undefined } as never,
      { ok: false, error: "not exercised" } as never,
      undefined,
      false,
      f.baseSha,
    );
    assert(
      !clean.eventLog.some((e) => e.kind === "consolidated-verify-pre-existing"),
      "#1404 (control): a commit-pr that did not excuse anything records no pre-existing event",
    );
  }

  // ── the escape hatch: with the probe disabled, a base-red gate parks as before
  {
    const f = await redGateFixture(root, "bp-hatch", ["tests/test-red.ts"], {
      "notes.md": "x\n",
    });
    process.env.PI_ENSEMBLE_INTEGRATION_VERIFY_BASELINE_PROBE = "0";
    let r;
    try {
      r = await integrate(realExec, {
        repoRoot: f.repo,
        branchName: "feature/bp-hatch",
        baseSha: f.baseSha,
        worktrees: f.worktrees,
        scratchDir: f.scratch,
        commitTitle: "feat: a change",
        commitBody: "b",
        mode: "create",
        requireAllNonEmpty: true,
        verifyCmd: "sh gate.sh",
        baselineBaseSha: f.baseSha,
      });
    } finally {
      delete process.env.PI_ENSEMBLE_INTEGRATION_VERIFY_BASELINE_PROBE;
    }
    assert(
      !r.ok && r.failure === "verify",
      `#1404 escape hatch: PI_ENSEMBLE_INTEGRATION_VERIFY_BASELINE_PROBE=0 parks the base-red failure as it did before the feature (got ${JSON.stringify(r.ok ? "ok" : r.failure)})`,
    );
    const pushed = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
    assert(
      !pushed.stdout.includes("feature/bp-hatch"),
      "#1404 escape hatch: nothing is pushed with the probe disabled",
    );
  }

  // ── a green gate stays green: the happy path never pays for a probe
  {
    const f = await redGateFixture(root, "bp-green", ["tests/allpass-a.ts"], {
      "notes.md": "x\n",
    });
    const gateRuns: string[] = [];
    const counting = (async (cmd: string, o?: Parameters<typeof realExec>[1]) => {
      const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
      // The probe's signature is its throwaway tree; the gate itself runs
      // "sh gate.sh" in the integration tree, which never mentions one.
      if (line.includes("baseline-verify-")) gateRuns.push(line);
      return realExec(cmd, o);
    }) as typeof realExec;
    const r = await integrate(counting, {
      repoRoot: f.repo,
      branchName: "feature/bp-green",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "feat: a change",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd: "sh gate.sh",
      baselineBaseSha: f.baseSha,
    });
    assert(r.ok, "#1404 green gate: a passing consolidated tree still integrates");
    assert(
      gateRuns.length === 0,
      `#1404 green gate: the probe never ran on a green gate — the happy path pays nothing extra (probe execs: ${gateRuns.length})`,
    );
  }
} finally {
  mkdirSync(root, { recursive: true });
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
