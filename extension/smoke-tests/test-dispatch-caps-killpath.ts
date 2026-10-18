#!/usr/bin/env bun
/**
 * #1510 — the cap-kill crash-path cases, split out of
 * `test-dispatch-caps-timing.ts` to keep both files under the 500-line hard
 * limit (AGENTS.md §12). No assertion was weakened in the split; the H1,
 * chatty-child, H2-inertness and spawn#6 blocks stay in the timing file.
 *
 * The token-budget kill path called `killChild` with NO try/catch while its
 * sibling loop kill (`loops()`) had one. The tracker invokes the injected kill
 * from BOTH of its paths — `poll()` (grace > 0, inside the session's 500 ms
 * `setInterval`) and `check()` (grace == 0, synchronously on the message_end
 * path). A throw escaping `poll()` is an uncaught exception at timer level: it
 * aborts the parent and takes down every sibling child still in flight.
 *
 * Parent survival is witnessed by the `uncaughtException` /
 * `unhandledRejection` counters in this process (pattern from
 * `test-steer-epipe.ts`). A live host Pi run is NOT the witness: the host
 * installs its own `uncaughtCrash` handler that calls `process.exit(1)`, so a
 * setTimeout-still-fires assertion would fail for the wrong reason even after a
 * correct fix.
 */

import { capKillAttribution, createCapSession } from "../src/spawn-caps.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
let uncaught = 0;
let unhandled = 0;
const onUncaught = () => {
  uncaught += 1;
};
const onUnhandled = () => {
  unhandled += 1;
};
process.on("uncaughtException", onUncaught);
process.on("unhandledRejection", onUnhandled);

function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) assert(true, msg);
  else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

const withEnvAsync = async <T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> => {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

/**
 * POSITIVE CONTROL, in a child process: an unguarded throwing kill reached from
 * a `setInterval` KILLS its process.
 *
 * Without this, "the counter above stayed at zero" is indistinguishable from
 * "the kill never reached the throw". The probe reproduces the call shape a
 * timer callback makes — `child.kill()` on a handle whose `kill` throws — with
 * NO listener installed, and must exit non-zero. It runs in a separate process
 * precisely because this file installs the listener above, which makes the
 * fatal path unobservable here.
 */
async function unguardedKillCrashes(): Promise<{ died: boolean; detail: string }> {
  const probe = [
    "const child = { pid: 4242, once: () => {}, kill: () => { throw new Error('injected kill failure'); } };",
    "function killChild(c) { c.kill('SIGTERM'); }",
    "const id = setInterval(() => { killChild(child); }, 20);",
    "id.unref();",
    "setTimeout(() => { process.stdout.write('SURVIVED'); process.exit(0); }, 500);",
  ].join("\n");
  const proc = Bun.spawn(["bun", "-e", probe], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const code = await proc.exited;
  const out = proc.stdout ? await new Response(proc.stdout).text() : "";
  return { died: code !== 0, detail: `exit=${code} stdout=${JSON.stringify(out.slice(0, 40))}` };
}

/**
 * A child handle whose `kill` THROWS, plus the witness that the kill was
 * actually attempted.
 *
 * Why THIS shape and not ESRCH-through-`kill`, established by measurement
 * before it was written: `killProcessTree` was handed (a) a handle whose `kill`
 * throws, (b) a Proxy whose `kill` *property read* throws, and (c) a live
 * detached child whose process group was already reaped — and none escaped it,
 * with or without an `uncaughtException` listener, because `signalChild` wraps
 * `child.kill()` and `signalGroupPid` wraps `process.kill(-pid)` in their own
 * try/catch. A test built on an ESRCH-shaped double therefore passes on the
 * unfixed shape and witnesses nothing — which is exactly what the first draft
 * of these blocks did. A handle without a usable `kill` is the reachable shape
 * that still reaches `budgetKill` / `loops()` uncaught, which is what the catch
 * added here has to hold. spawn-kill.ts stays out of scope.
 *
 * `once` is stubbed because `registerChild` touches the handle.
 *
 * `kills()` is the anti-vacuity witness. `createCapSession` builds a
 * `TokenBudgetTracker` only when `capsOn && opts.onSteer`, and both `check()`
 * and `poll()` return early while `budget <= 0` — so a block that forgot
 * `PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER`, or ran with the loop detector off
 * (role `ops`, or `PI_ENSEMBLE_DISPATCH_CAPS=0`), armed NOTHING, never reached
 * the kill, and passed on the unfixed shape while looking like a regression
 * test. `kills() > 0` fails when the kill site was never reached.
 */
function throwingChild(label: string): { child: never; kills: () => number } {
  let calls = 0;
  const child = {
    pid: 4242,
    once: () => {},
    kill: (): boolean => {
      calls += 1;
      throw new Error(`child.kill unavailable (${label})`);
    },
  } as never;
  return { child, kills: () => calls };
}

const emptyResult = (role: string): DispatchResult => ({
  role,
  ok: true,
  text: "",
  toolUses: [],
  ms: 10,
  exitCode: 0,
});

const CAP_BASE = {
  timedOut: () => false,
  inactivityKilled: () => false,
  toolInactivityKilled: () => false,
  aborted: () => false,
  childExited: () => false,
};

// (0) positive control — see `unguardedKillCrashes`.
{
  const ctl = await unguardedKillCrashes();
  assert(
    ctl.died,
    `#1510 control: an UNGUARDED throwing kill from a setInterval kills its process (${ctl.detail}) — proves the counter below can detect a regression`,
  );
}

// (a) grace > 0 — the kill fires from `poll()` inside the session's setInterval.
// ATTRIBUTION MUST SURVIVE: `poll()` sets `killed = true` BEFORE calling
// `kill()`, so swallowing the throw must not swallow the diagnosis.
// `result.tokenBudget` is asserted NOWHERE in the offline suite today, so that
// is NEW coverage, not a regression net.
{
  const { child: thrower, kills } = throwingChild("#1510 grace>0");
  await withEnvAsync(
    { PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "100", PI_ENSEMBLE_CAP_KILL_GRACE_MS: "400" },
    async () => {
      let threw = false;
      try {
        const session = createCapSession({
          ...CAP_BASE,
          role: "developer",
          child: thrower,
          onSteer: () => {},
          totalTokens: () => 100_000, // far over the 100-token budget
          capKillGraceMs: 400,
        });
        const tracker = session.tokenBudgetTracker;
        assert(!!tracker, "#1510(a): token-budget tracker exists (caps on, role not ops)");
        assert(
          tracker?.budgetTokens === 100,
          `#1510(a): tracker armed with the 100-token cap this block sets (got ${tracker?.budgetTokens}) — a leaked PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER makes the kill below vacuous`,
        );
        tracker?.check(Date.now());
        await new Promise((r) => setTimeout(r, 800)); // let the 500 ms poll land
        assert(
          kills() > 0,
          `#1510(a): the kill site was REACHED (${kills()} child.kill attempts) — a block that never reached it would pass on the unfixed shape`,
        );
        assert(true, "#1510(a): throwing kill under grace>0 raised nothing at timer level");
        assert(tracker?.killed === true, "#1510(a): tracker still marks the budget kill");
        assert(
          session.killCause() === "token-budget",
          `#1510(a): killCause survives the swallowed throw (got ${session.killCause()})`,
        );
        const result = emptyResult("developer");
        capKillAttribution(session, { role: "developer" }, 100_000, () => {}, result);
        eq(
          result.tokenBudget,
          { budget: 100, used: 100_000 },
          "#1510(a): capKillAttribution still writes the budget/used pair (NEW coverage — asserted nowhere before #1510)",
        );
        session.cleanup();
        assert(true, "#1510(a): cleanup() runs after the throwing kill (both timers cleared)");
      } catch {
        threw = true;
      }
      assert(!threw, "#1510(a): no throw escaped the grace>0 budget kill to the caller");
    },
  );
}

// (b) grace == 0 — the kill fires synchronously from `check()`, no timer
// involved: the branch the brief requires to be covered, which the guard on the
// injected closure covers without either branch needing its own catch.
{
  const { child: thrower, kills } = throwingChild("#1510 grace==0");
  await withEnvAsync(
    { PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "100", PI_ENSEMBLE_CAP_KILL_GRACE_MS: "0" },
    async () => {
      let threw = false;
      try {
        const session = createCapSession({
          ...CAP_BASE,
          role: "developer",
          child: thrower,
          onSteer: () => {},
          totalTokens: () => 100_000,
          capKillGraceMs: 0,
        });
        const tracker = session.tokenBudgetTracker;
        assert(!!tracker, "#1510(b): token-budget tracker exists (caps on, role not ops)");
        assert(
          tracker?.budgetTokens === 100,
          `#1510(b): tracker armed with the 100-token cap this block sets (got ${tracker?.budgetTokens})`,
        );
        tracker?.check(Date.now());
        assert(
          kills() > 0,
          `#1510(b): the kill site was REACHED (${kills()} child.kill attempts) — without the budget env this block armed nothing and passed vacuously`,
        );
        assert(true, "#1510(b): throwing kill at grace==0 raised nothing on the sync path");
        assert(tracker?.killed === true, "#1510(b): tracker still marks the budget kill");
        assert(
          session.killCause() === "token-budget",
          `#1510(b): killCause survives the swallowed throw (got ${session.killCause()})`,
        );
        const result = emptyResult("developer");
        capKillAttribution(session, { role: "developer" }, 100_000, () => {}, result);
        eq(
          result.tokenBudget,
          { budget: 100, used: 100_000 },
          "#1510(b): attribution survives the synchronous kill path too",
        );
        session.cleanup();
        assert(true, "#1510(b): cleanup() runs after the throwing kill");
      } catch {
        threw = true;
      }
      assert(!threw, "#1510(b): no throw escaped the grace==0 budget kill to the caller");
    },
  );
}

// (c) THE PAIRED LOOP-KILL CASE — `loops()` already carries the try/catch and
// NEITHER catch was exercised by any existing test: no offline block had ever
// fed a child whose `kill` throws. Without this pair a regression that deletes
// the loop catch passes the suite, and the asymmetry #1510 fixes silently
// returns on the other side.
async function loopKillThrows(label: string, graceMs: number): Promise<void> {
  const { child: thrower, kills } = throwingChild(label);
  let threw = false;
  try {
    const session = createCapSession({
      ...CAP_BASE,
      role: "developer",
      child: thrower,
      onSteer: () => {},
      totalTokens: () => 0,
      capKillGraceMs: graceMs,
    });
    // biome-ignore lint/style/noNonNullAssertion: caps are on by default in this test scope
    const observe = session.loopObserver!;
    for (let turn = 0; turn < 10; turn++) {
      observe(
        [{ type: "toolCall", id: "x", name: "bash", arguments: '{"command":"git log --oneline"}' }],
        turn,
      );
    }
    if (graceMs > 0) await new Promise((r) => setTimeout(r, 800));
    assert(kills() > 0, `${label}: the loop kill site was REACHED (${kills()} attempts)`);
    assert(
      true,
      `${label}: throwing loop kill raised nothing on the ${graceMs > 0 ? "timer" : "sync"} path`,
    );
    assert(session.loopKilled() === true, `${label}: loop kill still recorded`);
    assert(
      session.killCause() === "loop",
      `${label}: killCause survives the swallowed throw (got ${session.killCause()})`,
    );
    session.cleanup();
    assert(true, `${label}: cleanup() runs after the throwing loop kill`);
  } catch {
    threw = true;
  }
  assert(!threw, `${label}: no throw escaped the loop kill to the caller`);
}

await loopKillThrows("#1510(c) loop grace>0", 400);
await loopKillThrows("#1510(d) loop grace==0", 0);

console.log(`\nexit ${exit}`);
process.removeListener("uncaughtException", onUncaught);
process.removeListener("unhandledRejection", onUnhandled);
assert(
  uncaught === 0 && unhandled === 0,
  `#1510: no uncaughtException / unhandledRejection escaped any kill path in this file (got ${uncaught}/${unhandled})`,
);
if (uncaught !== 0 || unhandled !== 0) exit = 1;
console.log(`\nexit ${exit}`);
process.exit(exit);
