#!/usr/bin/env bun
/**
 * Verify the two escape hatches in spawnSpecialist (AbortSignal / timeoutMs)
 * plus the #296 inactivity watchdog — fully offline.
 *
 * #809 — the two REAL-spawn sections that used to live here (an abort probe
 * and a 2000ms-timeout probe against genuine `pi` children, asserting
 * `elapsed < 10s` / `elapsed < 12s`) are timing-flaky and cost two false
 * parks (cycles #777 and #798: 496954ms against a 10s bound). The wall clock
 * measured parent + child + provider round-trip under up to 6 concurrent Pi
 * processes, and on a laptop that may sleep — the 497s observation is a
 * process that was descheduled, not an abort path that is slow. They moved to
 * `test-cancel-realspawn-live.ts`, which keeps the same two spawns (token cost
 * unchanged) but asserts the SEMANTIC outcome (killCause attribution) instead
 * of elapsed seconds. It is `*-live.ts` (excluded from the offline gate) —
 * CI does not install `pi`, and a real-spawn section glob-matched into the
 * offline suite would crash there on a missing binary rather than skip.
 *
 * The abort-path semantics they covered are now ALSO exercised deterministically
 * here (tests 1–2) against a fake `pi` on PATH — the same pattern as tests
 * 3–5 — so the offline suite kills a real child via the exact `onAbort`
 * code path and checks the result, with no wall-clock bound to flake on and
 * no provider involved.
 *
 * #1382 removed the last two wall-clock assertions this file kept after that
 * move — Test 2's `elapsedMs >= 5_000` floor and Test 3's `elapsed < 15_000`
 * ceiling — and replaced them with assertions on the DEATH and the
 * ATTRIBUTION. What replaced them is bounded, in two places, and the bound is
 * the whole point of this header:
 *
 *  - **The kill is proven, not assumed.** `killCause: "abort"` +
 *    `exitCode: null` is what a SIGKILLed leader reports AND what a leader
 *    that never exited reports, because the abort resolves the spawn as soon
 *    as it fires. So Test 2 records the fake child's pids and polls them to
 *    GONE with `lib/poll-until-killed.ts`'s `pollUntilGone`, bounded at
 *    `KILL_GRACE_MS * 4` — the product constant the group escalation itself
 *    reads, times four (twice for the pair of polls; see that module). A pid
 *    still alive at that deadline is a named RED, never a hang. The poll
 *    targets the group path (`processGroup: true`) for
 *    the reason in Test 2's own comment: on the interactive (lone-leader) shape
 *    the escalation timer is `unref()`'d, can never be observed firing, and a
 *    probe over that shape cannot tell a working escalation from a deleted one.
 *  - **Every probe await is bounded.** Each `spawnSpecialist` wait is wrapped
 *    in a `Promise.race` ceiling (`PROBE_CEILING_MS`, 30 s — generous next to
 *    the 2 s group escalation and the 2 s budgets it watches, and sized so
 *    probe + both polls clear it together). A ceiling is
 *    load-tolerant: a descheduled host costs it nothing unless something is
 *    genuinely stuck. A FLOOR is neither, which is exactly what #1382 deleted
 *    (why the 5 s floor and the 15 s ceiling were worse than useless on both
 *    sides of that pair is in `lib/kill-outcome.ts`). There is no floor in
 *    this file and none in the predicates.
 *
 * The ceiling ENDS the run, it does not only report: a `Promise.race` resolves
 * but cannot cancel its loser, and on the group path the product's escalation
 * timer is ref'd by design, so a reporting-only ceiling printed its RED and then
 * sat on the pinned loop until an outside watchdog killed it — the very hang
 * this issue exists to remove (measured at 82 s under a 60 s ceiling). See
 * `bounded`.
 *
 * So a direct `bun smoke-tests/test-cancel.ts` cannot hang, with or without
 * the verify-loop watchdog behind it.
 *
 * Self-check (bottom of file): the abort probe's predicate, both outcome
 * predicates and the reaped-pid predicate are asserted against fabricated
 * results in BOTH directions — each passes the shape it is supposed to pass
 * and fails the shapes it is not, including a bare `exitCode: null` with no
 * attribution and a still-alive pid. Same shape test-file-size-limit.ts
 * applies to itself.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KILL_GRACE_MS } from "../src/spawn-kill.ts";
import { spawnSpecialist } from "../src/spawn.ts";
import type { DispatchResult } from "../src/types.ts";
import { assertSigtermEscalationKillsGroup } from "./lib/cancel-escalation.ts";
import { writeFakePi } from "./lib/cancel-fixture.ts";
import { fixturePidFiles, readRecordedPid, readRecordedPids } from "./lib/cancel-pids.ts";
import { diedToSigkill, killedByInactivityBudget } from "./lib/kill-outcome.ts";
import { pidAlive } from "./lib/poll-until-killed.ts";
import {
  ABORT_PROMPT,
  type ProbeResult,
  abortProbePasses,
  runAbortProbe,
  assert as sharedAssert,
} from "./lib/test-cancel-probes.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  sharedAssert(cond, msg);
  if (!cond) exit = 1;
}

/**
 * The ceiling on any single probe's await. A CEILING, not a floor: it only
 * fires when a child that was asked to die has not settled the spawn, and 30 s
 * is ~9× the 3.5 s the escalation probe measures on a healthy run and 15× the
 * 2 s inactivity budget it watches, so no amount of host descheduling reaches
 * it on a healthy path. Its only job is to make an unbounded wait impossible.
 *
 * It is an OVERALL bound, not a per-call one. `assertSigtermEscalationKillsGroup`
 * calls `bounded` once and then polls twice against deadlines derived from the
 * kill grace; at 12 s each those polls alone would outlast a 60 s per-call
 * ceiling and leave the run unbounded. 30 s is set so probe + both polls clear
 * it together (~3.5 s + 12 s + 12 s ≈ 28 s on this box), and the grace is
 * halved for the same reason.
 */
const PROBE_CEILING_MS = 30_000;

// ── Fixture identity: the directory and the fake `pi`'s sleep bound.
//
// Declared here, next to the ceiling that reads them, rather than further
// down: `restoreEnv` below is a function (hoisted), but the values it passes
// to `readRecordedPids` are evaluated when it RUNS — which is either the
// ceiling's exit or the `finally`, both after this point. Same reasoning as
// `fakeDir`/`savedPath`, which `restoreEnv` also reads.
const fakeDir = mkdtempSync(join(tmpdir(), "pi-ensemble-fake-pi-"));
const savedPath = process.env.PATH;
const savedInactivity = process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;

// Every sleep the fixtures can leave behind is bounded by the longest wait
// this file takes over it: the probe ceiling plus both escalation polls.
// Anything that outlives that is only still running because it was orphaned.
// See lib/cancel-fixture.ts for the derivation and the floor it is clamped to.
const ORPHAN_BOUND_MS = PROBE_CEILING_MS + 2 * KILL_GRACE_MS * 4;

/**
 * A result the caller can assert on, even when the probe itself timed out.
 * `undefined` is the failure sentinel: it means the promise never settled
 * inside `PROBE_CEILING_MS`. It is generic because the callers await two
 * different shapes — a `ProbeResult` from the probe runner and a raw
 * `DispatchResult` from `spawnSpecialist` — and the ceiling must type-check
 * against both rather than one and cast for the other.
 *
 * Caveat a caller must know: a probe's own aggregate (`ProbeResult.ok`, from
 * `abortProbePasses`) is TRUE for a correctly-killed child, so it is not a
 * failure sentinel either way — `undefined` is the only one.
 */
type Settled<T> = T | undefined;

/**
 * Env the file mutates process-wide, and the fixture directory it builds its
 * fake `pi` in. `restoreEnv()` undoes ALL of it; two call sites do. Hoisted
 * above `bounded` because the ceiling's exit calls it — `process.exit` skips
 * this file's `finally`.
 */
let restored = false;
function restoreEnv(): void {
  if (restored) return;
  restored = true;
  // Restore the process-wide env even when a probe above throws — the fake
  // `pi` on PATH and the inactivity override must not leak past this file
  // (a stub `pi` in the parent's PATH would shadow the real binary for any
  // later spawn in the same process).
  process.env.PATH = savedPath;
  process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "";
  // `undefined` rather than `delete`: biome's noDelete rejects the operator on
  // a member expression, and for `process.env` the two are the same observable
  // shape — an unset variable reads back as `undefined` either way.
  if (savedInactivity) process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = savedInactivity;
  else process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = undefined;
  // Round-3 MEDIUM: the fixtures' sleep reapers are best-effort (dash defers
  // its EXIT trap while blocked in `wait`), so a descendant can outlive its
  // leader and be reparented to init. The ceiling's `pidsOf` liveness test
  // deliberately tolerates that while the run is going; nothing else removes
  // it, and it accumulated across runs. So the final restore SIGKILLs every
  // pid any fixture recorded for itself before the directory holding those
  // pid files goes away. Measured before this: `pgrep -fa 'sleep 300'` grew
  // by 3, 7, 13 pids at ppid=1 across consecutive runs of this file.
  for (const pid of readRecordedPids(...fixturePidFiles(fakeDir))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone — the case in which there is nothing to clean up.
    }
  }
  rmSync(fakeDir, { recursive: true, force: true });
}

/**
 * Await a probe under `PROBE_CEILING_MS`, and END THE RUN only if the child is
 * genuinely still alive when that ceiling expires.
 *
 * `Promise.race` resolves but cannot cancel its loser, and on the group path the
 * product's escalation timer is REF'd by design (see `killProcessTree` — an
 * unref'd one can never be observed firing). A reporting-only ceiling therefore
 * printed its own RED and then sat on the pinned loop until an outside watchdog
 * killed it — the very hang #1382 exists to remove (measured: the break-proof
 * printed `spawn did not settle within 60000ms` at 60 s and stayed alive to
 * 82 s). So the ceiling exits the process, writing its verdict to stderr first
 * so a killed process whose output was still buffered does not look like a
 * crash. `process.exit` over `process.abort` for the same reason.
 *
 * That exit skips the file's `finally` — so it calls `restoreEnv()` itself
 * first. Without it the ceiling's exit leaked the fake `pi` into `PATH` and
 * the fixture directory for the rest of the parent process (round-3 HIGH).
 *
 * Nothing else in the file can end the run: by definition a hung probe never
 * returns, so the `exit` counter would never reach the bottom of the file.
 *
 * The liveness test is what keeps this from being a false-positive machine.
 * A settled spawn whose child is gone is HEALTHY no matter what still holds the
 * event loop — an orphaned `sleep` from a best-effort fixture reaper, a pipe the
 * loser never closed, bun's own housekeeping. Exiting on a bare ceiling expiry
 * would fail the suite for a hang that did not happen, and did exactly that
 * before the check was added (test 1 settled at 1.5 s with the kill attributed
 * and still got killed at the ceiling). `pidsOf` is injected because the pids
 * are the fixture's own, recorded by the child; the harness has no other way to
 * name them.
 */
async function bounded<T>(
  label: string,
  p: Promise<T>,
  pidsOf?: () => number[],
): Promise<Settled<T>> {
  const ceiling = new Promise<undefined>((resolve) => {
    const t = setTimeout(() => {
      const live = (pidsOf?.() ?? []).filter(
        (pid) => Number.isFinite(pid) && pid > 0 && pidAlive(pid),
      );
      if (live.length === 0) {
        // Nothing of ours is running: this is a ref'd handle, not a hung child.
        // Report it and let the run continue to its own verdict.
        console.error(
          `  (note) ${label}: spawn settled but the loop stayed busy past ${PROBE_CEILING_MS}ms`,
        );
        resolve(undefined);
        return;
      }
      console.error(
        `✗ ${label}: spawn did not settle within ${PROBE_CEILING_MS}ms and its pids ${live.join(", ")} were still alive — aborting run`,
      );
      // process.exit does not run `finally` blocks, so undo the env mutation
      // here rather than leaving a stub `pi` on PATH for the next spawn.
      restoreEnv();
      process.exit(1);
    }, PROBE_CEILING_MS);
    t.unref();
  });
  // Tagged race: each branch carries its own tag, so the branches below are
  // narrowed by discriminant rather than by an `as` cast over a union whose
  // members were indistinguishable once the race returned.
  const settled = await Promise.race([
    p.then(
      (v) => ({ kind: "value" as const, v }),
      (e: unknown) => ({ kind: "throw" as const, e }),
    ),
    ceiling,
  ]);
  if (settled === undefined) {
    assert(false, `${label}: spawn did not settle within ${PROBE_CEILING_MS}ms`);
    return undefined;
  }
  if (settled.kind === "throw") {
    assert(false, `${label}: spawn threw — ${settled.e}`);
    return undefined;
  }
  return settled.v;
}

/** Test 3's armed inactivity budget, named once so predicate and asserts agree. */
const INACTIVITY_BUDGET_MS = 2_000;

process.env.PATH = `${fakeDir}:${savedPath}`;
// #1017 — the offline gate (verify-loop.sh) exports
// PI_ENSEMBLE_FORBID_LIVE_SPAWN=1 for every offline test, and the guard fires
// before the fork, so even the fake-`pi`-on-PATH children below would fail on
// it. They cost no tokens (the `pi` on PATH is a shell script), so this test
// opts out of the guard locally — the same escape hatch the `*-live.ts`
// tests use for real children.
process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "1";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "0"; // abort tests: pure abort path

// Tests 1–2 run against the fake `pi` with the inactivity watchdog disabled —
// the whole point is that only the abort path can fire. If anything in the
// environment between the module top and here resets the watchdog to its
// 25-min default, this assertion fires immediately instead of the probe
// silently flipping killCause to 'inactivity'.
assert(
  process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS === "0",
  "env invariant: PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS === '0' for the abort tests",
);

try {
  // Test 1 — AbortSignal kills the child mid-flight (deterministic fake child).
  // Uses the same SIGTERM→SIGKILL kill function the #296 watchdog uses (the
  // subject is the attribution; the watchdog poll loop itself is tests 3–4).
  // The wall clock is logged for observability and never fails.
  {
    writeFakePi(fakeDir, "exec", join(fakeDir, "t1.pid"), undefined, ORPHAN_BOUND_MS);
    console.log("[test] fake child, abort after 1500ms...");
    const p = await bounded("test 1 (abort probe)", runAbortProbe(ABORT_PROMPT), () =>
      readRecordedPids(join(fakeDir, "t1.pid")),
    );
    if (p) {
      for (const l of p.lines) console.log(l);
      // Test 1's subject is the ATTRIBUTION of a child-killing signal: the
      // killCause the spawn reports, and the CHILD's `ok`, which the kill
      // contract forces false (spawn.ts sets `ok = false` whenever a killCause
      // exists). `p.ok` is deliberately not asserted here: it is the probe's
      // own aggregate of `abortProbePasses`, so it is TRUE for a correctly
      // killed child, and quoting it next to "ok=false" read as a
      // contradiction (the #1382 round-2 finding). `ProbeResult.childOk` now
      // carries the child's value under a name that cannot be confused, and
      // `abortProbePasses` is exercised in both directions by the self-check.
      assert(p.killCause === "abort", `aborted fake child: killCause='abort' (got ${p.killCause})`);
      assert(p.childOk === false, `...and the killed child reports ok=false (got ${p.childOk})`);
    }
  }
  writeFakePi(
    fakeDir,
    "trap",
    join(fakeDir, "t2.pid"),
    join(fakeDir, "t2.grand.pid"),
    ORPHAN_BOUND_MS,
  );
  await assertSigtermEscalationKillsGroup({
    fakeDir,
    assert,
    bounded,
    recordedPids: readRecordedPids,
    recordedPid: readRecordedPid,
    sleepMs: ORPHAN_BOUND_MS,
  });

  // Test 3 — a totally silent child is killed by the inactivity watchdog.
  {
    writeFakePi(fakeDir, "exec", join(fakeDir, "t3.pid"), undefined, ORPHAN_BOUND_MS);
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = String(INACTIVITY_BUDGET_MS);
    console.log(`\n[test] silent fake child, ${INACTIVITY_BUDGET_MS}ms inactivity budget...`);
    const r = await bounded(
      "test 3 (inactivity probe)",
      spawnSpecialist({ role: "explore", prompt: "irrelevant" }, { timeoutMs: 60_000 }),
    );
    // #1382 — `assert(elapsed < 15_000)` against a 2000 ms budget was the
    // load-fragile one: 7.5× headroom is still a bound on the HOST (bun
    // startup + descheduling), not on the watchdog, and on the box that
    // started #1365 a healthy 2000 ms kill was measured 15 s+ away. What
    // proves the watchdog fired is its own attribution — killCause and the
    // budget it recorded — never how long the parent waited to notice. The
    // three facts are asserted individually so a failure names the missing
    // one; the composite predicate in the self-check below keeps its own
    // conjunction honest.
    assert(
      r?.killCause === "inactivity",
      `#296: silent child carries killCause='inactivity' (got ${r?.killCause})`,
    );
    assert(
      r?.killBudgetMs === INACTIVITY_BUDGET_MS,
      `#296: inactivity killBudgetMs records the armed ${INACTIVITY_BUDGET_MS}ms budget (got ${r?.killBudgetMs})`,
    );
    assert(r?.ok === false, `#296: inactivity-killed child reports ok=false (got ${r?.ok})`);
  }

  // Test 4 — a child that keeps streaming stdout OUTLIVES the inactivity
  // window unharmed (any output resets the watchdog; only true silence kills).
  {
    writeFileSync(
      join(fakeDir, "pi"),
      [
        "#!/bin/sh",
        "i=0",
        'while [ $i -lt 10 ]; do echo "noise $i"; i=$((i+1)); sleep 0.5; done',
        `echo '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"survived"}]}]}'`,
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(fakeDir, "pi"), 0o755);
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = String(INACTIVITY_BUDGET_MS);
    console.log(
      `\n[test] streaming fake child (5s of 500ms-spaced output, ${INACTIVITY_BUDGET_MS}ms budget)...`,
    );
    const r = await bounded(
      "test 4 (streaming probe)",
      spawnSpecialist({ role: "explore", prompt: "irrelevant" }, { timeoutMs: 60_000 }),
    );
    assert(r?.killCause === undefined, "#296: streaming child is NOT killed by the watchdog");
    assert(r?.exitCode === 0 && r?.ok === true, "#296: streaming child completes cleanly");
    assert(r?.text.includes("survived") === true, "#296: streaming child's final text survives");
  }

  // Test 5 (#296) — wall-clock cap kill carries killCause='timeout' + budget.
  // Deterministic: silent fake child, inactivity watchdog disabled.
  {
    writeFakePi(fakeDir, "exec", join(fakeDir, "t5.pid"), undefined, ORPHAN_BOUND_MS);
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "0";
    console.log("\n[test] silent fake child, 1500ms wall-clock cap, watchdog off...");
    const r = await bounded(
      "test 5 (timeout probe)",
      spawnSpecialist({ role: "explore", prompt: "irrelevant" }, { timeoutMs: 1500 }),
    );
    assert(r?.ok === false, "#296: cap-killed child reports ok=false");
    assert(r?.killCause === "timeout", "#296: cap-killed child carries killCause='timeout'");
    assert(r?.killBudgetMs === 1500, "#296: killBudgetMs records the expired wall-clock budget");
  }

  // Self-check — every predicate this file asserts on must discriminate in
  // BOTH directions: the shape it exists to accept passes, and each broken-
  // path shape fails. Same shape test-file-size-limit.ts applies to itself: a
  // test that cannot go RED is decorative. #1382 extends it to the outcome
  // predicates that replaced the wall-clock bounds — without these,
  // `diedToSigkill` could degrade into `return true` and Tests 2/3 would go
  // silently green.
  {
    const fabricated = (killCause: DispatchResult["killCause"], ok: boolean) =>
      abortProbePasses({ ok, killCause });
    assert(
      fabricated("abort", false) === true,
      "self-check: attributed abort (killCause + ok=false) passes",
    );
    assert(fabricated(undefined, false) === false, "self-check: missing killCause fails");
    assert(fabricated("timeout", false) === false, "self-check: wrong cause fails");
    assert(fabricated("abort", true) === false, "self-check: ok=true abort fails");

    // diedToSigkill: the abort attribution AND a reaped pid are both required.
    // The reaped flag is what the OS poll said, so it is the part that can
    // distinguish a SIGKILLed leader from one that never exited at all —
    // therefore a still-alive pid fails even with the perfect-looking result,
    // which is the exact hole round 2 found. The fabricated rows carry only
    // `killCause`, which is the whole of the predicate's input type: an
    // `exitCode` here is a compile error, which is the point of narrowing the
    // parameter to `Pick<DispatchResult, "killCause">` (round-3 MEDIUM) — the
    // predicate never read it, and rows that named it implied it did.
    assert(
      diedToSigkill({ killCause: "abort" }, true) === true,
      "self-check: reaped leader + abort attribution passes (the shape Test 2 measures)",
    );
    assert(
      diedToSigkill({ killCause: "abort" }, false) === false,
      "self-check: leader still alive at the deadline fails, even with the abort attribution",
    );
    assert(
      diedToSigkill({ killCause: undefined }, true) === false,
      "self-check: reaped but unattributed fails (an unrelated death is not this kill path)",
    );
    assert(
      diedToSigkill({ killCause: "inactivity" }, true) === false,
      "self-check: a reaped death attributed elsewhere fails",
    );
    assert(
      diedToSigkill({ killCause: "timeout" }, true) === false,
      "self-check: a reaped death attributed to the wall-clock cap is not the abort escalation",
    );

    // killedByInactivityBudget: the watchdog's own attribution passes; every
    // way it can be wrong (cause missing, another cause, the wrong budget
    // recorded, ok left true) fails.
    const inactivity = (
      killCause: DispatchResult["killCause"],
      killBudgetMs: number | undefined,
      ok: boolean,
    ) => killedByInactivityBudget({ ok, killCause, killBudgetMs }, INACTIVITY_BUDGET_MS);
    assert(
      inactivity("inactivity", INACTIVITY_BUDGET_MS, false) === true,
      "self-check: inactivity kill passes",
    );
    assert(
      inactivity(undefined, INACTIVITY_BUDGET_MS, false) === false,
      "self-check: missing cause fails",
    );
    assert(
      inactivity("timeout", INACTIVITY_BUDGET_MS, false) === false,
      "self-check: wrong cause fails",
    );
    assert(
      inactivity("abort", INACTIVITY_BUDGET_MS, false) === false,
      "self-check: abort cause fails",
    );
    assert(
      inactivity("inactivity", INACTIVITY_BUDGET_MS + 1, false) === false,
      "self-check: wrong budget fails",
    );
    assert(
      inactivity("inactivity", undefined, false) === false,
      "self-check: missing budget fails",
    );
    assert(
      inactivity("inactivity", INACTIVITY_BUDGET_MS, true) === false,
      "self-check: ok=true inactivity kill fails",
    );
  }
} finally {
  restoreEnv();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
