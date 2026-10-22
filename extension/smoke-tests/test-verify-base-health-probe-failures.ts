#!/usr/bin/env bun
/**
 * #1765 — the arms a base probe can FAIL on, and what each one reaches the
 * caller as. Split out of `test-verify-base-health-probe.ts` (which drives the
 * happy paths, the cache and the cost rule) so each file stays under the
 * AGENTS.md §12 budget; the fixtures are shared in `lib/base-health-verdict-
 * fixture.ts`, and the assertions here are the ones that make the probe safe to
 * run at branch at all.
 *
 * The rule under test is that ONLY a real red parks. A stream that is just the
 * executor's own `Command failed:` echo, an executor that throws before the gate
 * ever runs, and a cycle that is already interrupted are each a probe that
 * answered nothing — they are `unknown` with a note, never a park and never a
 * green, because the branch step would otherwise be held (or a cycle failed) by
 * the harness rather than by the project's tests.
 *
 * Offline: temp git repos, no dispatch, no spawn.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import { synthesizeDriverCompletion } from "../src/work-driver-events.ts";
import { applyBaseHealthProbe } from "../src/work-driver-verify-base-health.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import {
  CMD,
  GREEN_GATE,
  RED_GATE,
  branchState,
  notesOf,
} from "./lib/base-health-probe-fixture.ts";
import {
  GATE_ECHO,
  announceGate,
  commitAll,
  probeFailureExecutor,
} from "./lib/base-health-verdict-fixture.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-base-health-fail-"));
/** The probe serialises behind `withVerifySlot`; unbounded keeps the suite fast. */
__setHostBudget({ verifyConcurrency: 0 } as HostBudget);

// ── 15 — the three arms a probe can fail on, each reaching the caller as what
// it actually was: a red that parks, an echo that proves nothing, and an
// executor that threw (which must NOT propagate).
for (const [label, shape, throwWhere, expect] of [
  ["red gate", "red", "before", "red"],
  ["echo-only", "echo-only", "before", "unknown"],
  // The executor failed on a git call the probe makes BEFORE its own try block
  // (`worktree add`, then provisioning), so nothing about the base was judged
  // and the probe must degrade rather than propagate or park.
  ["executor threw", "executor-threw", "git", "unknown"],
] as const) {
  const f = await redGateFixture(root, `exec-${label}`, RED_GATE, { "notes.md": "x\n" });
  // The marker is what distinguishes the gate call from every other non-git
  // call the probe makes, so the arms below can only ever be raised for it.
  announceGate(path.join(f.repo, "gate.sh"));
  commitAll(f.repo, "chore: announce the gate");
  const announced = (await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: f.repo })).stdout.trim();
  const gateRuns: string[] = [];
  const execFn = probeFailureExecutor({
    shape,
    throwWhere,
    gateMarker: GATE_ECHO,
    onGate: (line, cwd) => gateRuns.push(`${line}@${cwd}`),
  });
  let threw: string | undefined;
  let out: Awaited<ReturnType<typeof applyBaseHealthProbe>> | undefined;
  try {
    out = await applyBaseHealthProbe(
      execFn,
      { host: {}, repoRoot: f.repo, issue: 1765 } as never,
      branchState(announced),
      CMD,
    );
  } catch (err) {
    threw = (err as Error).message;
  }
  assert(
    threw === undefined,
    `executor ${label}: the probe does not propagate an executor rejection (threw ${threw ?? "nothing"})`,
  );
  // Which arms the gate itself ran for is a property of the arm, not a rule
  // each arm must satisfy: a real red ran it once, an echo-only run ran it and
  // printed nothing of its own, and an executor that threw never reached it.
  // What must hold for every arm is the answer and the park decision below.
  assert(
    gateRuns.length === (shape === "executor-threw" ? 0 : 1),
    `executor ${label}: the gate ran ${shape === "executor-threw" ? "not at all (the executor failed first)" : "exactly once"} (got ${gateRuns.length}) — the case is not vacuous`,
  );
  assert(
    out?.verdict?.status === expect,
    `executor ${label}: the verdict is ${expect} (got ${out?.verdict?.status})`,
  );
  assert(
    expect === "red" ? out?.park !== undefined : out?.park === undefined,
    `executor ${label}: ${expect === "red" ? "a real red still parks" : "no park — a probe that could not answer never fails the cycle"}`,
  );
  if (expect === "unknown") {
    assert(
      (out?.verdict?.reason ?? "").length > 0,
      `executor ${label}: the unknown verdict names why (${out?.verdict?.reason})`,
    );
  }
}

// ── 16 — an aborted cycle is not a verdict: neither an already-aborted signal
// nor one that fires during the probe may park, and neither may read as green.
{
  const mk = () =>
    redGateFixture(root, `abort-${Math.random().toString(36).slice(2)}`, GREEN_GATE, {
      "notes.md": "x\n",
    });
  // (a) aborted BEFORE the probe: no suite run is paid for at all.
  const before = await mk();
  const acBefore = new AbortController();
  acBefore.abort();
  let gateBefore = 0;
  const outBefore = await applyBaseHealthProbe(
    probeFailureExecutor({ shape: "pass", onGate: () => (gateBefore += 1) }),
    { host: {}, repoRoot: before.repo, issue: 1765, signal: acBefore.signal } as never,
    branchState(before.baseSha),
    CMD,
  );
  assert(
    gateBefore === 0 && outBefore.verdict?.status === "unknown" && outBefore.park === undefined,
    "abort before: no suite run, no verdict, no park",
  );
  assert(
    notesOf(
      appendEvent(
        initialState(1765),
        synthesizeDriverCompletion({
          step: "branch",
          label: "driver:base-health",
          summary: outBefore.notes.join("; "),
          startedAt: 0,
          now: 0,
        }),
      ),
    ).some((s) => s.includes("interrupted")),
    "abort before: the note says the cycle was interrupted, not that the base is fine",
  );
  // (b) aborted DURING the probe. The gate sleeps and exits 1, the controller
  // fires while it runs, and whatever that run then answers must not reach the
  // caller: an interrupted run judged nothing, so it is not a red base.
  const during = await mk();
  const slow = path.join(root, "slow-gate.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 2\nexit 1\n", { mode: 0o755 });
  writeFileSync(path.join(during.repo, "gate.sh"), `#!/bin/sh\nexec sh ${slow}\n`, {
    mode: 0o755,
  });
  commitAll(during.repo, "chore: slow gate");
  const slowBase = (
    await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: during.repo })
  ).stdout.trim();
  const acDuring = new AbortController();
  const timer = setTimeout(() => acDuring.abort(), 300);
  let gateDuring = 0;
  const outDuring = await applyBaseHealthProbe(
    async (cmd, o) => {
      const l = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
      if (!l.startsWith("git ")) gateDuring += 1;
      return await realExec(cmd, o);
    },
    { host: {}, repoRoot: during.repo, issue: 1765, signal: acDuring.signal } as never,
    branchState(slowBase),
    CMD,
  );
  clearTimeout(timer);
  assert(
    gateDuring === 1,
    `abort during: the probe did pay for the run before the abort landed (got ${gateDuring})`,
  );
  assert(
    outDuring.verdict?.status === "unknown" && outDuring.park === undefined,
    `abort during: unknown and no park (got ${outDuring.verdict?.status}) — an interrupted run judged nothing, and a red exit alone is not a verdict here`,
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
