/**
 * lean/build-errors — the failure type the build step throws.
 *
 * Its own module so `build-git.ts` and `build-capture.ts` can refuse a tree
 * without importing the orchestrator that owns them. The engine turns this class
 * into exit 10 — "the tree or the child is broken", as distinct from work that
 * did not pass, which is an `Outcome`, never a throw.
 */
import type { DispatchUsageRow } from "./step-budget.ts";

/** A tree, a child or a commit this step cannot trust. The engine makes it 10. */
export class BuildInfraError extends Error {
  override readonly name = "BuildInfraError";

  /**
   * The cost rows this failure already observed, when it knows them. A dispatch
   * that died spent its tokens and the outcome never lands, so the rows travel
   * on the error for the caller to record.
   */
  readonly dispatches?: DispatchUsageRow[];

  constructor(message: string, dispatches?: DispatchUsageRow[]) {
    super(message);
    if (dispatches !== undefined) this.dispatches = dispatches;
  }
}
