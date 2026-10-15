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
 *     acted-on one — such a call is refused and traced.
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

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SEAMS, type SeamId, type SeamSpec, seamConfig } from "./decision-seam-registry.ts";
import { type DecideRequest, type Decision, type DecisionWhere, decide } from "./decision-seam.ts";
import { traceWarn } from "./trace.ts";

type SessionCtx = Pick<ExtensionContext, "modelRegistry" | "model" | "cwd">;

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
  } catch {
    return {};
  }
}

/**
 * Bound one free-text field of a seam's state. The state goes to a model, so
 * a caller passes only what the question needs, never a whole transcript.
 */
export function boundText(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
  const spec: SeamSpec = SEAMS[seam];
  if (seamConfig(spec).mode === "enforce") {
    traceWarn(
      `decision-shadow: '${seam}' is configured to enforce; a shadow call cannot act, skipped`,
    );
    return Promise.resolve(undefined);
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    traceWarn(`decision-shadow: ${inFlight} shadow decisions in flight; '${seam}' dropped`);
    return Promise.resolve(undefined);
  }
  inFlight++;
  return new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => {
      const s = sessionNow();
      return decide(seam, req, {
        modelRegistry: s.modelRegistry,
        model: s.model,
        repoRoot: where.repoRoot ?? s.cwd,
        issues: where.issues,
        timeoutMs: where.timeoutMs,
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
