/**
 * decision-shadow — ask a shadow seam's question without waiting for the
 * answer (#1308 S3/S4).
 *
 * A shadow seam's caller already holds its answer: the deterministic rule,
 * computed synchronously, is the acted-on outcome. The model is asked only
 * so the decision log can later show whether it beats the rule (S5). So the
 * caller fires `shadowDecide()` and moves on:
 *
 *   - **Nothing is awaited on the caller's path.** The `decide()` call is
 *     scheduled on a later macrotask (`setImmediate`), so even its synchronous
 *     prefix (serialise, redact, hash) costs the caller nothing. Rule callers
 *     such as `classifyFailureCause` run on every dispatch failure and stay
 *     synchronous.
 *   - **Never throws, never changes an outcome.** The answer is discarded; a
 *     rejection is traced. Only a seam whose effective mode is not `enforce`
 *     is fired, so an env override cannot turn a fire-and-forget call into an
 *     acted-on one — such a call is refused and traced. A call that is not
 *     fired (refused, dropped, unreadable config) still writes one stateless
 *     record saying why, so S5 sees the gap.
 *   - **Bounded.** `decide()` bounds every backend by the seam's timeout, and
 *     at most `MAX_IN_FLIGHT` shadow decisions run at once; a burst beyond
 *     that is dropped and traced rather than queued behind a slow model. The
 *     in-flight slot is always released, even when building the chain throws
 *     (#1393).
 *   - **Throttled where it is only a note.** SKIP records — "we did not ask" —
 *     are throttled per seam per `SKIP_WINDOW_MS`, with the suppressed count
 *     carried into the next record after the window closes. EXACT-RULE-MATCH
 *     records are NOT: one is one decision the driver acted on (#1393).
 *
 * The model context is the Pi session's: `attach()` captures the
 * ExtensionContext on `session_start` (the work-widget pattern), and each
 * call reads `ctx.model` then, so a model switch is honoured. With no session
 * attached — the offline suite, a headless caller — `decide()` has no
 * backend and logs the rule answer only. A call's own `where.repoRoot` names
 * the log; without one the session's cwd does.
 */

import { appendDecisionRecord } from "./decision-log.ts";
import { SEAMS, type SeamId, type SeamSpec, seamConfig } from "./decision-seam-registry.ts";
import {
  type DecideCtx,
  type DecideRequest,
  type Decision,
  type DecisionWhere,
  boundedState,
  decide,
} from "./decision-seam.ts";
import { traceWarn } from "./trace.ts";

/**
 * The reason stamped on an EXACT rule match's record (#1393), where the rule
 * answered and no model was asked. Exported so the taxonomy's record and its
 * tests name the same fact. The record carries it as `reason` AND the boolean
 * `exactRuleMatch: true` — never `skipped`, which is the other kind of record
 * and is derived from one constant either way.
 */
export const EXACT_RULE_MATCH = "exact rule match";

/**
 * Which of the two record kinds `writeShadowRecord` writes. A TAG, not a string
 * the writer compares against: a skip is a note that says "we did not ask"
 * (throttled per seam), an exact match is a decision the rule made (never
 * throttled, and it carries `exactRuleMatch`). Deriving one from the other's
 * prose is what let a storm of exact matches look like a burst of notes.
 */
export type ShadowRecordKind = "skip" | "exact-rule-match";

/**
 * Where a call's records go. ROUTING ONLY (#1393): a repo root and issues. A
 * record's `state` payload is a named argument of the writer that needs one
 * (`shadowExactRuleMatch`), never a field smuggled through the routing object —
 * the seam, not the caller, decides which of its paths may put text into a
 * record and bounds it against the registry entry.
 */
export type ShadowWhere = DecisionWhere;

/** What the shadow calls need from the session; an ExtensionContext satisfies it. */
type SessionCtx = Pick<DecideCtx, "modelRegistry" | "model"> & { cwd?: string };

let session: SessionCtx | undefined;
let inFlight = 0;

/** A burst of failures must not become a burst of model calls. */
const MAX_IN_FLIGHT = 16;

/**
 * #1393 — how long a seam's SKIP records stay silent once one has been written.
 * A provider outage produces one failure per dispatch, so without a window a
 * 429 storm wrote one JSONL line and one traceWarn per failure; 500 of them
 * measured 500 of each. The window is per seam, because the two shadow seams
 * skip for different reasons and one's burst must not silence the other's.
 */
export const SKIP_WINDOW_MS = 60_000;

/** The clock the throttle reads. Injectable so the offline suite is not time-dependent. */
let skipNow: () => number = () => Date.now();

/** Per seam: when its last skip record was written, and how many were suppressed since. */
const lastSkipAt = new Map<SeamId, number>();
const suppressedSince = new Map<SeamId, number>();

/**
 * #1393 — how many exact-match records may be in flight at once. An exact match
 * is deliberately not throttled (one is one decision the driver acted on), but
 * "not throttled" must not mean "unbounded": a 500-kill storm that fans out 500
 * concurrent `appendDecisionRecord` calls is the same shape the skip window
 * exists to stop, just on the write side instead of the model side. Past the
 * cap a record is dropped and traced rather than queued.
 */
const MAX_EXACT_IN_FLIGHT = 32;

/** Exact-match writes currently in flight, and the window they are counted over. */
let exactInFlight = 0;
let exactWindowStartedAt = 0;

/** One window of exact-match writes: reset when it is older than the skip window. */
function exactWindowOpen(now: number): boolean {
  if (now - exactWindowStartedAt >= SKIP_WINDOW_MS) {
    exactWindowStartedAt = now;
    exactInFlight = 0;
    return true;
  }
  return true;
}

/** Test seam: the exact-match counter, which is otherwise module-private. */
export function __exactInFlightForTests(): number {
  return exactInFlight;
}

/** Test seam: replace the throttle's clock. Returns the restore function. */
export function __setSkipClockForTests(now: () => number): () => void {
  const prev = skipNow;
  skipNow = now;
  return () => {
    skipNow = prev;
  };
}

/** Test seam: the in-flight counter, which is otherwise module-private. */
export function __inFlightForTests(): number {
  return inFlight;
}

/**
 * Test seam: drop the throttle state and (with `inFlight` or `exact`) the
 * in-flight counters. A test that fakes the clock leaves a future stamp behind,
 * which would silence the next test's skips; production never calls this.
 */
export function __resetShadowForTests(opts: { inFlight?: boolean; exact?: boolean } = {}): void {
  lastSkipAt.clear();
  suppressedSince.clear();
  if (opts.inFlight) inFlight = 0;
  if (opts.inFlight || opts.exact) exactInFlight = 0;
}

/**
 * Test seam: drive the in-flight counter the way a real backend would, and
 * observe it. `shadowDecide` runs its own guards first (no model configured,
 * unreadable seam config, saturated counter) and those paths never reach the
 * counter — so a test cannot make the counter nonzero by calling `shadowDecide`
 * with a slow state, which is the mistake this hook exists to prevent. The
 * increment/release pair here is the same one `shadowDecideUnguarded` uses.
 */
export function __acquireSlotForTests(): () => void {
  inFlight++;
  return () => {
    inFlight--;
  };
}

/** Capture the session context from session_start. */
export function attach(ctx: SessionCtx): void {
  session = ctx;
}

/** Drop the session context. Called on session_shutdown. */
export function detach(): void {
  session = undefined;
}

/** The session's registry, model and cwd, read now. A stale context yields none. */
function sessionNow(): {
  modelRegistry?: SessionCtx["modelRegistry"];
  model?: SessionCtx["model"];
  cwd?: string;
} {
  try {
    return session
      ? { modelRegistry: session.modelRegistry, model: session.model, cwd: session.cwd }
      : {};
  } catch (err) {
    traceWarn(`decision-shadow: session context unreadable, rule only: ${(err as Error)?.message}`);
    return {};
  }
}

/**
 * The one writer behind both record paths. `kind` is a TAG choosing between a
 * note ("we did not ask", throttled) and a decision record (an exact rule match,
 * never throttled by the skip window, but bounded by `MAX_EXACT_IN_FLIGHT`).
 * `reason` names the skip, and is the exact record's `reason` too.
 *
 * The record is STATELESS apart from what the caller passed as `state`, which
 * the seam bounds and redacts by the registry entry — so a caller can never put
 * untrusted text into a record by hand (#1393). Never throws. The trace line is
 * INSIDE the throttle gate: a suppressed skip writes no record and no trace
 * line, and its count is carried into the next record (#1393).
 */
function writeShadowRecord(
  seam: SeamId,
  req: Pick<DecideRequest, "question" | "rule">,
  where: ShadowWhere,
  kind: ShadowRecordKind,
  reason: string,
  throttle: boolean,
  state?: unknown,
): Promise<undefined> {
  const now = skipNow();
  let summary: { suppressed: number; suppressedSinceMs: number } | undefined;
  if (throttle) {
    // Monotonic-safe on BOTH sides of the comparison: a clock that went backwards
    // (an NTP step, a test's restored fake clock) must neither widen the window
    // nor wedge it shut, so the test is `now >= last` AND the elapsed gap under
    // the window (#1393).
    const last = lastSkipAt.get(seam);
    if (last !== undefined && now >= last && now - last < SKIP_WINDOW_MS) {
      // A suppressed skip leaves NOTHING behind: no record, no trace line.
      suppressedSince.set(seam, (suppressedSince.get(seam) ?? 0) + 1);
      return Promise.resolve(undefined);
    }
    const carried = suppressedSince.get(seam) ?? 0;
    lastSkipAt.set(seam, now);
    suppressedSince.delete(seam);
    // A window that closes with no later skip writes nothing at all: the count
    // is carried forward and dropped, never fabricated into a record.
    summary =
      last === undefined || carried === 0
        ? undefined
        : { suppressed: carried, suppressedSinceMs: now - last };
  }
  const exact = kind === "exact-rule-match";
  if (exact) {
    // #1393 — the exact path is not throttled, so it is bounded instead: past
    // the cap a write is dropped and traced, which is what keeps a 500-kill
    // storm from becoming 500 concurrent appends.
    exactWindowOpen(now);
    if (exactInFlight >= MAX_EXACT_IN_FLIGHT) {
      traceWarn(
        `decision-shadow: '${seam}' exact-match record dropped — ${exactInFlight} already in flight`,
      );
      return Promise.resolve(undefined);
    }
    exactInFlight++;
  }
  let released = false;
  const release = () => {
    if (exact) exactInFlight = Math.max(0, exactInFlight - 1);
  };
  const bounded =
    state === undefined ? undefined : boundedState(state, SEAMS[seam] as SeamSpec).state;
  traceWarn(
    exact
      ? `decision-shadow: '${seam}' answered by the exact rule: ${reason}`
      : `decision-shadow: '${seam}' not fired: ${reason}`,
  );
  // The slot releases when the append SETTLES, not only when it rejects: an
  // append that succeeds and leaves the counter held would saturate the path
  // permanently after one storm, which is worse than the unbounded write the
  // cap exists to prevent.
  const releaseOnce = () => {
    if (!released) {
      released = true;
      release();
    }
  };
  return appendDecisionRecord(
    { repoRoot: where.repoRoot ?? sessionNow().cwd, issues: where.issues },
    {
      ts: new Date().toISOString(),
      seam,
      question: req.question,
      ruleAnswer: req.rule,
      // An exact match is a decision the rule made, not a call that was
      // withheld: it carries `exactRuleMatch` AND its `reason`, and S5 counts
      // the two kinds apart.
      ...(exact ? { exactRuleMatch: true, reason } : { skipped: reason }),
      ...(bounded === undefined ? {} : { state: bounded }),
      ...(summary ? summary : {}),
    },
  ).then(
    () => {
      releaseOnce();
      return undefined;
    },
    (err: unknown) => {
      releaseOnce();
      traceWarn(
        `decision-shadow: '${seam}' record not written: ${(err as Error)?.message ?? String(err)}`,
      );
      return undefined;
    },
  );
}

/**
 * Record that a shadow call was deliberately NOT made (no model is asked).
 * One stateless record, so S5 sees the gap in its sample. Throttled per seam
 * per `SKIP_WINDOW_MS` — see the module header. Never throws.
 *
 * `throttle: false` is for the refusals that are a CONFIGURATION fact rather
 * than an outage symptom — a seam set to `enforce`, an unreadable seam contract,
 * a saturated in-flight counter. Those are rarer than an outage and say more,
 * and an outage burst must not be able to silence them: the outage opens the
 * seam's window, and a configuration refusal arriving inside it would otherwise
 * be counted and dropped (#1393).
 */
export function shadowSkip(
  seam: SeamId,
  req: Pick<DecideRequest, "question" | "rule">,
  where: ShadowWhere,
  reason: string,
  throttle = true,
): Promise<undefined> {
  return writeShadowRecord(seam, req, where, "skip", reason, throttle);
}

/**
 * One record for an EXACT rule match (#1393): a cause the rule reads exactly —
 * any self-killed:*, `success`, a 429 / spend-cap from the provider's own
 * message. Deliberately NOT throttled by the skip window: each is a decision the
 * driver acted on, and a storm of exact kills must still leave one auditable
 * record per decision. It IS bounded — at `MAX_EXACT_IN_FLIGHT` concurrent
 * writes, past which a record is dropped and traced rather than queued.
 *
 * `state` is a NAMED argument, not a field of `where` (#1393): only this path
 * may carry a payload into a record, and the seam bounds and redacts it against
 * the registry entry.
 */
export function shadowExactRuleMatch(
  seam: SeamId,
  req: Pick<DecideRequest, "question" | "rule">,
  where: ShadowWhere,
  state?: unknown,
): Promise<undefined> {
  return writeShadowRecord(seam, req, where, "exact-rule-match", EXACT_RULE_MATCH, false, state);
}

/**
 * Fire a shadow decision. Returns the settled decision (or undefined when it
 * was not run) for tests; production callers ignore it.
 */
export function shadowDecide(
  seam: SeamId,
  req: DecideRequest,
  where: ShadowWhere = {},
): Promise<Decision | undefined> {
  // The synchronous prefix must never throw into the caller's rule path.
  try {
    return shadowDecideUnguarded(seam, req, where);
  } catch (err) {
    traceWarn(`decision-shadow: '${seam}' not fired: ${(err as Error)?.message ?? String(err)}`);
    return Promise.resolve(undefined);
  }
}

function shadowDecideUnguarded(
  seam: SeamId,
  req: DecideRequest,
  where: ShadowWhere,
): Promise<Decision | undefined> {
  // A call that is not fired still leaves one record (no state, so nothing to
  // redact): S5 must see a gap in its sample, not silently lose it. The
  // configuration refusals are unthrottled (see `shadowSkip`); only the burst-
  // shaped drop — saturation — rides the window.
  const skipped = (reason: string, throttle = false): Promise<undefined> =>
    shadowSkip(seam, req, where, reason, throttle);
  let mode: string;
  try {
    mode = seamConfig(SEAMS[seam] as SeamSpec).mode;
  } catch (err) {
    // The caller's rule answer must not depend on the shadow call.
    return skipped(`seam config unreadable: ${(err as Error)?.message ?? String(err)}`);
  }
  if (mode === "enforce") return skipped("configured to enforce; a shadow call cannot act");
  if (inFlight >= MAX_IN_FLIGHT)
    return skipped(`${inFlight} shadow decisions already in flight`, true);
  // #1393 — the slot is taken here and released by the tail attached in
  // `finally`, so a throw while BUILDING the chain (a `setImmediate` whose
  // implementation throws, a throwing clock) cannot leave it held: 16 such
  // leaks disable every shadow seam for the process's life, with no trace
  // beyond dropped-call warnings. A completion inside the chain settles the
  // outer promise, so the tail runs exactly once either way.
  inFlight++;
  const startedAt = Date.now();
  let settled = false;
  // #1393 — the slot-hold warning used to be written ONLY from the chain's
  // `finally`, so a chain that never settled held its slot forever and printed
  // nothing: the exact event the warning exists for was the one it could not
  // observe. A timer armed at `startedAt + 4 x timeout` fires whether or not the
  // chain does; the `finally` clears it when the call does settle, and `held()`
  // keeps the existing wording identical on both paths.
  const holdBoundMs = 4 * SEAMS[seam].timeoutMs;
  let holdWatchdog: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    holdWatchdog = undefined;
    traceWarn(
      `decision-shadow: '${seam}' held its slot for ${Date.now() - startedAt}ms and never settled (seam bound ${SEAMS[seam].timeoutMs}ms)`,
    );
  }, holdBoundMs);
  // A watchdog must never be the reason a process stays alive.
  holdWatchdog.unref?.();
  let chain: Promise<Decision | undefined> | undefined;
  try {
    chain = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      const s = sessionNow();
      const d = await decide(seam, req, {
        modelRegistry: s.modelRegistry,
        model: s.model,
        repoRoot: where.repoRoot ?? s.cwd,
        issues: where.issues,
      });
      settled = true;
      return d;
    });
  } catch (err) {
    traceWarn(`decision-shadow: '${seam}' not fired: ${(err as Error)?.message ?? String(err)}`);
  }
  const guarded = (chain ?? Promise.resolve(undefined)).catch((err: unknown) => {
    settled = true;
    traceWarn(`decision-shadow: '${seam}' failed: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  });
  return guarded.finally(() => {
    inFlight--;
    if (holdWatchdog !== undefined) {
      clearTimeout(holdWatchdog);
      holdWatchdog = undefined;
    }
    // A shadow call that outlived its own seam bound by a wide margin is what
    // narrows MAX_IN_FLIGHT toward zero while every later call is silently
    // dropped as "already in flight", so the event is traced rather than felt.
    const held = Date.now() - startedAt;
    if (settled && held > holdBoundMs) {
      traceWarn(
        `decision-shadow: '${seam}' held its slot for ${held}ms (seam bound ${SEAMS[seam].timeoutMs}ms)`,
      );
    }
  });
}
