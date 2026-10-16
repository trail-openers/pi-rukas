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
 * ceiling — and replaced them with outcome assertions (`diedToSigkill` and
 * `killedByInactivityBudget`) evaluated directly on the settled result. There
 * is no poll and no clock in this file: each caller awaits the spawn, so a
 * genuinely hung child is already bounded by the spawn's own `timeoutMs` and
 * by the verify-loop watchdog. The rationale for why an absolute bound is
 * worse than useless on both sides of that pair is in `lib/kill-outcome.ts`.
 *
 * Self-check (bottom of file): the abort probe's predicate AND both outcome
 * predicates are asserted against fabricated results in BOTH directions —
 * each passes the shape it is supposed to pass and fails the shapes it is
 * not, including a bare `exitCode: null` with no attribution — so this test
 * goes RED when a broken kill path would stop attributing. Same shape
 * test-file-size-limit.ts applies to itself.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSpecialist } from "../src/spawn.ts";
import type { DispatchResult } from "../src/types.ts";
import { diedToSigkill, killedByInactivityBudget } from "./lib/kill-outcome.ts";
import {
  ABORT_PROMPT,
  abortProbePasses,
  runAbortProbe,
  assert as sharedAssert,
} from "./lib/test-cancel-probes.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  sharedAssert(cond, msg);
  if (!cond) exit = 1;
}

const fakeDir = mkdtempSync(join(tmpdir(), "pi-ensemble-fake-pi-"));
const savedPath = process.env.PATH;
const savedInactivity = process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;

/** A fake `pi` that stays alive until killed (TERM-trapping variant included). */
function writeFakePi(trapTerm = false) {
  writeFileSync(
    join(fakeDir, "pi"),
    ["#!/bin/sh", trapTerm ? "trap '' TERM" : "true", "exec sleep 300"].join("\n"),
  );
  chmodSync(join(fakeDir, "pi"), 0o755);
}

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
    writeFakePi();
    console.log("[test] fake child, abort after 1500ms...");
    const p = await runAbortProbe(ABORT_PROMPT);
    for (const l of p.lines) console.log(l);
    assert(
      p.ok,
      `aborted fake child: killCause='abort' + ok=false (got killCause=${p.killCause} ok=${p.ok})`,
    );
  }

  // Test 2 — the SIGTERM→SIGKILL escalation: a child that IGNORES SIGTERM is
  // still killed by the SIGKILL timer (spawn-kill.ts INTERACTIVE_KILL_GRACE_MS). This was previously uncovered — the
  // real-spawn sections could not demonstrate it, because a healthy real child
  // exits on SIGTERM before the escalation ever matters.
  //
  // #1382 — this used to prove the escalation by asserting
  // `p.elapsedMs >= 5_000`. That bound proved nothing about the product at
  // either end: a saturated host clears 5 s easily, so it never fails for the
  // right reason, and if the escalation were ever SHORTENED below the grace
  // period the fake child would exit on SIGTERM and the floor would still
  // pass while the SIGKILL path went unexercised. It is replaced by an
  // assertion on the death itself: the child died to SIGKILL and the kill was
  // attributed to the abort (`diedToSigkill`). The ~5 s the fake child now
  // costs is the price of covering the escalation; INTERACTIVE_KILL_GRACE_MS
  // is a hardcoded export with no env override and product code is out of
  // scope here.
  {
    writeFakePi(true);
    console.log("\n[test] fake child traps SIGTERM; SIGKILL escalation expected...");
    const p = await runAbortProbe(ABORT_PROMPT);
    for (const l of p.lines) console.log(l);
    // `p.ok` is the probe's own aggregate of `abortProbePasses`, so asserting
    // it again after `diedToSigkill` duplicates the ok=false + abort facts.
    // Keep it in Test 1 (where it is the only assertion) and let Test 2 assert
    // the two things Test 1 does not: the death shape and its attribution.
    assert(
      diedToSigkill(p),
      `TERM-trapping child died to SIGKILL via the abort (got killCause=${p.killCause} exitCode=${p.exitCode})`,
    );
  }

  // Test 3 — a totally silent child is killed by the inactivity watchdog long
  // before the wall-clock cap.
  {
    writeFileSync(join(fakeDir, "pi"), "#!/bin/sh\nexec sleep 300\n");
    chmodSync(join(fakeDir, "pi"), 0o755);
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
    console.log("\n[test] silent fake child, 2000ms inactivity budget...");
    const r = await spawnSpecialist(
      { role: "explore", prompt: "irrelevant" },
      { timeoutMs: 60_000 },
    );
    // #1382 — `assert(elapsed < 15_000)` against a 2000 ms budget was the
    // load-fragile one: 7.5× headroom is still a bound on the HOST (bun
    // startup + descheduling), not on the watchdog, and on the box that
    // started #1365 a healthy 2000 ms kill was measured 15 s+ away. What
    // proves the watchdog fired is its own attribution — killCause and the
    // budget it recorded — never how long the parent waited to notice. The
    // granular assertions below are the per-fact evidence; the composite
    // predicate is their conjunction, asserted once so a regression that
    // breaks any single fact also fails the predicate's own self-check below.
    assert(
      killedByInactivityBudget(r, 2000),
      `#296: silent child killed by the inactivity watchdog on the armed budget (got killCause=${r.killCause} killBudgetMs=${r.killBudgetMs} ok=${r.ok})`,
    );
    assert(
      r.killCause === "inactivity",
      `#296: silent child carries killCause='inactivity' (got ${r.killCause})`,
    );
    assert(
      r.killBudgetMs === 2000,
      `#296: inactivity killBudgetMs records the armed 2000ms budget (got ${r.killBudgetMs})`,
    );
    assert(
      r.ok === false,
      `#296: inactivity-killed child reports ok=false (got killCause=${r.killCause} ok=${r.ok})`,
    );
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
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
    console.log("\n[test] streaming fake child (5s of 500ms-spaced output, 2000ms budget)...");
    const r = await spawnSpecialist(
      { role: "explore", prompt: "irrelevant" },
      { timeoutMs: 60_000 },
    );
    assert(r.killCause === undefined, "#296: streaming child is NOT killed by the watchdog");
    assert(r.exitCode === 0 && r.ok === true, "#296: streaming child completes cleanly");
    assert(r.text.includes("survived"), "#296: streaming child's final text survives");
  }

  // Test 5 (#296) — wall-clock cap kill carries killCause='timeout' + budget.
  // Deterministic: silent fake child, inactivity watchdog disabled.
  {
    writeFileSync(join(fakeDir, "pi"), "#!/bin/sh\nexec sleep 300\n");
    chmodSync(join(fakeDir, "pi"), 0o755);
    process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "0";
    console.log("\n[test] silent fake child, 1500ms wall-clock cap, watchdog off...");
    const r = await spawnSpecialist({ role: "explore", prompt: "irrelevant" }, { timeoutMs: 1500 });
    assert(r.ok === false, "#296: cap-killed child reports ok=false");
    assert(r.killCause === "timeout", "#296: cap-killed child carries killCause='timeout'");
    assert(r.killBudgetMs === 1500, "#296: killBudgetMs records the expired wall-clock budget");
  }

  // Self-check — every predicate this file asserts on must discriminate in
  // BOTH directions: the shape it exists to accept passes, and each broken-
  // path shape fails. Same shape test-file-size-limit.ts applies to itself: a
  // test that cannot go RED is decorative. #1382 extends it to the two outcome
  // predicates that replaced the wall-clock bounds — without these,
  // `diedToSigkill` could degrade into `return true` and Tests 2/3 would go
  // silently green.
  {
    const fabricated = (killCause: DispatchResult["killCause"], ok: boolean) =>
      abortProbePasses({ ok, lines: [], killCause, exitCode: null, elapsedMs: 0 });
    assert(
      fabricated("abort", false) === true,
      "self-check: attributed abort (killCause + ok=false) passes",
    );
    assert(fabricated(undefined, false) === false, "self-check: missing killCause fails");
    assert(fabricated("timeout", false) === false, "self-check: wrong cause fails");
    assert(fabricated("abort", true) === false, "self-check: ok=true abort fails");

    // diedToSigkill: a SIGKILL death attributed to the abort passes — in each
    // of the three exit encodings (-9, shell-forwarded 137, and the null the
    // TERM-trapping fake actually reports). Everything the escalation did NOT
    // cause fails: a child that exits 0 answered SIGTERM, a SIGTERM death is
    // the well-behaved exit, and an unattributed death says nothing about
    // this kill path.
    assert(
      diedToSigkill({ exitCode: -9, killCause: "abort" }) === true,
      "self-check: SIGKILL death (-9) + abort passes",
    );
    assert(
      diedToSigkill({ exitCode: 137, killCause: "abort" }) === true,
      "self-check: shell-forwarded 137 + abort passes",
    );
    assert(
      diedToSigkill({ exitCode: null, killCause: "abort" }) === true,
      "self-check: exit=null + abort passes (measured shape of the TERM-trapping death)",
    );
    assert(
      diedToSigkill({ exitCode: 0, killCause: "abort" }) === false,
      "self-check: clean SIGTERM exit fails",
    );
    assert(
      diedToSigkill({ exitCode: 1, killCause: "abort" }) === false,
      "self-check: plain failure exit fails",
    );
    assert(
      diedToSigkill({ exitCode: -15, killCause: "abort" }) === false,
      "self-check: a SIGTERM death fails",
    );
    assert(
      diedToSigkill({ exitCode: null, killCause: undefined }) === false,
      "self-check: exit=null with no killCause fails (null alone is not a SIGKILL)",
    );
    assert(
      diedToSigkill({ exitCode: -9, killCause: "inactivity" }) === false,
      "self-check: SIGKILL-shaped death attributed elsewhere fails",
    );

    // killedByInactivityBudget: the watchdog's own attribution passes; every
    // way it can be wrong (cause missing, another cause, the wrong budget
    // recorded, ok left true) fails.
    const inactivity = (
      killCause: DispatchResult["killCause"],
      killBudgetMs: number | undefined,
      ok: boolean,
    ) => killedByInactivityBudget({ ok, killCause, killBudgetMs }, 2000);
    assert(inactivity("inactivity", 2000, false) === true, "self-check: inactivity kill passes");
    assert(inactivity(undefined, 2000, false) === false, "self-check: missing cause fails");
    assert(inactivity("timeout", 2000, false) === false, "self-check: wrong cause fails");
    assert(inactivity("abort", 2000, false) === false, "self-check: abort cause fails");
    assert(inactivity("inactivity", 1500, false) === false, "self-check: wrong budget fails");
    assert(
      inactivity("inactivity", undefined, false) === false,
      "self-check: missing budget fails",
    );
    assert(
      inactivity("inactivity", 2000, true) === false,
      "self-check: ok=true inactivity kill fails",
    );
  }
} finally {
  // Restore the process-wide env even when a probe above throws — the fake
  // `pi` on PATH and the inactivity override must not leak past this file
  // (a stub `pi` in the parent's PATH would shadow the real binary for any
  // later spawn in the same process).
  process.env.PATH = savedPath;
  process.env.PI_ENSEMBLE_ALLOW_LIVE_SPAWN = "";
  if (savedInactivity) process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = savedInactivity;
  else delete process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS;
  rmSync(fakeDir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
