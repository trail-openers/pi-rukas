#!/usr/bin/env bun
/**
 * #1765 — the in-flight registry that lets the branch step register a base-health
 * probe WITHOUT awaiting it, and lets the develop gate consult it later.
 *
 * The branch step's whole contribution is that it returns immediately, so every
 * rule here is about what a caller that never awaits can and cannot observe:
 *
 *   - `startBaseHealthProbe` returns at once and runs `start` exactly once, even
 *     when two cycles ask for the same key at the same moment;
 *   - the entry is gone the moment the probe settles, so a later cycle re-probes
 *     rather than being told "the base is red" by a run it did not perform;
 *   - a probe that rejects is reported as "nothing", never as a rejection the
 *     background task leaked (the caller dropped that promise, so nobody is left
 *     holding an unhandled rejection);
 *   - the develop gate's consultation is BOUNDED: a probe that never answers costs
 *     the gate its own bound and nothing more, and the gate proceeds on its own
 *     evidence. That is the "never delayed" half of the change — the gate waits
 *     only when its verify has already failed, and only as long as the run it
 *     would have re-paid.
 *
 * Offline: no fixture repos, no dispatch, no spawn. Timers are real and short.
 */
import {
  awaitInflightBaseHealth,
  clearBaseHealthInflight,
  inflightBaseHealthCount,
  peekBaseHealthProbe,
  startBaseHealthProbe,
} from "../src/work-driver-base-health-inflight.ts";
import type { BaseHealthKey } from "../src/workflow-state-schema-base-health.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const KEY: BaseHealthKey = { baseSha: "a".repeat(40), command: "sh gate.sh", tierBoundMs: 200 };
const otherKey = (baseSha: string): BaseHealthKey => ({ ...KEY, baseSha });
const GREEN = {
  ran: true,
  ms: 42,
  verdict: { status: "green" as const, baseSha: KEY.baseSha, command: KEY.command, tierBoundMs: KEY.tierBoundMs },
  notes: [],
};
const RED = {
  ran: true,
  ms: 42,
  verdict: { status: "red" as const, baseSha: KEY.baseSha, command: KEY.command, tierBoundMs: KEY.tierBoundMs },
  notes: [],
};
const UNKNOWN = { ran: false, notes: ["nothing ran"] };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 1 — the registering caller is never made to wait.
{
  clearBaseHealthInflight();
  let started = 0;
  const t0 = Date.now();
  const p = startBaseHealthProbe(KEY, async () => {
    started += 1;
    await sleep(50);
    return GREEN;
  });
  const returnedMs = Date.now() - t0;
  assert(started === 1, "start: the probe body was invoked synchronously by the call");
  assert(returnedMs < 25, `start: the call returned without waiting for the run (${returnedMs} ms) — this is the whole change`);
  assert(inflightBaseHealthCount() === 1, "start: the probe is registered while it runs");
  const out = await p;
  assert(out.verdict?.status === "green", "start: the caller that DID await reads the verdict");
  assert(inflightBaseHealthCount() === 0, "settle: the entry is deleted when the probe answers");
}

// ── 2 — two cycles for one key share one run; two keys do not share.
{
  clearBaseHealthInflight();
  let runs = 0;
  const a = startBaseHealthProbe(KEY, async () => {
    runs += 1;
    await sleep(30);
    return GREEN;
  });
  const b = startBaseHealthProbe(KEY, async () => {
    runs += 1;
    await sleep(30);
    return GREEN;
  });
  assert(a === b, "single-flight: the second caller joins the first promise, not a second run");
  const c = startBaseHealthProbe(otherKey("b".repeat(40)), async () => {
    runs += 1;
    return GREEN;
  });
  await Promise.all([a, b, c]);
  assert(runs === 2, `single-flight: one run per key, not one per caller (got ${runs})`);
  assert(inflightBaseHealthCount() === 0, "single-flight: both entries cleared on settle");
}

// ── 3 — the bound: a probe that never answers costs the gate its own bound.
{
  clearBaseHealthInflight();
  const pending = startBaseHealthProbe(KEY, () => new Promise(() => undefined));
  assert(pending instanceof Promise, "bound: registering a probe that never settles is still a promise");
  const t0 = Date.now();
  const consulted = await awaitInflightBaseHealth(KEY, 60);
  const waited = Date.now() - t0;
  assert(consulted === undefined, "bound: a probe that never answers is read as NOTHING, not guessed at");
  assert(waited >= 40 && waited < 1_000, `bound: the gate waited its own bound and no more (${waited} ms) — the probe cannot hold the develop gate open`);
}

// ── 4 — nothing registered (a resume, or the switches off) is the same "nothing".
{
  clearBaseHealthInflight();
  const consulted = await awaitInflightBaseHealth(KEY, 50);
  assert(consulted === undefined, "absent: no entry means the gate answers for the base itself");
  assert(peekBaseHealthProbe(KEY) === undefined, "absent: nothing to peek at");
}

// ── 5 — a rejected probe reaches the gate as nothing, never as a rejection.
{
  clearBaseHealthInflight();
  let unhandled = 0;
  const onUnhandled = (e: unknown) => {
    unhandled += 1;
    console.error(`✗ unhandled rejection escaped the registry: ${String(e)}`);
  };
  process.on("unhandledRejection", onUnhandled);
  const p = startBaseHealthProbe(KEY, () => Promise.reject(new Error("fork: Resource temporarily unavailable")));
  // The branch step drops this promise. Nothing awaits it, so if the registry let
  // the rejection stand, the process would die with no idea which cycle caused it.
  void p;
  const consulted = await awaitInflightBaseHealth(KEY, 50);
  assert(consulted === undefined, "rejection: a probe that faulted is read as nothing");
  const settled = await p;
  assert(
    settled.ran === false && settled.verdict === undefined,
    `rejection: the dropped promise resolves instead of rejecting (ran=${settled.ran}, verdict=${settled.verdict?.status ?? "absent"})`,
  );
  await sleep(10);
  process.off("unhandledRejection", onUnhandled);
  assert(unhandled === 0, "rejection: no unhandled rejection reached the process");
  assert(inflightBaseHealthCount() === 0, "rejection: the entry is cleared even on a fault");
}

// ── 6 — an unknown verdict is not a consultation. The gate must not be able to
// read "nothing was established" as a colour, whatever the probe recorded.
{
  clearBaseHealthInflight();
  startBaseHealthProbe(KEY, async () => UNKNOWN);
  const consulted = await awaitInflightBaseHealth(KEY, 50);
  assert(consulted === undefined, "unknown: a probe that established nothing is not a verdict to consult");
}

// ── 7 — a red is readable, and the consultation carries the ms the gate records.
{
  clearBaseHealthInflight();
  startBaseHealthProbe(KEY, async () => RED);
  const consulted = await awaitInflightBaseHealth(KEY, 50);
  assert(consulted?.verdict.status === "red", "red: the develop gate can read the colour the probe earned");
  assert(
    consulted?.outcome.ms === 42 && consulted.outcome.ran === true,
    `red: the consultation carries the probe's measured ms (${consulted?.outcome.ms}) and that it ran a suite of its own (${consulted?.outcome.ran})`,
  );
}

// ── 8 — a probe that replaced an entry is not cleared by the run it replaced.
{
  clearBaseHealthInflight();
  let releaseFirst: () => void = () => {};
  const first = startBaseHealthProbe(KEY, () => new Promise((r) => (releaseFirst = () => r(GREEN))));
  // The first run is still pending; a newer cycle for the same key joins it rather
  // than starting a third run, and when the first settles the key must be free.
  const joined = startBaseHealthProbe(KEY, () => Promise.resolve(RED));
  assert(first === joined, "identity: a pending probe is joined, not replaced");
  releaseFirst();
  await first;
  assert(inflightBaseHealthCount() === 0, "identity: the settled run cleared its own key");
  const again = await awaitInflightBaseHealth(KEY, 20);
  assert(again === undefined, "identity: a cleared key is a fresh cycle's own probe, not a stale answer");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
