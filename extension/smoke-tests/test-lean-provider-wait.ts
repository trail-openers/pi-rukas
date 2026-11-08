#!/usr/bin/env bun
/**
 * lean/provider-wait — the one leaf that decides whether lean sits out a
 * provider fault before its existing single retry, and for how long.
 *
 * The wait a lean retry takes is the SAME ladder the /work step router takes
 * (`providerRetryWaitMs` through `jitteredMs`), and the same three refusals:
 * only a provider-class cause waits at all; `PI_ENSEMBLE_TRANSIENT_RETRY=0`
 * waits for nothing; and a wait the run's deadline cannot fit inside its
 * handoff allowance is skipped rather than started. An aborted signal ends the
 * wait at once — the step then proceeds exactly as the no-wait path would.
 *
 * Offline: every wait goes through the leaf's own sleep seam, so no case here
 * sleeps for real and each one reads the ms the leaf ASKED for.
 */

import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import {
  __setLeanSleepFn,
  providerWaitNote,
  waitOutProviderFault,
} from "../src/lean/provider-wait.ts";
import type { DispatchFailureCause } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A classification's shape, from just the two fields the ladder reads. */
const cls = (cause: DispatchFailureCause, waitMs?: number) =>
  waitMs === undefined ? { cause } : { cause, waitMs };

/** Record every wait the seam is asked for; nothing sleeps. */
function recorder() {
  const slept: number[] = [];
  const restore = __setLeanSleepFn(async (ms) => {
    slept.push(ms);
    return true;
  });
  return { slept, restore };
}

// Full jitter draws anywhere in [0, 2×rung), so a case that bounds a wait by a
// deadline — or asserts a rung — cannot reason about one draw. Every bound below is
// therefore the rung CEILING (2× the ladder's own base), which full jitter can
// never exceed, and the skip arm leaves a millisecond under the FLOOR, which is
// what the ladder returns before any jitter is added. `floor` is pinned because the
// production 60 s provider floor would make (4)'s deadline unsatisfiable.
const RUNG = 5_000;
process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS = String(RUNG);

const saved = {
  backoff: process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS,
  floor: process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS,
  retry: process.env.PI_ENSEMBLE_TRANSIENT_RETRY,
};
function withEnv(over: Record<string, string | undefined>, run: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return run().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const BASE = { backoff: "1000" };

// ── (1) a provider-class cause waits, and the length is the ladder's ────────
await withEnv({ ...BASE, PI_ENSEMBLE_TRANSIENT_RETRY: undefined }, async () => {
  const { slept, restore } = recorder();
  try {
    const waited = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 1,
      now: 1_000,
    });
    // The D1 rung: floor × attempt (50), then full jitter on top, which
    // `jitteredMs` lifts to a full second for a sub-second base. What the seam
    // was handed and what the caller reports must be one number.
    // The rung is floor × attempt and full jitter returns at most twice it.
    assert(
      slept.length === 1 && slept[0] === waited && waited >= 0 && waited <= 2 * RUNG,
      `(1) a provider-severed fault waits once, within the rung ceiling, and the seam saw it (${JSON.stringify(slept)}, ${String(waited)})`,
    );
    const stated = await waitOutProviderFault({
      cls: cls("rate-limited:burst", 30_000),
      attempt: 1,
      now: 1_000,
    });
    assert(
      slept.length === 2 && stated >= 30_000,
      `(1) a provider-stated delay is a FLOOR, never underslept (${String(slept[1])}, returned ${String(stated)})`,
    );
  } finally {
    restore();
  }
});

// ── (2) only provider-class causes reach the ladder ─────────────────────────
await withEnv({ ...BASE, PI_ENSEMBLE_TRANSIENT_RETRY: undefined }, async () => {
  const { slept, restore } = recorder();
  try {
    for (const cause of [
      "crashed",
      "self-killed:inactivity",
      "rate-limited:quota-terminal",
      "provider-model-unavailable",
    ] as DispatchFailureCause[]) {
      const waited = await waitOutProviderFault({ cls: cls(cause), attempt: 1, now: 0 });
      assert(
        waited === 0,
        `(2) a non-provider cause (${cause}) returns zero waited — no wait, no re-dispatch into it`,
      );
    }
    assert(slept.length === 0, `(2) none of them touched the seam (${JSON.stringify(slept)})`);
  } finally {
    restore();
  }
});

// ── (3) the escape hatch: PI_ENSEMBLE_TRANSIENT_RETRY=0 waits for nothing ───
await withEnv({ ...BASE, PI_ENSEMBLE_TRANSIENT_RETRY: "0" }, async () => {
  const { slept, restore } = recorder();
  try {
    const waited = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 1,
      now: 0,
    });
    assert(
      waited === 0 && slept.length === 0,
      `(3) the same provider fault waits nothing with the hatch off (${String(waited)}, ${JSON.stringify(slept)})`,
    );
  } finally {
    restore();
  }
});

// ── (4) the deadline bound: a wait the cycle cannot fit is skipped ───────────
await withEnv({ ...BASE, PI_ENSEMBLE_TRANSIENT_RETRY: undefined }, async () => {
  const { slept, restore } = recorder();
  try {
    const allow = handoffAllowanceMs();
    // Full jitter is what makes a length unbounded across runs, so both arms draw
    // with a fixed generator: (0, 0) is the bottom of the range, where the ladder
    // returns the rung itself, and the only variable left is the deadline. The
    // stated delay is a FLOOR the ladder must clear, so the rung here is it.
    const noJitter = () => 0;
    const rung = RUNG;
    const tooClose = await waitOutProviderFault({
      cls: cls("rate-limited:burst", rung),
      attempt: 1,
      now: 0,
      rand: noJitter,
      // The wait plus the allowance is what must still fit; this leaves one
      // millisecond less than the rung this draw returns.
      deadlineMs: rung + allow - 1,
    });
    assert(
      tooClose === 0 && slept.length === 0,
      `(4) a deadline that cannot fit the wait AND the allowance skips it (${String(tooClose)}, ${JSON.stringify(slept)})`,
    );
    // The SAME seam draw as the case above: the only thing that changed is the
    // bound, so skip-here / wait-there is the branch and never the random draw.
    const fits = await waitOutProviderFault({
      cls: cls("rate-limited:burst", rung),
      attempt: 1,
      now: 0,
      rand: noJitter,
      // Room for that same rung, plus the allowance the handback still owns.
      deadlineMs: 2 * rung + allow,
    });
    assert(
      fits > 0 && slept.length === 1 && fits === rung,
      `(4) room outside the wait + allowance takes the wait (${String(fits)}, ${JSON.stringify(slept)})`,
    );
    const none = await waitOutProviderFault({ cls: cls("provider-severed"), attempt: 1, now: 0 });
    assert(none > 0, "(4) no deadline is never a reason to skip the wait");
  } finally {
    restore();
  }
});

// ── (5) an aborted signal ends the wait, and the step proceeds ──────────────
await withEnv({ ...BASE, PI_ENSEMBLE_TRANSIENT_RETRY: undefined }, async () => {
  const slept: number[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const restore = __setLeanSleepFn(async (ms, signal) => {
    slept.push(ms);
    signals.push(signal);
    // The production default resolves early on abort; a seam that ignored the
    // signal would prove nothing here, so the seam honours it the same way and
    // reports the early return the way the leaf's own default does.
    if (signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, 0));
    return signal?.aborted !== true;
  });
  try {
    const aborted = new AbortController();
    aborted.abort();
    const waited = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 1,
      now: 0,
      signal: aborted.signal,
    });
    assert(
      slept.length === 1 &&
        signals[0] === aborted.signal &&
        waited === 0 &&
        providerWaitNote(waited) === "waited 0s for a transient provider fault",
      `(5) the wait is handed the caller's signal, and an abort reports NO wait (${JSON.stringify(slept)}, ${String(waited)})`,
    );
    const plain = await waitOutProviderFault({ cls: cls("provider-severed"), attempt: 1, now: 0 });
    assert(
      plain > 0 && signals[1] === undefined,
      "(5) a caller with no signal still gets its wait",
    );
    // The measured defect: the signal fires while the wait is in flight (a SIGTERM
    // landing mid-sleep), which is the shape `abortableSleep` resolves early for. A
    // cut-short wait must not be reported as the rung it asked for, because that
    // number is what the step's reason records and what the handback repeats. The seam
    // honours the abort only after a tick, so the signal is not yet raised at entry.
    const rung = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 1,
      now: 0,
      rand: () => 0.5,
    });
    const mid = new AbortController();
    const late = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 1,
      now: 0,
      signal: mid.signal,
      // Same draw as the un-aborted call just above, so the rung is identical and the
      // ONLY difference between the two is that the signal fires before it ends.
      rand: () => {
        setTimeout(() => mid.abort(), 0);
        return 0.5;
      },
    });
    assert(
      slept.length === 4 &&
        slept[3] === rung &&
        rung > 0 &&
        late === 0 &&
        providerWaitNote(late) === "waited 0s for a transient provider fault",
      `(5) a wait the signal ends halfway reports NO wait, not the rung (${JSON.stringify(slept)}, ${String(late)})`,
    );
  } finally {
    restore();
  }
});

// ── (6) the rung scales by the attempt — the ladder the router uses ─────────
await withEnv({ ...BASE, PI_ENSEMBLE_TRANSIENT_RETRY: undefined }, async () => {
  const { slept, restore } = recorder();
  try {
    // One rung per attempt, read through the only caller the leaf has. With the
    // draw fixed at the top of the range each rung is exactly twice its
    // predecessor, the ordering full jitter would otherwise break, and the seam
    // shows the attempt-3 call really was handed the attempt-3 rung.
    const top = () => 1;
    const rung1 = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 1,
      now: 0,
      rand: top,
    });
    const rung2 = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 2,
      now: 0,
      rand: top,
    });
    const rung3 = await waitOutProviderFault({
      cls: cls("provider-severed"),
      attempt: 3,
      now: 0,
      rand: top,
    });
    assert(
      rung2 === 2 * rung1 &&
        rung3 === 3 * rung1 &&
        rung1 > 0 &&
        slept.join() === [rung1, rung2, rung3].join(),
      `(6) the rung scales by the attempt and the seam got each one (${String(rung1)} -> ${String(rung2)} -> ${String(rung3)}; ${JSON.stringify(slept)})`,
    );
  } finally {
    restore();
  }
});

for (const [k, v] of Object.entries(saved)) {
  const key =
    k === "backoff"
      ? "PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS"
      : k === "floor"
        ? "PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS"
        : "PI_ENSEMBLE_TRANSIENT_RETRY";
  if (v === undefined) delete process.env[key];
  else process.env[key] = v;
}

process.exit(exit);
