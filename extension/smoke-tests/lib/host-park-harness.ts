/**
 * smoke-tests/lib/host-park-harness — the stub world for #1696's host-channel
 * park signal (`test-host-park-signal.ts`), split out for the §12 file-size cap.
 *
 * A temp repo, a controllable issue body, a forge that records every call it is
 * asked to make, and the two ways a park is reached:
 *
 *   - `park()` drives the handoff step directly for a cap no step can be coaxed
 *     into on command (`step-failed:explore`), which is the point — a cap
 *     outside `COVERED_PARK_CAPS` has no park record, so this is the shape the
 *     covered guard cannot see at all;
 *   - `driverPark()` runs the whole cycle through `runWorkDriver`, so the
 *     signal is left beside a real state file — the world a factory that passes
 *     `--restart` on every cycle actually leaves behind;
 *   - `start()` is the factory's own call: `runHeadless({restart:true})`.
 *
 * The one rule the whole suite turns on lives in `park()`: a park is PUBLISHED
 * when the handoff rendered a NON-EMPTY body. An empty body returns a state with
 * no handoff at all, so nothing is counted — nobody received anything.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Forge } from "../../src/forge.ts";
import { runHeadless } from "../../src/headless/run.ts";
import type { DispatchResult } from "../../src/types.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import {
  type HostParkWriter,
  __setHostParkWriter,
} from "../../src/work-driver-handoff-host-writer.ts";
import { runHandoff } from "../../src/work-driver-handoff.ts";
import type { DriverHost } from "../../src/work-driver-host.ts";
import { type HostParkRow, hostParkSignalPath } from "../../src/work-driver-park-memory-host.ts";
import { runWorkDriver } from "../../src/work-driver.ts";
import { type WorkState, appendEvent, initialState, writeState } from "../../src/workflow-state.ts";

export const ISSUE = 930;
/** A cap OUTSIDE COVERED_PARK_CAPS — the whole point: no park record for it. */
export const CAP = "step-failed:explore";

export interface World {
  repo: string;
  body: string;
  bodyReadable: boolean;
  /** The handoff body the cycle renders; "" simulates one that published nothing. */
  handoffBody: string;
  dispatches: number;
  forgeCalls: string[];
}

export function world(label: string): World {
  const repo = mkdtempSync(path.join(tmpdir(), `host-park-${label}-`));
  mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  return {
    repo,
    body: `title:\tmock #${ISSUE}\n\nthe verify gate hangs on a sandbox`,
    bodyReadable: true,
    handoffBody: "The cycle stopped: the explore dispatch failed twice.",
    dispatches: 0,
    forgeCalls: [],
  };
}

/** A forge that records every call; writes throw, so a host cycle has nothing to post anyway. */
export function recordingForge(w: World): Forge {
  const base = { forge: "github", host: "github.com", owner: "o", repo: "r" } as object;
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      if (prop === "then") return undefined;
      return async (...args: unknown[]) => {
        w.forgeCalls.push(String(prop));
        if (prop === "issueComment") {
          return `https://github.com/o/r/issues/${args[0]}#issuecomment-1`;
        }
        throw new Error(`${String(prop)} unavailable`);
      };
    },
  }) as Forge;
}

/** Every dispatch fails: that is what parks the cycle on `step-failed:explore`. */
export function seams(w: World) {
  return {
    issueBodyFetcherFn: async () => {
      if (!w.bodyReadable) throw new Error("gh: connection reset");
      return { stdout: w.body };
    },
    dispatchFn: async (_pi: string, spec: { role: string }): Promise<DispatchResult> => {
      w.dispatches++;
      throw new Error(`${spec.role} dispatch failed (simulated)`);
    },
  };
}

/** Distinct per cycle: the signal's idempotency key is the cycle's start time. */
let clock = 1_700_000_000_000;

export function driverCtx(w: World): DriverContext {
  return {
    host: { sendUserMessage: () => undefined } as unknown as DriverHost,
    repoRoot: w.repo,
    issue: ISSUE,
    issues: [ISSUE],
    forge: recordingForge(w),
    ...seams(w),
  } as unknown as DriverContext;
}

function cappedState(opts: { parkReason?: string }): WorkState {
  return appendEvent(initialState(ISSUE, ++clock), {
    kind: "cap-hit",
    at: Date.now(),
    cap: CAP,
    reviewRound: 0,
    nextStep: "handoff",
    ...(opts.parkReason ? { parkReason: opts.parkReason } : {}),
  } as never);
}

/** Run the handoff step with the host channel set (or cleared) for this call. */
async function withChannel<T>(host: boolean, fn: () => Promise<T>): Promise<T> {
  if (host) process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  else delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  try {
    return await fn();
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  }
}

/**
 * Publish one park through the handoff step, with the body the cycle would have
 * handed the host. An empty body publishes nothing: the state comes back with no
 * handoff event, and the signal counts no delivery.
 *
 * `priorRows` is the reading a writer holds when it reaches the signal's write —
 * what a sibling wrote in between is invisible to it, which is the whole shape
 * `recordHostPark`'s max-before-increment exists for. `replayOf` runs the handoff
 * of an EARLIER cycle (a crash between the record write and the state write, then
 * a resume): the signal already carries that cycle's `lastCycleId`, so the write
 * must be refused rather than moving the number the guard refuses on.
 */
export async function park(
  w: World,
  opts: {
    host: boolean;
    body?: string;
    parkReason?: string;
    /** One reading per `recordHostPark` read, in call order. */
    priorRows?: HostParkRow[][];
    /** A cycle to replay the handoff of (a resume re-entering its own step). */
    replayOf?: WorkState;
  },
): Promise<WorkState> {
  const state = opts.replayOf ?? cappedState(opts);
  const body = opts.body === undefined ? w.handoffBody : opts.body;
  if (!body) return state;
  // A test that simulates a second writer supplies the two readings this one
  // write should see. `runHandoff` installs them around its OWN call to the
  // writer, because it is the caller: installing them here, outside the step, is
  // the shape that made the writer read the disk instead — the step's write has
  // already happened by the time anything below it runs.
  if (opts.priorRows) {
    const host = await import("../../src/work-driver-park-memory-host.ts");
    // The queue is copied UP FRONT: `recordHostPark` consumes it by shifting, so a
    // copy made inside the writer would hand both reads the same unshifted queue
    // and the two readings the test asks for would never differ.
    const queue = [...opts.priorRows];
    return withChannel(opts.host, () =>
      runHandoff(driverCtx(w), state, Date.now(), {
        writer: (ctx, s, published) => host.recordHostPark(ctx, s, published, queue),
      }),
    );
  }
  return withChannel(opts.host, () => runHandoff(driverCtx(w), state, Date.now()));
}

/**
 * Publish one park through the DRIVER itself (`runWorkDriver`) rather than the
 * handoff step alone: the state file is written first, every step a real cycle
 * takes runs, and the signal is left beside a state file the next `--restart`
 * wipes — the shape the factory leaves behind.
 */
export async function driverPark(w: World): Promise<void> {
  await writeState(w.repo, cappedState({}));
  await withChannel(true, () =>
    runWorkDriver({
      host: { sendUserMessage: () => undefined } as unknown as DriverHost,
      repoRoot: w.repo,
      issue: ISSUE,
      issues: [ISSUE],
      restart: true,
      ...seams(w),
    } as unknown as DriverContext),
  );
}

/** The factory's own call: a fresh cycle for the issue, `--restart` and all. */
export async function start(w: World, host: boolean) {
  return withChannel(host, () =>
    runHeadless({
      repoRoot: w.repo,
      issues: [ISSUE],
      restart: true,
      driverSeams: seams(w) as never,
      write: () => {},
    }),
  );
}

export const signalPath = (w: World) => hostParkSignalPath(w.repo, ISSUE);

export const signalOf = (w: World) =>
  JSON.parse(readFileSync(signalPath(w), "utf8")) as Array<{
    cap: string;
    reason: string;
    deliveredCount: number;
  }>;

/**
 * Rewrite every row of the signal on purpose — the states no cycle produces
 * (a row past the age floor, a `deliveredCount` that is not an integer). The
 * reader's job is to treat each as ABSENT rather than trusted, because the
 * refusal it feeds is a hard stop.
 */
export function tamperSignal(w: World, patch: (row: Record<string, unknown>) => void): void {
  const rows = JSON.parse(readFileSync(signalPath(w), "utf8")) as Array<Record<string, unknown>>;
  for (const r of rows) patch(r);
  writeFileSync(signalPath(w), JSON.stringify(rows), "utf8");
}

export const refused = (run: Awaited<ReturnType<typeof start>>) =>
  run.results[0].cap === "repeat-park";
