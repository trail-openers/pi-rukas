/**
 * The SIGTERM→SIGKILL escalation assertion for test-cancel.ts (issue #1382),
 * extracted so the parent stays inside the 500-line limit (AGENTS.md §12).
 *
 * WHY THIS SPAWN ASKS FOR A PROCESS GROUP
 * ───────────────────────────────────────
 * This is the reason the round-1/2 probes could never have failed for the
 * right reason, and the single most load-bearing fact in the file.
 *
 * `killProcessTree` (src/spawn-kill.ts) picks its grace from `isGroupChild`:
 * `KILL_GRACE_MS` (2 s) for a process-group leader, `INTERACTIVE_KILL_GRACE_MS`
 * (5 s) for a lone leader — and the lone-leader timer is `unref()`'d. A
 * `dispatchSpecialist`/probe spawn is the interactive shape (`processGroup` is
 * set only by the headless runner), so it armed the 5 s unref'd timer. Measured
 * against this very fixture: the abort resolved at ~6.5 s with the leader reaped
 * and the backgrounded `sleep` STILL ALIVE, and the process then sat in the
 * verify loop's SIGTERM grace window until the watchdog's SIGKILL ended the run.
 * An unref'd timer cannot hold a dying process alive long enough to fire, so on
 * the interactive shape the escalation is not observable *and a probe over that
 * shape cannot distinguish it from health*: deleting the escalation from
 * spawn-kill.ts left the interactive probe printing ✓ (measured, repeatedly
 * across this issue's rounds).
 *
 * With `processGroup: true` the timer is ref'd and `process.kill(-pid, …)`
 * reaches the whole tree, so deleting the escalation makes the spawn HANG and
 * the polls go RED at their derived deadline. That is the same behaviour
 * `test-headless-signal-kill.ts` pins for the group reaper; here it is pinned
 * for the escalation timer that backs it. Both shapes are real product paths —
 * this covers the one where the escalation is actually reachable.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/kill-outcome.ts` and
 * `lib/poll-until-killed.ts`); coverage comes through test-cancel.ts.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KILL_GRACE_MS, groupSpawnOpts, registerChild } from "../../src/spawn-kill.ts";
import { writeFakePi } from "./cancel-fixture.ts";
import { diedToSigkill } from "./kill-outcome.ts";
import { pollUntilGone } from "./poll-until-killed.ts";
import { ABORT_PROMPT, runAbortProbe } from "./test-cancel-probes.ts";

/** A tick, for waiting on the fixture's own pid files. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Signal a registered group child the way `killProcessTree` does, minus the
 * SIGKILL escalation — the control's simulation of the escalation having been
 * deleted. Not a re-implementation of the kill: it sends the same signals
 * `killProcessTree` sends (`process.kill(-pid, …)` for a registered group, the
 * leader handle otherwise), with the second one withheld. `registerChild` is
 * what selects the ref'd `KILL_GRACE_MS` branch, so the control child goes
 * through it and no separate policy is invented here.
 *
 * Returns whether a signal was actually DELIVERED. The control's whole verdict
 * is "these pids were still alive after the strike", and a strike that threw
 * ESRCH on both arms delivered nothing — so the caller must assert on this
 * rather than infer a working control from a quiet one (round-3 MEDIUM).
 */
function signalTreeTermOnly(child: ReturnType<typeof spawn>): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, "SIGTERM");
    return true;
  } catch {
    // Group already gone — fall through to the leader handle, as spawn-kill does.
  }
  try {
    child.kill("SIGTERM");
    return true;
  } catch {
    // Leader already reaped — nothing left to signal, so the control landed on
    // nothing and its caller must say so rather than read "still alive" as a
    // verdict.
    return false;
  }
}

/**
 * The grace the group escalation reads, times four. Derived from the constant
 * rather than a literal: shortening the grace tightens the bound and lengthening
 * it loosens it, with no edit needed here.
 *
 * Four rather than six, because this deadline is spent TWICE — the grandchild
 * and then the leader, polled separately so a hung leader cannot hide behind a
 * reaped sleep — and the pair must clear the caller's overall probe ceiling
 * together with the spawn itself. Six left ~28 s against a 30 s bound, which is
 * no headroom at all on a loaded host. Four is still double the 2 s grace the
 * escalation itself reads.
 */
const ESCALATION_DEADLINE_MS = KILL_GRACE_MS * 4;

/**
 * Assert the escalation killed a child that IGNORES SIGTERM. `assert` and
 * `bounded` are injected rather than imported so this module shares the parent's
 * single exit counter and its single probe ceiling — two files tracking
 * separate failure counts is how a suite starts reporting success.
 */
export async function assertSigtermEscalationKillsGroup(opts: {
  fakeDir: string;
  assert: (cond: boolean, msg: string) => void;
  bounded: <T>(label: string, p: Promise<T>, pidsOf?: () => number[]) => Promise<T | undefined>;
  /** The pids a fixture recorded for itself; lets the probe ceiling tell a
   *  hung child from a merely busy event loop. */
  recordedPids: (...files: string[]) => number[];
  /** The guarded single-pid reader (undefined rather than NaN on a missing or
   *  half-written pid file); the control asserts on it before signalling. */
  recordedPid: (file: string) => number | undefined;
  /** How long the fixture's sleep may run — the caller's overall bound, so an
   *  orphan cannot outlive the run that created it (see lib/cancel-fixture.ts).
   *  The control and Test 2 share the fixture and so share this value. */
  sleepMs: number;
}): Promise<void> {
  const { fakeDir, assert, bounded, recordedPids, recordedPid, sleepMs } = opts;
  // ── RED control, run FIRST.
  //
  // A ceiling that reports "the spawn never settled" is a weak RED: a hung
  // host, a wedged binary or a provider outage prints the same line, and
  // nothing in it says the escalation is what broke. So before Test 2 asserts
  // anything, this control drives the product's own kill path with the SIGKILL
  // arm withheld — which is exactly what deleting the escalation means — and
  // asserts the polls DISCRIMINATE on it: with only SIGTERM delivered, NOTHING
  // in the TERM-ignoring tree dies. Both polls must say "still alive".
  //
  // That is the same fixture Test 2 uses, and the same signal the product's
  // first strike sends (`signalChild(child, "SIGTERM", group)` →
  // `process.kill(-pid, SIGTERM)`), so the control differs from the real path
  // by one arm of one function. Note what it is NOT: it is not "TERM honoured ⇒
  // leader exits" — this fixture IGNORES SIGTERM, so a leader that survived is
  // the expected outcome, not a failure. Asserting an exit here would be
  // asserting the opposite of what the fixture does (measured: the leader and
  // the sleep both sat at state S for the whole window).
  {
    const cPidFile = join(fakeDir, "t2-control.pid");
    const cGrandFile = join(fakeDir, "t2-control.grand.pid");
    writeFakePi(fakeDir, "trap", cPidFile, cGrandFile, sleepMs);
    console.log(
      "\n[test] RED control: SIGTERM-only kill of the same fixture (SIGKILL arm withheld)...",
    );
    const child = spawn(join(fakeDir, "pi"), ["--mode", "rpc"], {
      ...groupSpawnOpts(true),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Drain both so the shell is never blocked on a full pipe it cannot fill.
    child.stdout?.resume();
    child.stderr?.resume();
    registerChild(child, true);
    // The fixture writes its pids immediately; wait for both files before the
    // control signal, so the polls below cannot read a half-written pid.
    for (let i = 0; i < 250 && !(existsSync(cPidFile) && existsSync(cGrandFile)); i++) {
      await sleep(20);
    }
    // `signalTreeTermOnly` reports whether the strike landed on anything; see
    // the assertion below for why the control cannot be trusted without it.
    const controlSignalDelivered = signalTreeTermOnly(child);
    // The guarded reader, not `Number(readFileSync(...))`: an unparseable pid
    // is `undefined`, and `process.kill(undefined)` / `pollUntilGone(NaN)` are
    // both a verdict on a process that does not exist rather than a failure to
    // name one (round-3 MEDIUM).
    const cLeader = recordedPid(cPidFile);
    const cGrand = recordedPid(cGrandFile);
    assert(
      cLeader !== undefined && cGrand !== undefined,
      `RED control's fixture recorded both its own pid and its backgrounded sleep's pid (got leader=${cLeader} sleep=${cGrand})`,
    );
    if (cLeader === undefined || cGrand === undefined) {
      // Without two nameable pids the discrimination below is unreadable, and
      // an assertion over a NaN pid would be a false pass waiting to happen.
      return;
    }
    // Half the window is enough to prove non-death and keeps the control cheap;
    // the real test's bound is the full window, and a pid alive halfway through
    // is alive at the end for a process this simple.
    const halfMs = Math.floor(ESCALATION_DEADLINE_MS / 2);
    const leaderGone = await pollUntilGone(cLeader, halfMs);
    const grandGone = await pollUntilGone(cGrand, halfMs);
    assert(
      !leaderGone.ok && !grandGone.ok,
      `RED control held: with the SIGKILL arm withheld the TERM-ignoring leader ${cLeader} and its sleep ${cGrand} were BOTH still alive after ${halfMs}ms — so Test 2's polls DO discriminate a missing escalation`,
    );
    // The control's own RED is only meaningful if it actually reached the tree:
    // a `process.kill(-pid, …)` that threw ESRCH means the control never drove
    // anything, and "both still alive" would be an observation about a tree
    // that was never signalled. `signalTreeTermOnly` reports which happened.
    assert(
      controlSignalDelivered === true,
      `RED control delivered its SIGTERM to the tree (got ${controlSignalDelivered}) — a control whose first strike never landed proves nothing about the arm it withheld`,
    );
    // Cleanup for the control only — the surviving tree is ours, not the
    // product's, so killing it here is hygiene rather than a verdict. The kill
    // is synchronous (`kill(2)`); the wait is for the PARENT to reap, because
    // an unreaped zombie still answers `pgrep`. Doing this here, and not at the
    // end of the module, is what keeps the control's own sleep out of Test 2's
    // leak diff (measured: sampling before the reap blamed two control sleeps on
    // the product).
    try {
      process.kill(-cLeader, "SIGKILL");
    } catch {
      // Group already gone.
    }
    for (const pid of [cLeader, cGrand]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone — the case in which there is nothing to clean up.
      }
    }
    for (const pid of [cLeader, cGrand]) {
      await pollUntilGone(pid, 2_000);
    }
  }

  // ── Test 2 proper: the same fixture, killed by the real abort path.
  {
    const pidFile = join(fakeDir, "t2.pid");
    const grandPidFile = join(fakeDir, "t2.grand.pid");
    writeFakePi(fakeDir, "trap", pidFile, grandPidFile, sleepMs);
    console.log("\n[test] fake child traps SIGTERM; group SIGTERM→SIGKILL escalation expected...");
    // `ProbeResult.ok` is the probe's own aggregate of `abortProbePasses`, so
    // asserting it here would only repeat what Test 1 already pins; Test 2
    // asserts the two facts Test 1 does not — the attribution and the death.
    // `abortAtMs` is left at the shared default on purpose: the escalation only
    // fires if the abort lands before the grace period, and an abort fired at
    // 0 ms would resolve before the child existed and prove nothing about it.
    const p = await bounded(
      "test 2 (escalation probe)",
      runAbortProbe(ABORT_PROMPT, 1500, undefined, true),
      () => recordedPids(pidFile, grandPidFile),
    );
    if (!p) return;
    for (const l of p.lines) console.log(l);
    // Test 2's subject is that pi-rukas ended a TERM-trapping child. It must
    // not be readable as "the child answered SIGTERM": a well-behaved fake
    // exits 0 on the first signal, and this assertion means what it says only
    // because the polls below prove the group was ended while the
    // TERM-trapping fixture guarantees nothing ends before the escalation.
    assert(
      p.killCause === "abort",
      `TERM-trapping child's kill is attributed to the abort (got killCause=${p.killCause})`,
    );
    const leaderPid = recordedPid(pidFile);
    const grandPid = recordedPid(grandPidFile);
    assert(
      leaderPid !== undefined,
      `TERM-trapping child recorded its own pid in a parseable form (${pidFile})`,
    );
    assert(
      grandPid !== undefined,
      `TERM-trapping child recorded its backgrounded sleep's pid in a parseable form (${grandPidFile})`,
    );
    if (leaderPid === undefined || grandPid === undefined) return;
    // THE DEATH EVIDENCE. The grandchild, not the leader: the leader is Node's own
    // child, so between its `exit` event and the parent's reap it is a ZOMBIE, and
    // `kill -0` cannot tell that from a live process — polling it alone goes RED on
    // healthy code. The sleep has no such third state (nobody but the leader reaps
    // it), it is reached only by the group-wide SIGKILL, and the escalation timer
    // is what must fire it. A leader that never exited leaves the sleep alive too,
    // which is exactly the hole round 2 found in the result-shape-only predicate.
    const reaped = await pollUntilGone(grandPid, ESCALATION_DEADLINE_MS);
    assert(
      diedToSigkill(p, reaped.ok),
      `TERM-trapping child was killed, not merely resolved: its group's sleep ${grandPid} was gone within the derived ${ESCALATION_DEADLINE_MS}ms deadline (=${KILL_GRACE_MS}ms group grace × ${ESCALATION_DEADLINE_MS / KILL_GRACE_MS}) after ${reaped.elapsedMs}ms, kill attributed to the abort (killCause=${p.killCause} exitCode=${p.exitCode})`,
    );
    // The leader's own death is the second half of the evidence: a group kill that
    // reached only the descendants would be a different bug, and the leader is
    // pollable here because the escalation — not an unref'd timer at process exit —
    // is what ends it. Polled separately so a hung leader cannot hide behind a
    // reaped sleep.
    const leaderGone = await pollUntilGone(leaderPid, ESCALATION_DEADLINE_MS);
    assert(
      leaderGone.ok,
      `the TERM-trapping leader itself was ended within the same derived ${ESCALATION_DEADLINE_MS}ms deadline (after ${leaderGone.elapsedMs}ms)`,
    );
    // No separate "did it leak" assertion here. The two polls above ARE the
    // leak check and the death evidence: they read the liveness of the exact
    // pids this fixture recorded for itself, which is the only identity the
    // test can assert on. A cmdline match cannot carry this verdict —
    // `pgrep -f 'sleep 300'` also matches any process whose argv merely
    // CONTAINS that text, which includes the `timeout`/`bun` wrapper running
    // this very file (measured: a before/after diff over such a set reported
    // the harness itself as orphaned sleeps on a run where nothing leaked) —
    // and nothing can be added to the child's argv to narrow it without
    // breaking `sleep`, which rejects any operand that is not a duration (see
    // `lib/cancel-fixture.ts`). A poll of a pid the test does not own would be
    // a false positive waiting to happen, so none is taken.
  }
}
