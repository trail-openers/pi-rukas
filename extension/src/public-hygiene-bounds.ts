/**
 * public-hygiene-bounds — the wall clocks the public-repository guard puts on
 * the reads it does not own (#1788, #1792 final round), split out of
 * `public-hygiene-guard.ts` along the seam AGENTS.md §12 asks for: the guard
 * owns the decision, this module owns how long the guard is willing to wait for
 * the answers it did not produce itself.
 *
 * ## Why every read here is bounded
 *
 * Each of these reads goes through a seam the CALLER supplies — an `ExecFn` for
 * git, an injected `remoteUrl` for a repository name, a `VisibilityFn` for the
 * private question. None of them is obliged to answer, and the guard runs inside
 * a `tool_call` hook: a read that never settles hangs the agent's whole turn.
 * A guard that hangs a session is a guard an operator disables, and the escape
 * hatch switches off the check that matters. So the bound is not politeness
 * toward a slow git, it is the guard's own survival.
 *
 * ## The two bounds mean DIFFERENT things, which is why they are two functions
 *
 * - {@link boundedScan} over the push scan: an unfinished scan is an UNREADABLE
 *   range. The caller records a problem and refuses, because "could not tell" is
 *   never "clean".
 * - {@link boundedTarget} over target resolution: an unfinished lookup is simply
 *   NO NAME, which the caller reads as "no positive private answer, so check the
 *   text". It is not a problem and it is not a refusal — the checks below the
 *   target gate run either way, which is the fail-closed direction (a wrong guess
 *   costs a checked private repository, never a leak).
 *
 * Collapsing them into one helper would make one of the two wrong: a shared
 * "undefined means unreadable" would refuse every push of a role that pushes all
 * day for a reason unrelated to hygiene, and "undefined means no name" would let
 * a hung git publish a dirty commit message.
 *
 * ## The trace lines
 *
 * Both trace what the guard could not do and what it is doing about it, and
 * neither prints anything the read might have carried: an exec or resolver error
 * can name a path or a repository that IS the private thing this guard exists to
 * keep out of a transcript.
 */

import { type Target, resolveCommandTarget } from "./public-hygiene-target.ts";
import type { PushScanResult } from "./public-hygiene-types.ts";
import { VISIBILITY_TIMEOUT_MS } from "./public-hygiene-visibility.ts";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * How long the guard will wait for a repository name.
 *
 * The visibility question's own constant is the number to reuse: target
 * resolution and the visibility question are the same class of read — one
 * forge-ish command, answered or not — and two numbers would be two knobs that
 * can disagree about how long a `tool_call` may take. Importing it rather than
 * restating `10_000` keeps one literal.
 *
 * A caller may lower it per call through {@link boundedTarget}'s `ms` parameter,
 * floored at {@link TARGET_RESOLVE_TIMEOUT_FLOOR_MS}, which is what lets the
 * offline suite pin the timeout-is-a-verdict path in milliseconds rather than ten
 * seconds of wall clock. Nothing in production sets it; the floor is what stops a
 * typo from making the bound a no-op AND from turning the guard into a gate that
 * skips its own checks under a name an operator would not recognise.
 *
 * Read ONCE at module load, like every other constant here — the per-call `ms`
 * parameter is the supported way to vary it.
 */
/**
 * The env override's name, in one place so the test and this file agree.
 *
 * DECLARED BEFORE {@link TARGET_RESOLVE_TIMEOUT_MS} on purpose: the const below
 * evaluates that reader at module load, and a `const` declared after it is in
 * the temporal dead zone at that moment — which made every importer of this
 * module throw `Cannot access ... before initialization`. A module whose bound
 * is computed at load must declare its inputs first.
 */
export const TARGET_RESOLVE_TIMEOUT_ENV = "PI_ENSEMBLE_PUBLIC_TARGET_TIMEOUT_MS";

/** The floor on the test override, so a mis-set bound cannot quietly disable it. */
const TARGET_RESOLVE_TIMEOUT_FLOOR_MS = 1_000;

function targetResolveTimeoutMs(): number {
  const raw = Number(process.env[TARGET_RESOLVE_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw >= TARGET_RESOLVE_TIMEOUT_FLOOR_MS
    ? Math.floor(raw)
    : VISIBILITY_TIMEOUT_MS;
}

export const TARGET_RESOLVE_TIMEOUT_MS = targetResolveTimeoutMs();

/**
 * Run the push scan under the guard's own wall clock. Resolves to `undefined`
 * ("the scan did not finish") rather than throwing, because the caller's
 * decision for a scan that never finished is the same as for one that failed: an
 * unreadable range is never a clean one.
 */
export async function boundedScan(
  ms: number,
  work: () => Promise<PushScanResult>,
): Promise<PushScanResult | undefined> {
  return underDeadline(ms, () => work());
}

/**
 * The repository this surface writes to, or `undefined` when it could not be
 * named within {@link TARGET_RESOLVE_TIMEOUT_MS}. `undefined` is the unknown
 * target, not an error: the caller has no positive private answer and therefore
 * checks. A resolver that throws is the same absence of a name as one that hung.
 */
/**
 * The repository this surface writes to, or `undefined` when it could not be
 * named within `ms`. `undefined` is the unknown target, not an error: the caller
 * has no positive private answer and therefore checks. A resolver that throws is
 * the same absence of a name as one that hung.
 *
 * `ms` defaults to {@link TARGET_RESOLVE_TIMEOUT_MS} but is a parameter because
 * the bound is what this module's reason for existing is: a caller (or a test)
 * that must prove the deadline produces a verdict rather than a hang asks the
 * question with its own number, rather than reaching into `process.env` and
 * hoping the module has not been loaded yet.
 */
export async function boundedTarget(
  command: string,
  cwd: string,
  exec: ExecFn | undefined,
  remoteUrl: ((name: string, dir: string) => Promise<string>) | undefined,
  pushVerb: string | undefined,
  ms: number = TARGET_RESOLVE_TIMEOUT_MS,
): Promise<Target | undefined> {
  const resolved = await underDeadline(ms, () =>
    resolveCommandTarget(command, cwd, exec, { pushVerb, remoteUrl }).catch(() => undefined),
  );
  if (resolved === undefined) {
    // Traced, and it says the operative fact: the guard could not name the
    // repository, so it is checking the text rather than skipping it. The reason
    // is a category (timeout or failure), never the error, which may carry a path.
    trace(
      `public-hygiene: the target repository could not be resolved within ${ms} ms — treating the target as unknown and checking`,
    );
  }
  return resolved;
}

/** The one race both bounds share: resolve `work`, or `undefined` at `ms`. */
async function underDeadline<T>(ms: number, work: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
