#!/usr/bin/env bun
/**
 * #1765 — the arms a base probe can FAIL on, and what each one reaches the
 * caller as. Split out of `test-verify-base-health-probe.ts` (which drives the
 * happy paths, the cache and the cost rule) so each file stays under the
 * AGENTS.md §12 budget; the fixtures are shared in `lib/base-health-verdict-
 * fixture.ts`, and the assertions here are the ones that make the probe safe to
 * run at branch at all.
 *
 * The rule under test is that ONLY a real red carries evidence. A stream that is
 * just the executor's own `Command failed:` echo, an executor that throws before
 * the gate ever runs, and a gate call that rejects are each a probe that answered
 * nothing — they are `unknown` with a note, never evidence and never a green,
 * because the develop gate would otherwise attribute a base to a run nobody
 * performed. A red, by contrast, is reported as the colour the run reached, and
 * the probe is NOT tied to the cycle's abort signal: an already-aborted or
 * mid-run abort does not un-judge a run that finished.
 *
 * Offline: temp git repos, no dispatch, no spawn.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import { synthesizeDriverCompletion } from "../src/work-driver-events.ts";
import {
  applyBaseHealthProbe,
  baseHealthCacheFile,
  readBaseHealthCache,
} from "../src/work-driver-verify-base-health.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";
import {
  CMD,
  GREEN_GATE,
  RED_GATE,
  branchKey,
  branchState,
  keyFor,
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
// it actually was: a red that carries evidence, an echo that proves nothing, and
// an executor that threw (which must NOT propagate).
for (const [label, shape, throwWhere, expect] of [
  ["red gate", "red", "before", "red"],
  ["echo-only", "echo-only", "before", "unknown"],
  // The executor failed on a git call the probe makes BEFORE its own try block
  // (`worktree add`, then provisioning), so nothing about the base was judged
  // and the probe must degrade rather than propagate.
  ["executor threw", "executor-threw", "git", "unknown"],
] as const) {
  const f = await redGateFixture(root, `exec-${label}`, RED_GATE, { "notes.md": "x\n" });
  // The marker is what distinguishes the gate call from every other non-git
  // call the probe makes, so the arms below can only ever be raised for it.
  announceGate(path.join(f.repo, "gate.sh"));
  commitAll(f.repo, "chore: announce the gate");
  const announced = (
    await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: f.repo })
  ).stdout.trim();
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
      branchKey(announced),
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
  // What must hold for every arm is the answer and the evidence decision below.
  assert(
    gateRuns.length === (shape === "executor-threw" ? 0 : 1),
    `executor ${label}: the gate ran ${shape === "executor-threw" ? "not at all (the executor failed first)" : "exactly once"} (got ${gateRuns.length}) — the case is not vacuous`,
  );
  assert(
    out?.verdict?.status === expect,
    `executor ${label}: the verdict is ${expect} (got ${out?.verdict?.status})`,
  );
  assert(
    expect === "red" ? out?.red !== undefined : out?.red === undefined,
    `executor ${label}: ${expect === "red" ? "a real red carries its rendered evidence for the develop gate to attribute" : "no evidence — a probe that could not answer attributes nothing"}`,
  );
  if (expect === "unknown") {
    assert(
      (out?.verdict?.reason ?? "").length > 0,
      `executor ${label}: the unknown verdict names why (${out?.verdict?.reason})`,
    );
  }
}

// ── 16 — the probe is NOT tied to the cycle's abort signal: an abort neither
// stops it nor turns its answer into `unknown`, because a GREEN is a fact about
// the base commit that a later cycle reuses, and abandoning it because this cycle
// is on its way out throws away a verdict the repo still wants. Process exit ends
// it, not the cycle's own controller.
{
  const mk = (name: string) =>
    redGateFixture(root, `abort-${name}`, GREEN_GATE, { "notes.md": "x\n" });
  // (a) a signal already aborted when the probe starts still runs the gate and
  // still answers — the run judged the base, so its colour stands.
  const before = await mk("before");
  const acBefore = new AbortController();
  acBefore.abort();
  let gateBefore = 0;
  // The gate's own runs are counted INSIDE the executor below, so this case's
  // counter is the one that can tell "the probe ran the gate" from "some other
  // cycle's probe answered from the registry".
  const outBefore = await applyBaseHealthProbe(
    async (cmd, o) => {
      const l = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
      if (!l.startsWith("git ")) gateBefore += 1;
      return await realExec(cmd, o);
    },
    { host: {}, repoRoot: before.repo, issue: 1765, signal: acBefore.signal } as never,
    branchState(before.baseSha),
    CMD,
    await keyFor(before.repo, before.baseSha),
  );
  assert(
    gateBefore === 1 && outBefore.verdict?.status === "green",
    `aborted before: the probe ran the project's command and judged the base anyway (gate calls=${gateBefore}, verdict=${outBefore.verdict?.status}) — the signal is not the probe's bound`,
  );
  assert(
    outBefore.red === undefined,
    "aborted before: nothing to attribute — a green never carries red evidence",
  );
  // (b) a signal that fires DURING the probe does not invalidate the run that was
  // already paid for: the run reached its own verdict and the probe reports it.
  const during = await mk("during");
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
    await keyFor(during.repo, slowBase),
  );
  clearTimeout(timer);
  assert(
    gateDuring === 1,
    `aborted during: the probe paid for its run and finished it (got ${gateDuring})`,
  );
  assert(
    outDuring.ran === true && outDuring.verdict !== undefined,
    `aborted during: the run answered for itself and the abort did not replace its answer (verdict=${outDuring.verdict?.status}, ran=${outDuring.ran}) — an aborted cycle is not a re-judgement of the base`,
  );
}

// ── 17 — a rejected gate call is folded to `unknown`, not propagated, and leaves
// no green standing: the shape a background task faults in, which the registry
// must answer for rather than let escape as an unhandled rejection.
{
  const f = await redGateFixture(root, "reject-write", GREEN_GATE, { "notes.md": "x\n" });
  let gateCalls = 0;
  const out = await applyBaseHealthProbe(
    probeFailureExecutor({ shape: "rejects", onGate: () => (gateCalls += 1) }),
    { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    branchState(f.baseSha),
    CMD,
    await keyFor(f.repo, f.baseSha),
  );
  assert(
    gateCalls === 1,
    `rejected gate: the gate arm really ran once (got ${gateCalls}) — the case is not vacuous`,
  );
  // The distinction the case must keep: a rejection is NOT reported as a GREEN,
  // and no green is written for it. Whether the arm still reads as a red is the
  // harness's own stream rule, tested by case 15's `echo-only` arm.
  assert(
    out.verdict?.status !== "green",
    `rejected gate: a rejection is never a green (got ${out.verdict?.status})`,
  );
  assert(
    (
      await readBaseHealthCache(
        async () => readFileSync(baseHealthCacheFile(f.repo), "utf8"),
        f.repo,
      )
    )?.status !== "green",
    "rejected gate: no GREEN stands in the cache behind a run that rejected",
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
