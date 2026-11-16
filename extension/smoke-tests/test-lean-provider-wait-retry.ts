#!/usr/bin/env bun
/**
 * #2124 — lean waits out a transient provider fault before its ONE retry.
 *
 * The field shape: an endpoint that reloads mid-run answers with 502/503 "model
 * is still loading" in bursts that hit every lane at once. Lean already re-dispatches
 * a child that provably did no work, and already re-prompts a silent specify
 * child — but it did both IMMEDIATELY, so the retry landed in the same outage,
 * spent the run's only retry, and the run handed back with an empty diff.
 *
 * Every case here drives the real step through the real fixture and reads the
 * waits the leaf recorded — no case sleeps for real:
 *
 *   (1) build:  a 503 "model is still loading" no-work child, then a working one
 *               — one recorded wait > 0, the run lands, one re-dispatch;
 *   (2) build:  a non-provider no-work crash keeps today's immediate re-dispatch;
 *   (3) build:  kill / quota-terminal children still THROW with zero waits;
 *   (4) build:  PI_ENSEMBLE_TRANSIENT_RETRY=0 — one re-dispatch, zero waits;
 *   (5) build:  a deadline that cannot fit the wait + allowance — zero waits,
 *               the re-dispatch still happens; both arms pin the jitter draw and
 *               the backoff env, so neither direction depends on `Math.random`;
 *   (6) build:  the wait is in the step's recorded reason, not only stderr;
 *   (7) specify: the same 503 child is retried through the existing re-prompt,
 *               with the wait recorded, and every OTHER specify throw is unchanged.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { handoffAllowanceMs } from "../src/lean/deadline.ts";
import { __setLeanSleepFn } from "../src/lean/provider-wait.ts";
import type { DispatchResult } from "../src/types.ts";
import { commitPaths } from "./lib/lean-build-asserts.ts";
import { ROOTS as BUILD_ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import {
  ROOTS,
  RUNNER,
  configWith,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The burst a self-hosted endpoint answers with while it reloads. */
const STILL_LOADING = { reason: "error", message: "HTTP 503 model is still loading" };
/** A quota the taxonomy calls final — waiting cannot clear it. */
const QUOTA = {
  reason: "error",
  message: "429 status code, Server requested 86400s retry delay",
};

/** A child that died with no turn and no tool call. */
const NOWORK: Partial<DispatchResult> = {
  ok: false,
  exitCode: 1,
  text: "",
  toolUses: [],
  observedToolCalls: 0,
  usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
};

const EDIT_FILE = (wt: string) => {
  mkdirSync(path.join(wt, "src"), { recursive: true });
  writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => 1;\n");
};

/** Env set for the whole file's duration, restored at the end. */
const ENV_KEYS = [
  "PI_ENSEMBLE_TRANSIENT_RETRY",
  "PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS",
  "PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS",
  // #2286 — the clamp `leanProviderWaitMs` applies AFTER the jitter. A host that set it under
  // the floor would change the drawn wait out from under case (5)'s arithmetic.
  "PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS",
  "PI_ENSEMBLE_HANDOFF_TIMEOUT_MS",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
// Nothing in this file may sleep for real, and no case asserts a wall-clock wait.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS = "60000";
process.env.PI_ENSEMBLE_HANDOFF_TIMEOUT_MS = "10000";
// The clamp sits above every wait this file draws, so it never bites — pinned rather than
// defaulted so an ambient 30-min default (or a host's smaller value) cannot move a drawn wait.
process.env.PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS = String(10 * 60_000);
// #2286 — the wait arms assert that a wait WAS taken, which is vacuous with the hatch off.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "1";

/** Run one case with the sleep seam recording; nothing sleeps for real. */
async function withWaits<T>(run: () => Promise<T>): Promise<{ waits: number[]; value: T }> {
  const waits: number[] = [];
  const restore = __setLeanSleepFn(async (ms) => {
    waits.push(ms);
    return true;
  });
  try {
    return { waits, value: await run() };
  } finally {
    restore();
  }
}

/** Set one env key for the duration of one case, restoring after. */
async function withEnv<T>(key: string, value: string | undefined, run: () => Promise<T>) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await run();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// ── (1) build: a 503 no-work child waits out the burst, then lands ──────────
{
  const { waits, value: r } = await withWaits(() =>
    runBuild({
      issue: 2124,
      child: EDIT_FILE,
      dispatchResults: [{ ...NOWORK, errorStop: STILL_LOADING }],
    }),
  );
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(1) the run proceeds after the wait (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(r.dispatched === 2, `(1) exactly one re-dispatch, as today (got ${String(r.dispatched)})`);
  assert(
    waits.length === 1 && (waits[0] ?? 0) > 0,
    `(1) ONE provider wait was taken, and it was not zero (${JSON.stringify(waits)})`,
  );
  assert(
    commitPaths(r.worktree).join() === "src/retry.ts",
    `(1) the second child's file landed (got ${commitPaths(r.worktree).join(", ")})`,
  );
}

// ── (2) build: a non-provider no-work crash keeps today's immediate retry ───
{
  const { waits, value: r } = await withWaits(() =>
    runBuild({ issue: 2125, child: EDIT_FILE, dispatchResults: [NOWORK] }),
  );
  assert(
    r.threw === undefined && r.outcome?.kind === "ok" && r.dispatched === 2,
    `(2) a plain crash is still re-dispatched at once (got ${r.threw?.message ?? `${r.outcome?.kind}/${String(r.dispatched)}`})`,
  );
  assert(
    waits.length === 0,
    `(2) a non-provider crash records ZERO waits — R1: the ladder is provider-class only (${JSON.stringify(waits)})`,
  );
}

// ── (3) build: kill and quota-terminal still throw, with zero waits ─────────
{
  const cases: Array<[string, Partial<DispatchResult>]> = [
    ["kill (timeout)", { ...NOWORK, killCause: "timeout" as const }],
    ["kill (abort)", { ...NOWORK, killCause: "abort" as const }],
    ["quota-terminal 429", { ...NOWORK, errorStop: QUOTA }],
    ["non-provider crash", NOWORK],
  ];
  for (const [name, shape] of cases) {
    const { waits, value: r } = await withWaits(() =>
      runBuild({ issue: 2126, child: EDIT_FILE, dispatchResults: () => shape }),
    );
    assert(waits.length === 0, `(3) a ${name} records zero waits (${JSON.stringify(waits)})`);
  }
  // The throw cases: a kill and a quota-terminal fault never reach the
  // re-dispatch branch at all, so AC2 on them is the throw plus an empty waits
  // array (the gap-gate LOW's wording).
  for (const [name, shape] of cases.slice(0, 3) as Array<[string, Partial<DispatchResult>]>) {
    const { waits, value: r } = await withWaits(() =>
      runBuild({ issue: 2127, child: EDIT_FILE, dispatchResults: () => shape }),
    );
    assert(
      r.dispatched === 1 && waits.length === 0,
      `(3) a ${name} dies on the first dispatch with no wait (${String(r.dispatched)}, ${JSON.stringify(waits)})`,
    );
  }
}

// ── (4) build: the escape hatch removes the wait, not the retry ─────────────
{
  const wrapped = await withEnv("PI_ENSEMBLE_TRANSIENT_RETRY", "0", () =>
    withWaits(() =>
      runBuild({
        issue: 2128,
        child: EDIT_FILE,
        dispatchResults: [{ ...NOWORK, errorStop: STILL_LOADING }],
      }),
    ),
  );
  const r = wrapped.value;
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(4) with the hatch off the run still lands (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    r.dispatched === 2,
    `(4) and the retry count is UNCHANGED — the hatch removes the wait only (got ${String(r.dispatched)})`,
  );
  assert(
    wrapped.waits.length === 0,
    `(4) PI_ENSEMBLE_TRANSIENT_RETRY=0 records zero waits (${JSON.stringify(wrapped.waits)})`,
  );
}

// ── (5) build: a deadline too close skips the wait and keeps the retry ──────
{
  // #2286 — the 503 classifies provider-severed with no provider-stated delay, so the rung
  // `providerRetryWaitMs` returns is `min(maxWait, floor)` and `jitteredMs` then takes its
  // `floorMs === 0` arm: the whole wait is ONE draw, `min(maxWait, ceil(rand × base))` with
  // `base = min(maxWait, floor)`. Under this file's pins that is `ceil(rand × 60 000)`; under an
  // ambient smaller floor or clamp it is something else entirely, which is why both keys are
  // pinned above. The step's clock is pinned at 0 and the deadline is a constant, so the guard's
  // own rule (`provider-wait.ts`: skip when `deadlineMs - now - handoffAllowanceMs() < wait`)
  // reduces to `deadlineMs - allowance < wait`. Both arms pin the draw for their duration and
  // state their expectation against that rule — never against luck.
  const draw = (r: number) => () => r;
  // 1 000 ms of room beyond the handoff allowance, the number the guard compares against.
  const roomMs = 1_000;
  const allowance = handoffAllowanceMs();
  /** The two env numbers the leaf's length formula reads, as it reads them. */
  const floorMs = () => Number(process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS);
  const maxWaitMs = () => Number(process.env.PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS);
  /** The wait one draw produces, spelled out with the same arithmetic the leaf runs. */
  const drawnWait = (r: number): number =>
    Math.min(maxWaitMs(), Math.ceil(r * Math.min(maxWaitMs(), floorMs())));
  const providerChild = [{ ...NOWORK, errorStop: STILL_LOADING }];
  /** Run one build with the jitter draw pinned, restored whatever the run does. */
  const withDraw = async <T,>(rand: () => number, run: () => Promise<T>): Promise<T> => {
    const realRandom = Math.random;
    Math.random = rand;
    try {
      return await run();
    } finally {
      Math.random = realRandom;
    }
  };

  // Skip arm — the guard's rule is a STRICT comparison, so the two boundary draws sit one
  // millisecond either side of the room and land on opposite sides of the branch: the drawn wait
  // must be ≥ `roomMs + 1` to be skipped. (`ceil` means a draw of exactly `roomMs / base` is NOT
  // the boundary — it lifts to `roomMs`, which fits — so the pair is taken on the WAIT axis, the
  // axis the guard compares, and each arm asserts the wait its own draw produced.)
  const skipDraws = [
    { name: "a draw well inside the room", rand: draw(0.001) },
    { name: "the boundary draw one ms under the room", rand: draw((roomMs - 1) / 60_000) },
    { name: "the boundary draw one ms over the room", rand: draw((roomMs + 1) / 60_000) },
    { name: "a draw the whole wait class can max out to", rand: draw(1) },
  ];
  for (const arm of skipDraws) {
    const wait = drawnWait(arm.rand());
    const expectsWait = wait <= roomMs;
    const { waits, value: r } = await withWaits(() =>
      withDraw(arm.rand, () =>
        runBuild({
          issue: 2129,
          child: EDIT_FILE,
          // ctx.now() is pinned to 0 by the fixture, so this IS the room the guard compares.
          clock: { now: () => 0, deadlineMs: () => allowance + roomMs },
          dispatchResults: providerChild,
        }),
      ),
    );
    assert(
      waits.length === (expectsWait ? 1 : 0) && (waits[0] === undefined || waits[0] === wait),
      `(5) skip arm: ${arm.name} draws ${String(wait)} ms against ${String(roomMs)} ms of room, so the guard (${expectsWait ? "takes" : "skips"}) it (${JSON.stringify(waits)})`,
    );
    assert(
      r.threw === undefined && r.outcome?.kind === "ok" && r.dispatched === 2,
      `(5) and today's immediate re-dispatch is exactly what happens instead (${r.threw?.message ?? `${r.outcome?.kind}/${String(r.dispatched)}`})`,
    );
  }

  // Roomy arm: one NAMED non-zero draw, far enough above zero that the assertion cannot be
  // satisfied by the bottom of the jitter range.
  const roomyDraw = 0.5;
  const roomyWait = drawnWait(roomyDraw);
  const roomy = await withWaits(() =>
    withDraw(draw(roomyDraw), () =>
      runBuild({
        issue: 2130,
        child: EDIT_FILE,
        // The same guard, this time with room beyond the drawn wait + allowance.
        clock: { now: () => 0, deadlineMs: () => 60_000 + allowance + 60_000 },
        dispatchResults: providerChild,
      }),
    ),
  );
  assert(
    roomy.waits.length === 1 && roomy.waits[0] === roomyWait,
    `(5) the same case with room outside the allowance takes the wait the 0.5 draw names: ${String(roomyWait)} ms (${JSON.stringify(roomy.waits)})`,
  );
}

// ── (6) build: the wait is in the step's REASON, not only stderr ────────────
{
  const { value: r } = await withWaits(() =>
    runBuild({
      issue: 2131,
      child: EDIT_FILE,
      dispatchResults: [{ ...NOWORK, errorStop: STILL_LOADING }],
    }),
  );
  const reason = r.outcome?.reason ?? "";
  assert(
    /waited \d+s for a transient provider fault/.test(reason),
    `(6) the step's recorded reason carries the wait sentence (got ${JSON.stringify(reason)})`,
  );
}

// ── (7) specify: a dead provider child is re-prompted after a wait ──────────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const dead: Partial<DispatchResult> = {
    ok: false,
    exitCode: 1,
    text: "",
    toolUses: [],
    observedToolCalls: 0,
    errorStop: STILL_LOADING,
    usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
  const { waits, value: r } = await withWaits(() =>
    runSpecify({
      repoRoot,
      baseSha,
      issue: 31,
      config: configWith({ test: RUNNER }),
      writes: (wt, n) => {
        if (n > 1) {
          mkdirSync(path.join(wt, "tests"), { recursive: true });
          writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
        }
      },
      toolUses: (n) => (n > 1 ? [submit("AC1", ["tests/AC1-retry.test.sh"])] : []),
      dispatchResults: [dead],
    }),
  );
  assert(
    r.threw === undefined,
    `(7) a dead provider child no longer throws past the re-prompt (got ${r.threw?.constructor.name ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(
    r.outcome?.kind === "ok",
    `(7) the run proceeds to ok through the existing single re-prompt (got ${r.outcome?.kind})`,
  );
  assert(
    r.dispatched === 2,
    `(7) exactly one re-prompt — the retry count is unchanged (got ${String(r.dispatched)})`,
  );
  assert(
    waits.length === 1 && (waits[0] ?? 0) > 0,
    `(7) the wait landed before the re-prompt (${JSON.stringify(waits)})`,
  );
  assert(
    /waited \d+s for a transient provider fault/.test(r.outcome?.reason ?? ""),
    `(7) and the step's reason says so (got ${JSON.stringify(r.outcome?.reason)})`,
  );
}

// ── (7b) specify: an ordinary dead child still throws exactly as today ──────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const { waits, value: r } = await withWaits(() =>
    runSpecify({
      repoRoot,
      baseSha,
      issue: 32,
      config: configWith({ test: RUNNER }),
      writes: () => {},
      toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
      dispatchOk: false,
    }),
  );
  assert(
    r.threw !== undefined && r.dispatched === 1,
    `(7b) a non-provider dead child still throws on the first dispatch (got ${r.threw?.constructor.name ?? `outcome ${r.outcome?.kind}`})`,
  );
  assert(waits.length === 0, `(7b) and records zero waits (${JSON.stringify(waits)})`);
}

// ── (7c) specify: a provider death that DID work still throws ───────────────
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const worked: Partial<DispatchResult> = {
    ok: false,
    exitCode: 1,
    text: "",
    toolUses: [{ name: "bash", arguments: {} }],
    observedToolCalls: 1,
    errorStop: STILL_LOADING,
    usage: { input: 9, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 3 },
  };
  const { waits, value: r } = await withWaits(() =>
    runSpecify({
      repoRoot,
      baseSha,
      issue: 33,
      config: configWith({ test: RUNNER }),
      writes: () => {},
      toolUses: [],
      dispatchResults: [worked],
    }),
  );
  assert(
    r.threw !== undefined && r.dispatched === 1 && waits.length === 0,
    `(7c) the retryable-provider result is ONLY where no work was proven (${r.threw?.constructor.name ?? `outcome ${r.outcome?.kind}`}, ${String(r.dispatched)}, ${JSON.stringify(waits)})`,
  );
}

for (const dir of [...BUILD_ROOTS, ...ROOTS]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
for (const k of ENV_KEYS) {
  const v = savedEnv[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
process.exit(exit);
