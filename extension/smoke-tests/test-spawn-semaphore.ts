#!/usr/bin/env bun
/**
 * Global spawn semaphore.
 *
 * Before this there was no concurrency cap on child Pi processes at all, and
 * the two things that look like caps are not:
 *   - `MAX_JOBS` throws rather than queues, and only sees dispatchCore work;
 *     `lens-review.ts` and `adversarial.ts` spawn directly and are invisible
 *     to it.
 *   - `MAX_PARALLEL` validates one tool call's array length.
 *
 * `develop` starts M children (one developer per workstream), or 2M when the
 * speculative explore is opted in with `PI_ENSEMBLE_SPECULATIVE_EXPLORE=1`;
 * parallel groups multiply that. At 3 groups x M=6 that is 18, or 36 with the
 * explore on — `pi --mode rpc` processes with nothing to stop them.
 */

import {
  __resetSpawnSemaphore,
  spawnCap,
  spawnSlotStats,
  withSpawnSlot,
} from "../src/spawn-semaphore.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function withCap<T>(cap: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PI_ENSEMBLE_SPAWN_CAP;
  process.env.PI_ENSEMBLE_SPAWN_CAP = cap;
  __resetSpawnSemaphore();
  try {
    return await fn();
  } finally {
    __resetSpawnSemaphore();
    if (prev === undefined) delete process.env.PI_ENSEMBLE_SPAWN_CAP;
    else process.env.PI_ENSEMBLE_SPAWN_CAP = prev;
  }
}

// 12 was the old default, and one M=6 develop step (2 children per workstream)
// consumed all of it — so a second concurrent cycle got zero slots and queued.
// The cap bounds local pids; the provider rations its own capacity via 429 +
// retry-after. See test-spawn-bounds.ts for the full canary.
assert(
  spawnCap() === 64,
  `default cap is 64 — above any single cycle's peak fanout (got ${spawnCap()})`,
);

// ------------------------------------------------------------- the cap holds

await withCap("4", async () => {
  let live = 0;
  let peak = 0;
  const tasks = Array.from({ length: 20 }, () =>
    withSpawnSlot(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await tick();
      live -= 1;
    }),
  );
  await Promise.all(tasks);
  assert(peak === 4, `a 20-way burst never exceeded the cap of 4 (peak ${peak})`);
  assert(live === 0, "every slot was released");
  assert(spawnSlotStats().active === 0, "the counter returned to zero");
  assert(spawnSlotStats().queued === 0, "the queue drained");
});

// ------------------------------------------------------------------- FIFO

await withCap("1", async () => {
  const order: number[] = [];
  // Occupy the single slot, then queue five behind it. FIFO matters because
  // the queue holds whole pipeline steps: LIFO would let a late arrival
  // overtake a developer the rest of its cycle is blocked on.
  const gate = withSpawnSlot(async () => {
    await tick();
  });
  await Promise.resolve();
  const queued = Array.from({ length: 5 }, (_, i) =>
    withSpawnSlot(async () => {
      order.push(i);
    }),
  );
  await Promise.all([gate, ...queued]);
  assert(order.join(",") === "0,1,2,3,4", `queued work ran in FIFO order (got ${order.join(",")})`);
});

// -------------------------------------------------- a throw frees its slot

await withCap("2", async () => {
  // If a rejecting child leaked its slot, a run of failures would ratchet the
  // effective cap to zero and wedge every later dispatch — a far worse
  // failure than the one being retried.
  for (let i = 0; i < 5; i++) {
    await withSpawnSlot(async () => {
      throw new Error("child died");
    }).catch(() => undefined);
  }
  assert(spawnSlotStats().active === 0, "five consecutive throws leaked no slots");

  let ran = false;
  await withSpawnSlot(async () => {
    ran = true;
  });
  assert(ran, "the semaphore still admits work after repeated failures");
});

await withCap("1", async () => {
  // A throw must also hand the slot to the NEXT waiter, not just decrement.
  const results: string[] = [];
  const failing = withSpawnSlot(async () => {
    await tick();
    throw new Error("boom");
  }).catch(() => results.push("failed"));
  await Promise.resolve();
  const following = withSpawnSlot(async () => {
    results.push("followed");
  });
  await Promise.all([failing, following]);
  assert(
    results.includes("followed"),
    "a waiter queued behind a throwing task still gets its slot",
  );
});

// --------------------------------------------------------------- disabled

await withCap("0", async () => {
  let live = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withSpawnSlot(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await tick();
        live -= 1;
      }),
    ),
  );
  assert(peak === 8, `PI_ENSEMBLE_SPAWN_CAP=0 disables the semaphore entirely (peak ${peak})`);
});

// Anti-vacuity: prove the harness above can actually observe over-cap
// concurrency, so "peak === 4" is a real constraint and not an artifact of
// the tasks never overlapping.
await withCap("0", async () => {
  let live = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withSpawnSlot(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await tick();
        live -= 1;
      }),
    ),
  );
  assert(peak > 4, `the same 20-way burst reaches ${peak} concurrent when uncapped`);
});

console.log(`\nexit ${exit}`);
process.exit(exit);
