/**
 * #1389 — the shared fakes for the three `pi-rukas-jobs` companions:
 * `test-pending-jobs-signal-honest-zero.ts` (a failed send is never an honest
 * "0"), `test-pending-jobs-signal-shutdown-order.ts` (shutdown does not publish
 * "0" ahead of the reports it killed), and
 * `test-pending-jobs-signal-batch-teardown.ts` (a half-started batch leaves
 * nothing behind).
 *
 * Both files drive the same status channel and the same job registry, and each
 * needs the same five things: a host that records what reached it and can be
 * told to reject, an RPC context that records what the channel published, a
 * `DispatchResult` double, a bounded wait, and a stderr capture (the WARNs the
 * fix emits are what several assertions read). Duplicated, the two copies had
 * already drifted — one typed its host against `(text, options)`, the other
 * against `(text)` alone, so the `deliverAs: "steer"` the contract requires was
 * asserted nowhere.
 *
 * Deliberately a smoke-tests/lib helper, not a src/ module: everything here is
 * test scaffolding, and `test-seams-wired.ts` treats a src/ module whose only
 * importer is a smoke test as an orphan.
 *
 * No Pi process spawned, no network.
 */

import type { Writable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchHost } from "../../src/async-jobs-lifecycle.ts";
import { childHandles } from "../../src/async-jobs-registry.ts";
import * as pendingJobs from "../../src/pending-jobs-signal.ts";
import type { DispatchResult } from "../../src/types.ts";

/**
 * What a test observed, in order where order matters.
 *
 * `delivered` is the honest ground truth for "a report reached the host": the
 * host's own record, not a counter some other deliverer could have moved. It is
 * what the product-side claims are compared against, so a pass with zero
 * deliveries cannot be read as compliance.
 */
export interface Wire {
  /** Text of every message the host ACCEPTED (a rejected send is not here). */
  reports: string[];
  /** Every `deliverAs` the host was handed, in call order. */
  deliverAs: Array<string | undefined>;
  /** 1-based index of EVERY call the host received, whether it accepted or threw.
   *  A case asserts "this send was attempted" against its length and "the host
   *  rejected it" against `rejectedAt`. */
  threwAt: number[];
  /** 1-based call indices on which the host threw. */
  rejectedAt: number[];
  /** Every `pi-rukas-jobs` text the status channel published, in order. */
  statuses: string[];
}

export function freshWire(): Wire {
  return { reports: [], deliverAs: [], threwAt: [], rejectedAt: [], statuses: [] };
}

/**
 * A child stdin that records whether anything asked it to stop.
 *
 * `ChildHandle.kill` is optional and `startBatch`'s `onStdin` never sets it, so
 * the batch cleanup would happily delete a map entry and leave the child
 * running. Registering one of these through `hooks.onStdin` and reading
 * `.killed` afterwards is how a test tells "stopped the child" from "forgot the
 * map entry" — and `clearJobsForTesting` does not touch `childHandles`, so the
 * handle survives the teardown long enough to be read.
 */
export interface KillSpy extends Writable {
  killed: number;
}

export function makeKillStdin(): KillSpy {
  const spy = {
    killed: 0,
    write() {
      return true;
    },
    end() {
      return spy;
    },
    destroyed: false,
    writable: true,
    kill() {
      spy.killed += 1;
    },
  };
  // `kill()` closes over `spy` rather than `this`: the teardown calls it as
  // `childHandles.get(id)?.kill?.()`, and a method that read `this` would be
  // counting on the callee being invoked with the handle as its receiver.
  return spy as unknown as KillSpy;
}

/**
 * The host's own signature. `DispatchHost` requires both parameters; typing the
 * fake against them (rather than `(text)` alone) is what makes a missing or
 * wrong `deliverAs` a compile error rather than an unasserted detail.
 */
export type HostSend = DispatchHost["sendUserMessage"];

/**
 * A host whose `sendUserMessage` throws on the `throwOn`-indexed call.
 *
 * Omit `throwOn` (or pass `[]`) and the host ACCEPTS every send — that is the
 * control shape. An earlier `!throwOn` meant "throw on everything", so every
 * control case silently ran against a rejecting host: the healthy-batch case
 * printed the both-rejected WARN and asserted on a batch that had delivered
 * nothing. A case that wants every call rejected passes an explicit list of the
 * indices it expects, so "throw everywhere" is still writable without making the
 * DEFAULT throw. Pi swallows the real rejection from the caller
 * (agent-message.ts), so this record of "call n threw" is the test-side truth the
 * product claims are measured against.
 */
export function makeHost(w: Wire, throwOn?: number[]): DispatchHost {
  let calls = 0;
  const reject = new Set(throwOn ?? []);
  return {
    sendUserMessage(text: string, options: { deliverAs: "steer" }): void {
      calls += 1;
      w.deliverAs.push(options?.deliverAs);
      // Record the call BEFORE the throw. `threwAt` is the test's ground truth
      // for "this host rejected a send", and a case that asks for call 1 to
      // reject must see BOTH "it was attempted" and "it failed" — recording only
      // on success made `threwAt` empty for an always-throwing host, so case 5's
      // control assertion ("nothing threw") was checking an artefact of the fake
      // rather than the product, and its companion "exactly one report" then read
      // a batch that legitimately produced nothing.
      w.threwAt.push(calls);
      if (reject.has(calls)) {
        w.rejectedAt.push(calls);
        throw new Error(`host rejected call ${calls}`);
      }
      w.reports.push(text);
    },
  };
}

/**
 * The same host shaped as the `pi` the async-jobs entry points take.
 *
 * `on` APPENDS every handler rather than keeping the last one, and
 * `fireShutdown` calls all of them. That matters: `registerAsyncJobsLifecycle`
 * is called once per session in production and a case commonly registers a
 * second pi to test a second session — with a last-write-wins fake the original
 * pi's hook is silently replaced, `fireShutdown()` then invokes a handler
 * belonging to a session that has no jobs, and every shutdown assertion in the
 * file passes on an empty handler. Recording them all is what makes the case
 * drive the hook the product actually installed.
 *
 * A real `Writable` stands in for the child stdin a spawn would register —
 * `hooks.onStdin` is a real seam in the batch path, and an `{} as never` there
 * hides the shape from the registry's `ChildHandle` contract.
 */
export function makePi(
  w: Wire,
  throwOn?: number[],
): {
  pi: ExtensionAPI;
  host: DispatchHost;
  stdin: KillSpy;
  fireShutdown: (reason?: string) => void;
} {
  const host = makeHost(w, throwOn);
  const handlers = new Map<string, Array<(event?: { reason?: string }) => void>>();
  const stdin: KillSpy = makeKillStdin();
  const pi = {
    // An ARROW, not a shorthand method: the teardown calls the handle's kill as
    // `childHandles.get(id)?.kill?.()`, and a fake whose members bind `this`
    // breaks the moment the call site uses optional chaining. Same reason
    // `makeKillStdin` closes over its own object instead of reading `this`.
    sendUserMessage: (text: string, options: { deliverAs: "steer" }): void =>
      host.sendUserMessage(text, options),
    on(event: string, handler: (event?: { reason?: string }) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    host,
    stdin,
    fireShutdown: (reason?: string) => {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ reason });
    },
  };
}

/**
 * An RPC `ExtensionContext` double carrying only the two fields this module
 * reads (`mode`, `ui.setStatus`) — the `StatusContext` shape
 * pending-jobs-signal.ts declares, so no `as never` is needed to attach it.
 */
export function attachRpc(w: Wire, mode: "rpc" | "tui" = "rpc"): void {
  pendingJobs.attach({
    mode,
    ui: {
      setStatus(key: string, text: string | undefined): void {
        if (key === pendingJobs.PENDING_JOBS_STATUS_KEY) w.statuses.push(text ?? "");
      },
    },
  });
}

/**
 * Every status published after `attach()`'s own initial "0".
 *
 * `attach()` always publishes the current count first, so a "<n>" assertion that
 * counted from index 0 would be reading the channel's baseline as if the case
 * had published it. A case that re-attaches mid-run (the shutdown-generation
 * case must — `shutdown()` detaches the context, so asserting on a channel
 * nobody can write to would let a missing "0" read as compliance) resets the
 * log through `resetLog()` so its frames are counted from its own baseline.
 */
export const sent = (w: Wire): string[] => w.statuses.slice(1);

/**
 * Drop everything the channel published so far, as if a fresh session had just
 * attached. Pair with `attachRpc()`: the two together are how a case declares
 * "everything after this point is mine".
 */
export function resetLog(w: Wire): void {
  w.reports.length = 0;
  w.deliverAs.length = 0;
  w.threwAt.length = 0;
  w.statuses.length = 0;
}

/** A complete `DispatchResult` — every required field, no cast at the call site. */
export function fakeResult(
  role: string,
  text: string,
  extra: Partial<DispatchResult> = {},
): DispatchResult {
  return {
    role,
    ok: true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    ...extra,
  };
}

/** Bounded poll — 300 × 10 ms, generous against the sub-150 ms bounds these cases set. */
export async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
}

/**
 * Capture stderr around `fn` so the assertions can read the WARNs the fix emits
 * (they are unconditional, which is the point — so they are also the only
 * signal a test has that a swallowed failure actually spoke).
 */
export async function withStderrCaptureAsync<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // The capture is held until the await BELOW settles as well, not just until
    // `fn` resolves: a case whose last act is `await until(...)` observing
    // something the bound publishes fires the WARN after `fn` returns, and
    // restoring the real stderr at that point loses the line the assertions are
    // about to read. So the promise is awaited first, then a microtask drain
    // lets any same-tick settle land, then the write is restored.
    const value = await fn();
    await new Promise((r) => setTimeout(r, 0));
    return { value, lines };
  } finally {
    process.stderr.write = real;
  }
}

/** Synchronous sibling of `withStderrCaptureAsync`, for a bare call. */
export function withStderrCapture<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), lines };
  } finally {
    process.stderr.write = real;
  }
}

/** True when `lines` contains an unconditional WARN carrying `needle`. */
export function warned(lines: readonly string[], needle: string): boolean {
  return lines.some((l) => l.startsWith("[pi-rukas] WARN") && l.includes(needle));
}
