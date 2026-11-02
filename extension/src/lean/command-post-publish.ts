/**
 * Register the lean handlers on the run's handler table, and prime what a step's
 * seam can only answer synchronously.
 *
 * Split from `command.ts` for the 500-line cap. `command.ts` owns the command
 * registration, the `ready` verdict and the phase-1 handler wiring; this file owns
 * the two post-publish steps' wiring, which has one non-obvious line in it and
 * the jsdoc below is the reason it exists.
 */

import { ciDeps } from "./ci-deps.ts";
import { ciOutcome } from "./ci.ts";
import type { HandlerCtx } from "./engine.ts";
import type { LeanHandlers } from "./engine.ts";
import { landDeps } from "./land-deps.ts";
import { primeMergeSubject } from "./land-deps.ts";
import { landOutcome } from "./land.ts";
import { publishDeps } from "./publish-deps.ts";
import { publishOutcome } from "./publish.ts";

/**
 * The `ci` and `land` entries of the handler table, in the same one-line shape as
 * every other step: the step body is the algorithm and `<step>Deps()` is the
 * production wiring, so a test drives them by injecting its own recorder and never
 * touches a PR.
 *
 * `primeMergeSubject` runs here rather than inside `landDeps()` because the
 * `mergeSubject` seam is called SYNCHRONOUSLY from inside the pinned merge call —
 * the forge read that produces the squash subject has to happen while this wiring
 * is still async. It is fire-and-forget on purpose: the subject is prose the
 * changelog reads, and a run must not lose its merge because `gh issue view` was
 * slow or unreachable. Unprimed means `mergeSubject` returns `undefined`, which
 * `prMergeSubjectFlag` renders as NO `--subject` flag — the forge's own default,
 * never a blank subject.
 */
export function ciLandHandlers(repoRoot: string, issue: number): Pick<LeanHandlers, "ci" | "land"> {
  void primeMergeSubject(repoRoot, issue).catch(() => undefined);
  return {
    ci: (ctx: HandlerCtx) => ciOutcome(ctx, ciDeps()),
    land: (ctx: HandlerCtx) => landOutcome(ctx, landDeps()),
  };
}

/**
 * Same for `publish`, so the whole post-specify spine is assembled in one place
 * and `command.ts` keeps only the steps whose deps builders it owns.
 */
export function publishHandler(): Pick<LeanHandlers, "publish"> {
  return { publish: (ctx: HandlerCtx) => publishOutcome(ctx, publishDeps()) };
}
