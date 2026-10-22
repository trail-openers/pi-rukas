#!/usr/bin/env bun
/**
 * #1765 — the two pure rules the base-health probe's cache and cap rest on.
 *
 * 13 — a bare `[verify-timeout]` entry attributes to NO base. The
 * `red-timed-out` arm of `baselineRedMessage` leads with `[baseline-red]` and
 * then the `[verify-timeout]` label, so "this entry contains the timeout
 * label" cannot tell a base the probe proved red from a fast-tier, smoke or
 * consolidated run the gate itself killed at its bound. Only the latter
 * happens on a healthy base — and reading it as the former raises the develop
 * cap to `verify-baseline-red:develop`, the cap that tells an operator to go
 * fix the base, when the actionable diagnosis is a bound that was too short.
 * So the marker is required, and the timeout label is accepted only alongside
 * it. Each case names the gate's OWN command: position is deliberately not
 * what saves these, since the timed-out arm puts the command after both
 * labels. `verifyCapFor`'s precedence for a killed run is pinned in
 * `test-verify-no-verdict-caps.ts`.
 *
 * 14 — a cache file written BEFORE #1765 dropped `at` still reads as the green
 * it is. The field is ignored, never required: rejecting it would re-pay a
 * full suite run to re-learn a fact about an immutable commit, which is the
 * whole cost argument for the cache.
 *
 * Split out of `test-verify-base-health-probe.ts` for AGENTS.md §12's 500-line
 * cap (that file was sitting at it). Case 13 needs no fixture at all; case 14
 * reuses the probe harness's own repo builder.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import {
  baselineRedForCmd,
  baselineRedForCommand,
} from "../src/work-driver-verify-base-health.ts";
import {
  applyBaseHealthProbe,
  baseHealthCacheFile,
  probeBaseAtBranch,
  readBaseHealthCache,
} from "../src/work-driver-verify-base-health.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import { VERIFY_TIMEOUT_LABEL } from "../src/work-driver-verify-develop-helpers.ts";
import { developTierTimeouts } from "../src/work-driver-verify-budget.ts";
import { aggregateVerifyOutcome } from "../src/work-driver-verify-aggregate.ts";
import {
  PROBE_CMD as CMD,
  GREEN_GATE,
  RED_GATE,
  branchState,
  capsOf,
  notesOf,
  probe,
} from "./lib/base-health-probe-fixture.ts";
import {
  commitAll,
  probeFailureExecutor,
  stateWithRedProbe,
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

const killed = (cmd: string) =>
  `${VERIFY_TIMEOUT_LABEL} verify command \`${cmd}\` exceeded its 10-min timeout`;

// ── 13 — a bare `[verify-timeout]` names no base.
assert(
  baselineRedForCommand(killed(CMD), CMD) === false,
  "attribution: a bare [verify-timeout] naming the command is NOT a red base",
);
assert(
  baselineRedForCmd([killed(CMD), "verify command `x` failed: expected 1, got 2"], CMD) === false,
  "attribution: a killed fast-tier run beside a real failure establishes no red base",
);
assert(
  baselineRedForCmd([killed(CMD)], CMD) === false,
  "attribution: a killed smoke run alone establishes no red base either",
);
assert(
  baselineRedForCommand(
    `${BASELINE_RED_MARKER} ${VERIFY_TIMEOUT_LABEL} verify command \`${CMD}\` exceeded its bound`,
    CMD,
  ) === true,
  "attribution: the timed-out arm (marker + timeout label) still attributes to the base",
);
assert(
  baselineRedForCommand(`${BASELINE_RED_MARKER} verify command \`${CMD}\` ALSO FAILS`, CMD) ===
    true,
  "attribution: the plain red arm still attributes to the base",
);
assert(
  baselineRedForCommand(`${BASELINE_RED_MARKER} verify command \`other.sh\` ALSO FAILS`, CMD) ===
    false,
  "attribution: a marker naming a different command is not this run's base",
);

// ── 14 — a legacy cache file that still carries `at` stays readable.
{
  __setHostBudget({ verifyConcurrency: 0 } as HostBudget);
  const root = mkdtempSync(path.join(tmpdir(), "pi-base-health-legacy-"));
  const f = await redGateFixture(root, "legacy-at", GREEN_GATE, { "notes.md": "x\n" });
  mkdirSync(path.dirname(baseHealthCacheFile(f.repo)), { recursive: true });
  const bound = (await developTierTimeouts(f.repo)).suite;
  writeFileSync(
    baseHealthCacheFile(f.repo),
    JSON.stringify({
      verdict: {
        status: "green",
        baseSha: f.baseSha,
        command: CMD,
        tierBoundMs: bound,
        at: 1_700_000_000_000,
      },
    }),
  );
  const legacy = await readBaseHealthCache(
    async () => readFileSync(baseHealthCacheFile(f.repo), "utf8"),
    f.repo,
  );
  assert(
    legacy?.status === "green" && !("at" in (legacy ?? {})),
    "legacy cache: a file that still carries at is readable, and the extra field is dropped",
  );
  const r = await probe(f);
  assert(
    r.gateRuns.length === 0 && capsOf(r.state).length === 0,
    `legacy cache: the pre-#1765 green answers for the run and costs no suite re-run (got ${r.gateRuns.length})`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ── 15 — the harness-echo rule reads the WHOLE stream, not its first line.
//
// `combinedExecFailureStream` falls back to the Error's own message when the
// child printed nothing, and node always leads that with `Command failed:
// <cmd>`. A stream that reduces to the echo is the harness talking and must be
// `unknown`; a stream with real gate output beneath the echo is a red base.
// The old rule bailed out on any newline, so it answered on the first line
// alone — and a harness that prints its own banner under the echo would have
// handed the probe a red base it never observed.
{
  const streamRoot = mkdtempSync(path.join(tmpdir(), "pi-base-stream-"));
  const probeStream = async (stdout: string, stderr = "") => {
    const f = await redGateFixture(streamRoot, `stream-${streams.length}`, GREEN_GATE, {
      "notes.md": "x\n",
    });
    streams.push({ f, stdout, stderr });
    return f;
  };
  const streams: Array<{ f: Awaited<ReturnType<typeof redGateFixture>>; stdout: string; stderr: string }> =
    [];
  const fixtures = [
    // The echo alone, in each of its spellings: nothing beneath it.
    { name: "echo alone", stdout: `Command failed: ${CMD}`, want: "unknown" },
    {
      name: "echo alone, shell-quoted invocation",
      // The wrapper's own punctuation is the harness speaking, not the gate:
      // `sh -c` is a spelling of the invocation, and a stream that reduces to
      // `sh -c` plus the command is the echo alone.
      stdout: `Command failed: sh -c ${CMD}`,
      want: "unknown",
    },
    {
      name: "echo alone, JSON-escaped invocation",
      stdout: `Command failed: ${JSON.stringify(CMD)}`,
      want: "unknown",
    },
    {
      name: "echo alone, whitespace between",
      stdout: `Command failed: ${CMD}\n   \n\t\n`,
      want: "unknown",
    },
    // The echo plus a real failure line: the gate spoke, so this IS a red base.
    {
      name: "echo plus a real failure",
      stdout: `Command failed: ${CMD}\n✗ tests/test-red.ts: expected 1, got 2\n`,
      want: "red",
    },
    {
      name: "echo plus a compiler error",
      stdout: `Command failed: ${CMD}\nsrc/a.ts(3,1): error TS2345: nope\n`,
      want: "red",
    },
    // Content in stderr only, and an echo-free stream: both judged by the gate.
    {
      name: "failure on stderr only",
      stdout: `Command failed: ${CMD}`,
      stderr: "✗ tests/test-red.ts: expected 1, got 2",
      want: "red",
    },
    { name: "no echo at all", stdout: "error: test failed", want: "red" },
  ] as const;
  __setHostBudget({ verifyConcurrency: 0 } as HostBudget);
  for (const c of fixtures) {
    const f = await probeStream(c.stdout, c.stderr);
    const out = await applyBaseHealthProbe(
      async (command, o) => {
        const line = o?.argv ? [command, ...o.argv].join(" ") : command;
        if (!line.startsWith("git ") && existsSync(`${o?.cwd ?? ""}/gate.sh`)) {
          throw Object.assign(new Error(`Command failed: ${command}`), {
            stdout: c.stdout,
            stderr: c.stderr,
            code: 1,
          });
        }
        return await realExec(command, o);
      },
      { host: {}, repoRoot: f.repo, issue: 1765 } as never,
      branchState(f.baseSha),
      CMD,
    );
    assert(
      out.verdict?.status === c.want,
      `harness echo (${c.name}): ${c.want} (got ${out.verdict?.status} — ${out.verdict?.reason ?? "no reason"})`,
    );
    assert(
      c.want === "red" ? out.park !== undefined : out.park === undefined,
      `harness echo (${c.name}): ${c.want === "red" ? "real output still parks" : "the harness alone never parks"}`,
    );
  }
  rmSync(streamRoot, { recursive: true, force: true });
}

// ── 16 — the develop gate's reuse rebuilds the arm the record says it was.
//
// A cached `red` whose probe was killed at the bound is a RED-TIMED-OUT: it
// earned a colour and no stream, so the failure it writes must name the bound,
// not an assertion. Rebuilding a plain `red` from it was the #1765
// lens-round-1 defect — it told an operator to go fix a test nobody ran.
for (const timedOut of [false, true]) {
  const reuseRoot = mkdtempSync(path.join(tmpdir(), "pi-base-reuse-"));
  const f = await redGateFixture(reuseRoot, `reuse-arm-${timedOut}`, RED_GATE, {
    "notes.md": "x\n",
  });
  const bound = (await developTierTimeouts(f.repo)).suite;
  const held = stateWithRedProbe(f.baseSha, CMD, bound, { timedOut });
  let worktreeAdds = 0;
  const execFn = async (command: string, o?: Parameters<typeof realExec>[1]) => {
    const line = o?.argv ? [command, ...o.argv].join(" ") : command;
    if (line.startsWith("git worktree add")) worktreeAdds += 1;
    return await realExec(command, o);
  };
  const failures: string[] = ["verify command `sh gate.sh` failed in worktree a: expected 1, got 2"];
  const notes: string[] = [];
  const established: boolean[] = [];
  const attributed = await aggregateVerifyOutcome({
    execFn,
    ctx: { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    cmd: CMD,
    baseSha: f.baseSha,
    suiteTimeoutMs: bound,
    cons: {
      status: "failed",
      detail: failures[0],
      rawFailure: failures[0],
      timedOut: false,
    } as never,
    perWorktreeVerifyFailures: [],
    failures,
    notes,
    baseHealthProbe: held.pipelineState.baseHealthProbe,
    onBaselineRedEstablished: (est) => established.push(est),
  });
  assert(
    worktreeAdds === 0,
    `reuse arm (timedOut=${timedOut}): no second throwaway worktree (got ${worktreeAdds})`,
  );
  assert(
    attributed === false,
    `reuse arm (timedOut=${timedOut}): a reused verdict holds no stream, so it never earns #1349's excuse`,
  );
  const entry = failures.find((x) => x.startsWith(BASELINE_RED_MARKER)) ?? "";
  assert(
    entry.length > 0,
    `reuse arm (timedOut=${timedOut}): the finding still leads the failures`,
  );
  assert(
    timedOut
      ? entry.includes(VERIFY_TIMEOUT_LABEL) && !entry.includes("assertion at base")
      : entry.includes("ALSO FAILS") && !entry.includes(VERIFY_TIMEOUT_LABEL),
    `reuse arm (timedOut=${timedOut}): the ${timedOut ? "timed-out arm names the bound, not an assertion" : "plain red names the assertion, not a bound"} (${entry.slice(0, 120)})`,
  );
  // #1765 — the CAP's claim is what `reportBaselineLeg` reads, and it must
  // travel for BOTH arms: the timed-out entry leads with the timeout label, so
  // prose matching cannot recover the claim from the failure list alone.
  assert(
    established.length === 1 && established[0] === true,
    `reuse arm (timedOut=${timedOut}): the established-red claim reached the callback (${JSON.stringify(established)})`,
  );
  rmSync(reuseRoot, { recursive: true, force: true });
}

// ── 17 — the branch step's whole seam degrades on a filesystem fault instead
// of taking the step down. Two faults, one for each side of the probe: the
// cache path being unreachable (so the probe's own reads and its green write
// both fault), and the executor failing every call the seam makes.
{
  const seamRoot = mkdtempSync(path.join(tmpdir(), "pi-base-seam-"));
  const f = await redGateFixture(seamRoot, "seam-throws", GREEN_GATE, { "notes.md": "x\n" });
  // The probe resolves the project's command before it runs, so the fixture has
  // to declare one — a fixture with no `.pi/verify-cmd` skips the probe entirely
  // and the case would report the skip, not the degradation.
  mkdirSync(path.join(f.repo, ".pi"), { recursive: true });
  writeFileSync(path.join(f.repo, ".pi", "verify-cmd"), `${CMD}\n`);
  // The unreachable cache path must be in place BEFORE the probe reads it, so
  // this is where it goes and not later: the probe consults the cache before it
  // pays for the suite, and a file put there afterwards would have been read
  // as a directory and the case would test nothing.
  writeFileSync(path.dirname(baseHealthCacheFile(f.repo)), "not a directory");
  const before = branchState(f.baseSha);
  const after = await probeBaseAtBranch(
    probeFailureExecutor({ shape: "pass" }),
    { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    before,
  );
  assert(
    capsOf(after).length === 0,
    `unrecordable probe: the branch step parks nothing (got ${JSON.stringify(capsOf(after).map((c) => c.cap))})`,
  );
  // A green the probe recorded, or nothing at all — never a green that stands
  // on the state while the file the next cycle reads does not exist. That last
  // is the false green this wrap exists to prevent: `writeBaseHealthCache`
  // swallows its own fault (a failed write should cost a later re-probe and
  // nothing else), so without the try around the call an unrecordable cache
  // left `baseHealthProbe: green` on the state, and every later cycle skipped
  // its suite for a verdict nobody ever wrote down. The canary for that is this
  // exact case with the try removed: state green, cache absent.
  const recorded = await readBaseHealthCache(
    async () => readFileSync(baseHealthCacheFile(f.repo), "utf8"),
    f.repo,
  ).catch(() => undefined);
  assert(
    after.pipelineState.baseHealthProbe?.status === "green"
      ? recorded?.status === "green"
      : after.pipelineState.baseHealthProbe?.status === "unknown",
    `unrecordable probe: a green never stands without the cache file behind it (state ${after.pipelineState.baseHealthProbe?.status ?? "absent"}, cache ${recorded?.status ?? "absent"})`,
  );
  assert(
    notesOf(after).length === 1,
    `unrecordable probe: exactly one note reached the event log (got ${JSON.stringify(notesOf(after))})`,
  );
  // #1765 lens round 3 — the event's `ms` is the probe's REAL wall clock. It used
  // to be synthesised from `startedAt: Date.now()` at the append, so a probe that
  // spent seven minutes in one suite run reported 0 ms, and the one number a
  // reader of the log has for what the probe cost was a lie that made the probe
  // look free. The event is the branch step's only record of the probe, so the
  // duration is not decoration. GREEN is the arm that reaches the note append
  // (a RED returns its park early and appends nothing), and the gate sleeps past
  // the floor so the measured ms cannot be satisfied by fixture setup alone.
  //
  // A second fixture, not this one: the cache path above is deliberately a plain
  // file, so a green probe here could not be recorded and would answer `unknown`
  // — which appends no event and would leave this assertion testing nothing.
  const timed = await redGateFixture(seamRoot, "seam-timed", GREEN_GATE, { "notes.md": "x\n" });
  const slowGate = path.join(seamRoot, "timed-gate.sh");
  writeFileSync(slowGate, "#!/bin/sh\nsleep 0.4\nexit 0\n", {
    mode: 0o755,
  });
  writeFileSync(path.join(timed.repo, "gate.sh"), `#!/bin/sh\nexec sh ${slowGate}\n`, {
    mode: 0o755,
  });
  commitAll(timed.repo, "chore: timed gate");
  // The fixture's own builder writes `.pi/verify-cmd` through the probe wrapper,
  // not through `redGateFixture`, so this fixture has to declare its command the
  // way a project does — without it the seam skips and reports the skip.
  mkdirSync(path.join(timed.repo, ".pi"), { recursive: true });
  writeFileSync(path.join(timed.repo, ".pi", "verify-cmd"), `${CMD}\n`);
  const timedBase = (
    await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: timed.repo })
  ).stdout.trim();
  const after17 = await probeBaseAtBranch(
    async (command, o) => {
      // The driver's `synthesizeDriverCompletion` reads `process.env.RUN_ID` via
      // `makeRunId()`, which throws without it — and a smoke test that runs this
      // seam outside `lib/verify-loop.sh` has no RUN_ID. Production always has
      // one (the driver sets it per cycle), so the executor supplies the shape a
      // real child has rather than the assertion testing a crash.
      const line = o?.argv ? [command, ...o.argv].join(" ") : command;
      if (line.startsWith("git ") || o?.env === undefined) {
        return await realExec(command, o);
      }
      return await realExec(command, { ...o, env: { ...o.env, RUN_ID: "smoke-probe" } });
    },
    { host: {}, repoRoot: timed.repo, issue: 1765 } as never,
    branchState(timedBase),
  );
  const probeEvent = after17.eventLog.find(
    (e) => e.kind === "dispatch-completed" && e.label === "driver:base-health",
  ) as { ms?: number; summary?: string } | undefined;
  assert(
    probeEvent !== undefined && typeof probeEvent.ms === "number" && probeEvent.ms >= 300,
    `probe duration: the step-completed event carries the probe's measured ms (got ${probeEvent?.ms}) — not 0 as though nothing ran`,
  );
  assert(
    (probeEvent?.summary ?? "").includes("is GREEN"),
    `probe duration: the timed run still reached its verdict, so the ms is a real probe's (${JSON.stringify(probeEvent?.summary)})`,
  );
  assert(
    after17.pipelineState.baseHealthProbe?.status === "green",
    `probe duration: the timed probe recorded the green it earned (got ${after17.pipelineState.baseHealthProbe?.status ?? "absent"})`,
  );
  rmSync(seamRoot, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
