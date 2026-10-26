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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import { aggregateVerifyOutcome } from "../src/work-driver-verify-aggregate.ts";
import { baselineRedForCmd, baselineRedForCommand } from "../src/work-driver-verify-base-health.ts";
import {
  applyBaseHealthProbe,
  baseHealthCacheFile,
  probeBaseAtBranch,
  readBaseHealthCache,
  startBaseHealthProbeAtBranch,
} from "../src/work-driver-verify-base-health.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import { developTierTimeouts } from "../src/work-driver-verify-budget.ts";
import { VERIFY_TIMEOUT_LABEL } from "../src/work-driver-verify-develop-helpers.ts";
import {
  PROBE_CMD as CMD,
  GREEN_GATE,
  RED_GATE,
  branchState,
  baseLeg,
  capsOf,
  consultedEvent,
  keyFor,
  notesOf,
  probe,
  settled,
} from "./lib/base-health-probe-fixture.ts";
import type { ProbeRun } from "./lib/base-health-probe-fixture.ts";
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
  const streams: Array<{
    f: Awaited<ReturnType<typeof redGateFixture>>;
    stdout: string;
    stderr: string;
  }> = [];
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
      await keyFor(f.repo, f.baseSha),
    );
    assert(
      out.verdict?.status === c.want,
      `harness echo (${c.name}): ${c.want} (got ${out.verdict?.status} — ${out.verdict?.reason ?? "no reason"})`,
    );
    assert(
      c.want === "red" ? out.red !== undefined : out.red === undefined,
      `harness echo (${c.name}): ${c.want === "red" ? "real output still carries evidence for the develop gate" : "the harness alone carries no evidence"}`,
    );
  }
  rmSync(streamRoot, { recursive: true, force: true });
}

// ── 16 — the develop gate's two base channels, observed end to end.
//
// A RED this gate pass collected from the background probe is the one colour the
// develop round may reuse, and #1826 makes the reuse answerable: the arm carries
// the record's `secondRun: "red"` into `confirmRedBase`, which confirms it with NO
// suite run and keeps the cycle's `established` claim. A KILLED red is the opposite
// arm — #1826 gives it no second run and no claim, `compareWithBaseline` refuses its
// reuse, and the only prose it can legitimately produce is the timeout's own
// sentence, which its REAL run has to earn (the fixture's gate would otherwise print
// an assertion for a gate that printed nothing).
//
// The two arms travel through one helper, `baseLeg`, because a case written twice
// drifts: the killed arm's "no confirming tree" assertion and the reuse arm's "no
// tree at all" assertion are the same observation at two costs, and only one of them
// can quietly stop being falsifiable.
for (const timedOut of [false, true]) {
  const reuseRoot = mkdtempSync(path.join(tmpdir(), "pi-base-reuse-"));
  const f = await redGateFixture(reuseRoot, `reuse-arm-${timedOut}`, RED_GATE, {
    "notes.md": "x\n",
  });
  const bound = (await developTierTimeouts(f.repo)).suite;
  const held = stateWithRedProbe(f.baseSha, CMD, bound, { timedOut });
  // #1809/#1826 — the arm under test is the RED this gate pass collected from the
  // background probe, the ONLY channel a red reuses through, and it carries
  // `secondRun: "red"` (the fixture's default: the probe watched both runs), which
  // is what makes the reuse confirmable at all. The same verdict sitting in
  // `pipelineState` alone is NOT reusable (an in-state red must re-probe, so one
  // flaky red cannot speak for rounds it did not run in); that rule is pinned in
  // `test-verify-base-health-channels.ts`, and by the `fromInFlightProbe` flag in
  // the type. `timedOut` is the KILLED arm, which has no channel to lend through.
  const leg = await baseLeg(
    f.repo,
    f.baseSha,
    bound,
    { ...held.pipelineState.baseHealthProbe, ...(timedOut ? {} : { fromInFlightProbe: true }) },
    timedOut,
  );
  // #1826's cost rule, read off the trees: the reuse pays for nothing, and the
  // killed arm pays for ITS OWN run — exactly the tree the comparison's first run
  // owns (`-base1`), never the confirming one (`-base2`). See `baseLeg` for why a
  // tree is observed where a count would have lied.
  assert(
    leg.adds === (timedOut ? 1 : 0) &&
      leg.ran.length === (timedOut ? 1 : 0) &&
      (timedOut ? leg.ran[0]?.endsWith("-base1") === true : true),
    `base leg (timedOut=${timedOut}): ${timedOut ? "the killed arm is never reused: it pays for its own run and no confirming second run" : "the reuse pays for no throwaway worktree at all"} (adds=${leg.adds}, ran in ${JSON.stringify(leg.ran)})`,
  );
  assert(
    leg.attributed === false,
    `base leg (timedOut=${timedOut}): ${timedOut ? "a killed run printed no stream, so it excuses nothing" : "a reused verdict holds no stream, so it never earns #1349's excuse"}`,
  );
  // A KILLED arm raises NO plain `[baseline-red]` finding (a killed run confirms
  // nothing, #1826) and any `[baseline-red]` line a killed route does write leads
  // with the timeout's own label — never a red on a test nobody ran (the #1765
  // lens-round-1 shape). The reuse arm takes the opposite half: an unlabelled
  // `ALSO FAILS` finding naming the assertion.
  assert(
    timedOut
      ? leg.entry === "" ||
          (leg.entry.includes(VERIFY_TIMEOUT_LABEL) && !leg.entry.includes("ALSO FAILS"))
      : leg.entry.includes("ALSO FAILS") && !leg.entry.includes(VERIFY_TIMEOUT_LABEL),
    `base leg (timedOut=${timedOut}): the ${timedOut ? "killed arm raises no plain red-base finding — at most its own timeout sentence" : "reused plain red names the assertion, not a bound"} (${JSON.stringify(leg.entry.slice(0, 120))})`,
  );
  // The two channels stay distinct in what they SAY as well as what they cost: the
  // reuse announces that no run paid, the killed arm must not claim a free run it
  // did not have.
  assert(
    leg.reuseNotes.length > 0 === !timedOut,
    `base leg (timedOut=${timedOut}): ${timedOut ? "a killed arm claims no free reuse" : "the reuse says in its own note that no run paid"} (reuse notes ${JSON.stringify(leg.reuseNotes)})`,
  );
  // #1765 — the CAP's claim is what `reportBaselineLeg` reads: the reuse carries
  // it, and a killed arm, which #1826 gives no second run, claims nothing.
  assert(
    leg.established.length === 1 && leg.established[0] === !timedOut,
    `base leg (timedOut=${timedOut}): the established-red claim reached the callback (${JSON.stringify(leg.established)})`,
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
  const seam = await startBaseHealthProbeAtBranch(
    probeFailureExecutor({ shape: "pass" }),
    { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    before,
  );
  // The step returns its state WITHOUT the probe: that is the whole change. What
  // the probe answers arrives later, on the promise the step dropped.
  const after = probeBaseAtBranch(
    probeFailureExecutor({ shape: "pass" }),
    { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    before,
  );
  const out = await (seam ?? Promise.resolve({ ran: false, notes: [] }));
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
    out.verdict?.status !== "green" || recorded?.status === "green",
    `unrecordable probe: a green never stands without the cache file behind it (verdict ${out.verdict?.status ?? "absent"}, cache ${recorded?.status ?? "absent"})`,
  );
  assert(
    out.verdict === undefined || out.verdict.status === "unknown",
    `unrecordable probe: a probe whose cache path faults answers unknown, never a green nobody wrote (got ${out.verdict?.status ?? "absent"})`,
  );
  // The gate's own rule is that an unknown verdict is never a consultation — it
  // hands the base back to develop's own evidence and records nothing. What the
  // recorder does when handed one anyway is the question here: it must still say
  // what was read, so a log reader can tell a consultation from a silence.
  const logged = consultedEvent(after, out, "unknown");
  assert(
    notesOf(logged).length === 1 && notesOf(logged)[0].includes("UNKNOWN"),
    `unrecordable probe: a consultation the recorder is given is recorded truthfully, colour and all (got ${JSON.stringify(notesOf(logged))})`,
  );
  assert(
    out.notes.length >= 1,
    `unrecordable probe: the probe still says what happened (got ${JSON.stringify(out.notes)})`,
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
  const after17 = branchState(timedBase);
  const out17 = await startBaseHealthProbeAtBranch(
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
    after17,
  );
  // The promise the branch step itself drops, read through the shared `settled`
  // reader rather than a local `?? { ran: false }` fallback (which would let a
  // consultation record be built for a probe that did not exist).
  const settled17 = await settled({
    state: after17,
    gateRuns: [],
    worktreeAdds: 0,
    cacheRaw: undefined,
    outcome: out17,
  } as ProbeRun);
  assert(
    out17 !== undefined && settled17 !== undefined,
    "probe duration: a probe WAS registered for this base, so the ms below is a real probe's",
  );
  const logged17 = consultedEvent(after17, settled17, "green");
  const probeEvent = logged17.eventLog.find(
    (e) => e.kind === "dispatch-completed" && e.label === "driver:base-health",
  ) as { ms?: number; summary?: string } | undefined;
  assert(
    probeEvent !== undefined && typeof probeEvent.ms === "number" && probeEvent.ms >= 300,
    `probe duration: the step-completed event carries the probe's measured ms (got ${probeEvent?.ms}) — not 0 as though nothing ran`,
  );
  assert(
    (probeEvent?.summary ?? "").includes("GREEN"),
    `probe duration: the timed run still reached its verdict, so the ms is a real probe's (${JSON.stringify(probeEvent?.summary)})`,
  );
  assert(
    settled17.verdict?.status === "green",
    `probe duration: the timed probe reached the green it earned (got ${settled17.verdict?.status ?? "absent"})`,
  );
  rmSync(seamRoot, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
