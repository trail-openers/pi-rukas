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
 *     that is dropped and traced rather than queued behind a slow model.
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
  decide,
} from "./decision-seam.ts";
import { traceWarn } from "./trace.ts";

/** What the shadow calls need from the session; an ExtensionContext satisfies it. */
type SessionCtx = Pick<DecideCtx, "modelRegistry" | "model"> & { cwd?: string };

let session: SessionCtx | undefined;
let inFlight = 0;

/** A burst of failures must not become a burst of model calls. */
const MAX_IN_FLIGHT = 16;

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
 * Record that a shadow call was deliberately NOT made (no model is asked).
 * One stateless record, so S5 sees the gap in its sample. Never throws.
 */
export function shadowSkip(
  seam: SeamId,
  req: Pick<DecideRequest, "question" | "rule">,
  where: DecisionWhere,
  reason: string,
): Promise<undefined> {
  traceWarn(`decision-shadow: '${seam}' not fired: ${reason}`);
  return appendDecisionRecord(
    { repoRoot: where.repoRoot ?? sessionNow().cwd, issues: where.issues },
    {
      ts: new Date().toISOString(),
      seam,
      question: req.question,
      ruleAnswer: req.rule,
      skipped: reason,
    },
  ).then(
    () => undefined,
    (err: unknown) => {
      traceWarn(
        `decision-shadow: '${seam}' skip record not written: ${(err as Error)?.message ?? String(err)}`,
      );
      return undefined;
    },
  );
}

/**
 * Fire a shadow decision. Returns the settled decision (or undefined when it
 * was not run) for tests; production callers ignore it.
 */
export function shadowDecide(
  seam: SeamId,
  req: DecideRequest,
  where: DecisionWhere = {},
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
  where: DecisionWhere,
): Promise<Decision | undefined> {
  // A call that is not fired still leaves one record (no state, so nothing to
  // redact): S5 must see a gap in its sample, not silently lose it.
  const skipped = (reason: string): Promise<undefined> => shadowSkip(seam, req, where, reason);
  let mode: string;
  try {
    mode = seamConfig(SEAMS[seam] as SeamSpec).mode;
  } catch (err) {
    // The caller's rule answer must not depend on the shadow call.
    return skipped(`seam config unreadable: ${(err as Error)?.message ?? String(err)}`);
  }
  if (mode === "enforce") return skipped("configured to enforce; a shadow call cannot act");
  if (inFlight >= MAX_IN_FLIGHT) return skipped(`${inFlight} shadow decisions already in flight`);
  inFlight++;
  return new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => {
      const s = sessionNow();
      return decide(seam, req, {
        modelRegistry: s.modelRegistry,
        model: s.model,
        repoRoot: where.repoRoot ?? s.cwd,
        issues: where.issues,
      });
    })
    .catch((err: unknown) => {
      traceWarn(`decision-shadow: '${seam}' failed: ${(err as Error)?.message ?? String(err)}`);
      return undefined;
    })
    .finally(() => {
      inFlight--;
    });
}
