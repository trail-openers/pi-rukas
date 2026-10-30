/**
 * lean/build-errors — the failure type the build step throws.
 *
 * Its own module so `build-git.ts` and `build-capture.ts` can both refuse a
 * tree without importing the orchestrator that owns them: an import cycle here
 * would be the only reason the three could not be read on their own. The
 * engine turns this class into exit 10, which is what distinguishes "the tree
 * or the child is broken" from "the developer's work did not pass" — the latter
 * is an `Outcome`, never a throw.
 */

import type { DispatchUsageRow } from "./step-budget.ts";

/** A tree, a child or a commit this step cannot trust. The engine makes it 10. */
export class BuildInfraError extends Error {
  override readonly name = "BuildInfraError";

  /**
   * The cost rows this failure already observed, when it knows them.
   *
   * A dispatch that died spent its tokens, and the step's throw is the only
   * place that child's row exists — the outcome never lands, so the rows travel
   * on the error and the caller can decide whether they are worth recording.
   */
  readonly dispatches?: DispatchUsageRow[];

  constructor(message: string, dispatches?: DispatchUsageRow[]) {
    super(message);
    if (dispatches !== undefined) this.dispatches = dispatches;
  }
}
