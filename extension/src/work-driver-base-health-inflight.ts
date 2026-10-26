/**
 * work-driver-base-health-inflight — the single-flight registry that keeps the
 * base-health probe OFF the branch step's critical path (the probe seam itself is
 * #1765; taking it off the critical path is what this module adds).
 *
 * The lookup shape is borrowed from `sharedFetch` in
 * `work-driver-branch-mechanized.ts` — join an in-flight run instead of starting a
 * second one — but the storage is a Map keyed by `baseHealthKey`, one entry per
 * key, because concurrent cycles sit on DIFFERENT bases and a single slot would
 * orphan the second cycle's probe rather than share it. An entry is deleted when its
 * own promise settles, so the Map holds only what is running; a probe that never
 * settles is bounded by its own tier timeout.
 *
 * Why a registry and not a promise on the state: the branch step REGISTERS the
 * probe and returns, so the only way the develop gate can reach the verdict is to
 * look it up by key. Two cycles on the same base then share one probe run and one
 * cache write, and the second never pays for a suite run it has already had judged.
 *
 * Two rules this module exists to keep:
 *
 * 1. **A registered promise never rejects.** The probe maps every fault — a
 *    throwing executor, an unreadable base, a malformed cache — to `unknown`, and
 *    `awaitInflightBaseHealth` adds a `catch` anyway. A background task that
 *    rejects is an unhandled rejection, and a probe whose whole contract is "an
 *    extra opinion, never an obstacle" must not be able to kill the cycle that
 *    started it.
 * 2. **Nothing here writes workflow state.** The develop step owns its own writes;
 *    a background promise appending to the same state would race them. So the
 *    registry is the ONLY channel from the probe to the develop gate, and the gate
 *    records the verdict into state when it reads it.
 */
import { trace } from "./trace.ts";
import { redactedBaseHealthText } from "./work-driver-verify-base-health.ts";
import type { BaseHealthProbeOutcome } from "./work-driver-verify-base-health.ts";
import {
  type BaseHealthKey,
  type BaseHealthVerdict,
  baseHealthKey,
} from "./workflow-state-schema-base-health.ts";
import type { WorkState } from "./workflow-state.ts";

/** The probe's answer, with every failure already folded into `unknown`. */
export type BaseHealthInFlight = Promise<BaseHealthProbeOutcome>;

/** One probe run, the key it answers for, and when it started. */
interface InFlightEntry {
  startedAt: number;
  p: BaseHealthInFlight;
}

const registry = new Map<string, InFlightEntry>();

/** The shape a probe that never answered is reported as. Never a park. */
function unanswered(notes: string): BaseHealthProbeOutcome {
  return { ran: false, notes: [`base-health: ${notes}`] };
}

/**
 * A probe that FAULTED, reported as the same `unknown` as a probe that reached no
 * verdict: it established nothing, so it must neither park a cycle nor leak a
 * rejection to the caller that dropped the promise. `start()`'s synchronous throw
 * and its asynchronous rejection both land here, which is what keeps rule 1 of
 * this module's header true whatever the shape of the fault (#1809 fix round).
 * The message is bounded because it is child output that reaches a trace line, and
 * REDACTED before it is bounded because the executor's message is whatever the
 * project's command printed — a token in a failing line must not reach the log.
 */
function unexpected(err: unknown): BaseHealthProbeOutcome {
  const message = redactedBaseHealthText(String((err as Error)?.message ?? err));
  trace(`work-driver: base-health in-flight probe faulted (${message}) — read as unknown`);
  return unanswered(`the background probe could not run (${message})`);
}

/**
 * Register a probe for `key`, or join the one already running for it. Returns the
 * shared promise; the branch step does NOT await it. `start` is the probe itself,
 * passed as a thunk so a coalesced caller never triggers a second run.
 *
 * `key.tierBoundMs` is part of the probe's identity and is read back off the
 * VERDICT it records, so producer and consumer cannot disagree about which run a
 * verdict answers for.
 */
export function startBaseHealthProbe(
  key: BaseHealthKey,
  start: () => Promise<BaseHealthProbeOutcome>,
): BaseHealthInFlight {
  const k = baseHealthKey(key);
  const existing = registry.get(k);
  if (existing !== undefined) {
    trace(
      `work-driver: base-health — joining the probe already running for base ${key.baseSha.slice(0, 12)} (${((Date.now() - existing.startedAt) / 1000).toFixed(0)} s in)`,
    );
    return existing.p;
  }
  // Built inline so the clear-on-settle guard below can compare promise IDENTITY:
  // an entry a newer run replaced must not be deleted by the run it replaced (the
  // same rule `sharedFetch`'s `?.p === p` enforces).
  //
  // #1809 fix round — `start()` is called inside `attempt()`, not on this thread.
  // A thunk that THROWS SYNCHRONOUSLY (a fixture whose gate throws before its
  // first `await`, an `fs` read that faults while resolving the command) would
  // otherwise escape `startBaseHealthProbe` as an exception on the branch step's
  // stack, and — reached through `startBaseHealthProbeAtBranch`'s `.then`, which
  // runs the thunk off its own `catch` — as a rejection on the promise the branch
  // step DROPS: an unhandled rejection, which is precisely the fault rule 1 of
  // this module says a probe cannot produce. Routing the call through a try/catch
  // folds both shapes into the same `unknown` verdict `start().catch` already
  // gives an async fault.
  const attempt = (): BaseHealthInFlight => {
    try {
      return start();
    } catch (err) {
      return Promise.resolve(unexpected(err));
    }
  };
  const owner: BaseHealthInFlight = attempt()
    // The async half of the same rule: a probe whose promise rejects (the probe
    // wraps its own seam, so this is the last line rather than the common case)
    // is the same `unknown` as one that threw on the way in.
    .catch((err: unknown) => unexpected(err))
    .finally(() => {
      if (registry.get(k)?.p === owner) registry.delete(k);
    });
  registry.set(k, { startedAt: Date.now(), p: owner });
  return owner;
}

/**
 * Await the registered probe for `key`, bounded by `boundMs` — the same tier bound
 * the develop gate hands `compareWithBaseline`, so waiting for the probe can never
 * cost more than the run it would have replaced. Past the bound the answer is
 * "nothing": the verdict is treated as unknown and the gate's own comparison
 * proceeds on its own evidence.
 *
 * `undefined` (nothing registered for this key) is the same answer: the shape after
 * a resume in a new process, or when the probe's switches were off. The develop gate
 * then re-probes, exactly as it did before the pre-develop probe existed — which is
 * why the background probe is an acceleration and never a requirement.
 */
export async function awaitInflightBaseHealth(
  key: BaseHealthKey,
  boundMs: number,
): Promise<BaseHealthConsultation | undefined> {
  const entry = registry.get(baseHealthKey(key));
  if (entry === undefined) {
    trace(
      `work-driver: base-health — nothing registered for base ${key.baseSha.slice(0, 12)}; the develop gate answers for the base itself`,
    );
    return undefined;
  }
  trace(
    `work-driver: base-health — the develop gate is waiting on the background probe for base ${key.baseSha.slice(0, 12)} (bound ${Math.round(boundMs / 1000)} s)`,
  );
  // Bounded so a hung probe cannot hold the develop gate open past the budget the
  // gate itself would have spent; and defensive, because a caller must not inherit
  // the never-rejects invariant as a precondition.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"bound">((resolve) => {
    timer = setTimeout(() => resolve("bound"), Math.max(1, boundMs));
  });
  try {
    const raced = await Promise.race([entry.p.catch(() => undefined), bound]);
    if (raced === "bound" || raced === undefined) {
      trace(
        "work-driver: base-health — the background probe did not answer inside its bound; read as unknown",
      );
      return undefined;
    }
    // A probe that answered with no verdict at all consulted nothing; the gate
    // then answers for the base on its own evidence.
    if (raced.verdict === undefined || raced.verdict.status === "unknown") return undefined;
    // The verdict AND the run's measured wall clock: the gate's record of the
    // consultation has to say what the probe cost, and the verdict alone cannot.
    return { verdict: raced.verdict, outcome: raced };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What a consultation read: the verdict, and the outcome it came from (which
 * carries the probe's measured ms and whether it ran a suite of its own).
 */
export type BaseHealthConsultation = {
  verdict: BaseHealthVerdict;
  outcome: BaseHealthProbeOutcome;
};

/** The registered promise for `key` — the one a coalesced probe call joins — or nothing. */
export function peekBaseHealthProbe(key: BaseHealthKey): BaseHealthInFlight | undefined {
  const entry = registry.get(baseHealthKey(key));
  if (entry === undefined) return undefined;
  return entry.p.catch(() => unanswered("the background probe did not answer"));
}

/**
 * How many probes this process has registered.
 */
export function inflightBaseHealthCount(): number {
  return registry.size;
}

/**
 * When the probe registered for `key` began, or `undefined` when none is running.
 * The develop gate reads this to size its wait: a probe that started more than one
 * tier bound ago has finished its first run, so any run it is now in is the
 * CONFIRMING one, and the wait has to cover a second bounded execution rather than
 * abandon it at the instant the answer is reachable.
 */
export function inflightBaseHealthStartedAt(key: BaseHealthKey): number | undefined {
  return registry.get(baseHealthKey(key))?.startedAt;
}

/**
 * Drop every entry. Test-only: each case builds its own fixture repo, and a probe
 * left running by one case would be joined by the next and answer for a base it
 * never checked out.
 */
export function clearBaseHealthInflight(): void {
  registry.clear();
}
