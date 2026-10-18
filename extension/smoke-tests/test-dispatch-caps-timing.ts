#!/usr/bin/env bun
/**
 * #543 — `createCapSession` cap-kill TIMING / race cases.
 *
 * Split out of the original single-file suite together with
 * `test-dispatch-caps-budget.ts` (the pure arithmetic + env-reader +
 * killCause-priority seam) to keep both files under the 500-line hard limit
 * (AGENTS.md §12). No assertion was weakened or dropped in the split.
 *
 * What stays here is everything that needs a live cap session and a real
 * clock: the H1 grace-window race, the chatty-child absolute-grace kill, the
 * H2 master-switch inertness, and the spawn#6 distinct-fingerprint reset.
 */

import type { PiContentBlock } from "../src/pi-event-shapes.ts";
import { createCapSession } from "../src/spawn-caps.ts";

let exit = 0;
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
  if (a === e) {
    assert(true, msg);
  } else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

// Per-block env isolation. `withEnv` is duplicated from
// `test-dispatch-caps-budget.ts` rather than lifted into a `lib/` module — a
// new shared file is out of scope here. The raw `delete process.env.X` in
// `finally` it replaces was wrong twice: it destroyed a value inherited from
// the operator/CI environment instead of restoring it, and it ran per key
// against a single file-load snapshot in the earlier version, so a block that
// restored a key another block had armed would silently disarm that block's
// cap mid-run. Each block now names ONLY the keys it sets, and the restore is
// in an unconditional `finally`, so a throwing `assert` can no longer leak a
// cap env var into the next block (where an inertness assertion would read a
// real kill).
const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// Same helper, awaitable. `withEnv` above is the sync shape the budget file
// uses; these four blocks are async, and a `finally` inside an async callback
// runs when the CALLBACK settles, not when the caller's try does — which is
// what makes the restore land before the next block starts.
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

// ---------------------------------------------------------------------------
// #543 H1 — grace-window kill race: the child exits on its own between the
// poll's grace check and killChild. The kill is a no-op on a dead process,
// but without the exited guard loopKilled / the tracker's killed flag would
// flip and mark a normally-completed child as a cap failure.
// ---------------------------------------------------------------------------
{
  const killedSigs: string[] = [];
  const child = { killed: killedSigs, kill: (sig: string) => killedSigs.push(sig) } as never;
  let exited = false;
  // The tracker reads `tokenBudgetFor(role)` IN ITS CONSTRUCTOR, so the
  // session must be built INSIDE the env scope — building it outside and
  // arming the budget afterwards latched budget=0, and `check()` returns
  // early on `budget <= 0`. Every H1 assertion then passed on a tracker that
  // was never armed at all: the three assertions below were vacuous, and an
  // operator/CI env carrying PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER made that
  // worse (budget latched from the leaked value instead of 100, so the
  // 1_000_000-token stream never crossed it either). Construction now
  // mirrors the chatty-child block, and the budget assertion right below
  // makes a leaked operator value fail LOUDLY rather than silently — a gate
  // never observed to fail is worthless (AGENTS.md §1).
  await withEnvAsync({ PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "100" }, async () => {
    const session = createCapSession({
      role: "developer",
      child,
      onSteer: () => {},
      totalTokens: () => 1_000_000, // over budget — check() will trigger
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 600,
      childExited: () => exited,
    });
    assert(
      session.tokenBudgetTracker?.budgetTokens === 100,
      `H1: tracker armed with the 100-token cap this block sets (got ${session.tokenBudgetTracker?.budgetTokens}) — an operator/CI PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER makes the three assertions below vacuous`,
    );
    // The tracker triggers at the first message_end (1_000_000 >= 100).
    session.tokenBudgetTracker?.check(Date.now());
    // The child exits on its own BEFORE the grace window elapses.
    exited = true;
    // Wait for the 500ms poll to fire.
    await new Promise((r) => setTimeout(r, 700));
    assert(
      !session.tokenBudgetTracker?.killed,
      "H1: child self-exited before grace → tracker NOT killed",
    );
    eq(child.killed, [], "H1: no kill signal sent to a self-exiting child");
    assert(session.killCause() === undefined, "H1: killCause stays undefined (ok=true semantics)");
    session.cleanup();
  });
}

// ---------------------------------------------------------------------------
// The token-budget grace window is ABSOLUTE — new assistant turns must not
// defer the kill.
//
// The shipped shape reset the grace clock from `lastMessageEndAt`, and the
// spawn path called `onMessageEnd()` on EVERY assistant turn. A
// budget-exceeded child is chatty by definition (each turn costs tokens), so it
// reset the clock on every turn and the kill could never fire: the steer
// landed, the child kept burning, and only the 2 h wall-clock backstop ended
// it. The budget was therefore a no-op on exactly the run it exists to stop.
// Deferral is right for the LOOP detector (new work means the loop may have
// ended, so killing discards it); here new turns ARE the violation.
//
// This is the case the offline suite never covered: it asserted `check()`
// ARMS the kill and that a self-exiting child is spared, but never that a
// chatty child is actually KILLED. A gate never observed to fire is worthless.
// ---------------------------------------------------------------------------
{
  const GRACE = 400;
  const killedSigs: string[] = [];
  const child = { killed: killedSigs, kill: (sig: string) => killedSigs.push(sig) } as never;
  let steered = 0;
  await withEnvAsync({ PI_ENSEMBLE_TOKEN_BUDGET_DEVELOPER: "100" }, async () => {
    const session = createCapSession({
      role: "developer",
      child,
      onSteer: () => {
        steered += 1;
      },
      totalTokens: () => 100_000, // far over the 100-token budget
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: GRACE,
      childExited: () => false,
    });
    // The child crosses the budget, then stays chatty: assistant turns every
    // 50ms over ~6x the grace window, exactly what spawn-inflight.ts feeds on a
    // hot run — which drives BOTH `check(now)` AND `onMessageEnd(now)` on every
    // assistant message_end. Driving `check()` alone made this assertion
    // vacuous: on the pre-fix shape `onMessageEnd()` was the call that reset the
    // grace clock, so a loop that never calls it distinguishes nothing and
    // passes on broken code too. Measured against origin/main's three files:
    // with `onMessageEnd()` present in the loop the kill NEVER fires (48 turns,
    // `killed:false`, no cause); without it this same assertion stays green.
    // `turns` is the second witness the kill did not arrive early.
    const tracker = session.tokenBudgetTracker;
    tracker?.check(Date.now());
    let turns = 0;
    const start = Date.now();
    while (!tracker?.killed && Date.now() - start < GRACE * 6) {
      await new Promise((r) => setTimeout(r, 50));
      const now = Date.now();
      tracker?.check(now); // per-turn check (no-op once triggered)
      // The production call. On the pre-fix shape this resets the grace clock
      // on every turn and the kill never fires; on the fixed shape the window
      // is absolute from the trigger, so the turn traffic changes nothing.
      tracker?.onMessageEnd?.(now);
      turns += 1;
    }
    await new Promise((r) => setTimeout(r, GRACE + 150)); // let the 500ms poll land
    assert(turns > 0, `chatty child: turns kept arriving (${turns}) while the kill armed`);
    assert(steered === 1, "chatty child: exactly one wrap-up steer");
    assert(session.tokenBudgetTracker?.killed === true, "chatty child: budget kill FIRES");
    eq(killedSigs.length, 1, "chatty child: exactly one kill signal");
    assert(session.killCause() === "token-budget", "chatty child: killCause is token-budget");
    const elapsed = Date.now() - start;
    assert(
      elapsed >= GRACE,
      `kill respected the grace window (fired at ${elapsed}ms >= ${GRACE}ms)`,
    );
    session.cleanup();
  });
}

// ---------------------------------------------------------------------------
// #543 H2 — F7e INERTNESS: with PI_ENSEMBLE_DISPATCH_CAPS=0 (master switch),
// createCapSession creates NO loop observer, NO token-budget tracker, and NO
// new timer. A 20-repeat identical stream through the session produces no
// steer, no killCause, and no setInterval call from the session.
// ---------------------------------------------------------------------------
{
  let timersCreated = 0;
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    timersCreated += 1;
    return origSetInterval(fn, ms, ...args);
  }) as typeof setInterval;
  let session: ReturnType<typeof createCapSession>;
  withEnv({ PI_ENSEMBLE_DISPATCH_CAPS: "0" }, () => {
    try {
      session = createCapSession({
        role: "developer",
        child: { killed: [] as string[], kill: () => {} } as never,
        onSteer: () => {},
        totalTokens: () => 0,
        timedOut: () => false,
        inactivityKilled: () => false,
        aborted: () => false,
        capKillGraceMs: 1000,
        childExited: () => false,
      });
    } finally {
      globalThis.setInterval = origSetInterval;
    }
  });
  assert(session.loopObserver === undefined, "H2: master switch off → no loop observer");
  assert(
    session.tokenBudgetTracker === undefined,
    "H2: master switch off → no token-budget tracker",
  );
  assert(timersCreated === 0, `H2: master switch off → NO new setInterval (got ${timersCreated})`);
  // Feed a 20-repeat identical stream through the session's ingest path.
  // loopObserver is undefined so observe is a no-op; assert nothing changed.
  const blocks: PiContentBlock[] = [
    { type: "toolCall", id: "x", name: "bash", arguments: '{"command":"git log"}' },
  ];
  for (let turn = 0; turn < 20; turn++) session.loopObserver?.(blocks, turn);
  assert(!session.loopKilled(), "H2: 20-repeats through an inert session → not loop-killed");
  assert(
    session.killCause() === undefined,
    "H2: 20-repeats through an inert session → no killCause",
  );
}

// ---------------------------------------------------------------------------
// #543 spawn#6 — a DISTINCT fingerprint arriving after kill-trigger resets
// the grace clock (aligning with the budget tracker's onMessageEnd reset).
// The spec's deferral is "while no new message_end has arrived since
// trigger"; a different call is new work the in-flight kill would discard.
// ---------------------------------------------------------------------------
{
  const killedSigs: string[] = [];
  const child = { killed: killedSigs, kill: (sig: string) => killedSigs.push(sig) } as never;
  let session: ReturnType<typeof createCapSession>;
  await withEnvAsync({ PI_ENSEMBLE_CAP_KILL_GRACE_MS: "30000" /* long window */ }, async () => {
    session = createCapSession({
      role: "developer",
      child,
      onSteer: () => {},
      totalTokens: () => 0,
      timedOut: () => false,
      inactivityKilled: () => false,
      aborted: () => false,
      capKillGraceMs: 30_000,
      childExited: () => false,
    });
    // biome-ignore lint/style/noNonNullAssertion: caps are on by default in this test scope
    // biome-ignore lint/style/noNonNullAssertion: caps are on by default in this test scope; the observer is defined
    const observe = session.loopObserver!;
    // 10 identical calls → kill arms (count reaches LOOP_KILL_AT=10).
    for (let turn = 0; turn < 10; turn++) {
      observe(
        [{ type: "toolCall", id: "x", name: "bash", arguments: '{"command":"git log --oneline"}' }],
        turn,
      );
    }
    assert(!session.loopKilled(), "spawn#6: kill armed but grace window open");
    eq(child.killed, [], "spawn#6: no signal before grace elapses");
    // A DISTINCT message_end arrives (the loop ended).
    observe(
      [{ type: "toolCall", id: "x", name: "bash", arguments: '{"command":"cargo test"}' }],
      10,
    );
    // Wait 700ms (the poll fires at 500ms) — the grace clock was reset by
    // the distinct fingerprint, so the kill must NOT fire.
    await new Promise((r) => setTimeout(r, 700));
    assert(
      !session.loopKilled(),
      "spawn#6: distinct message_end reset the grace clock — kill deferred",
    );
    eq(child.killed, [], "spawn#6: no kill signal after the distinct message_end");
    session.cleanup();
  });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
