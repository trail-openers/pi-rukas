/**
 * /work workflow state — the unfinished-develop fragment (#1768).
 *
 * An OPTIONAL field on the existing `branch-completed` event, added as its own
 * fragment module rather than inline in `workflow-state-events.ts` (which sits
 * at the AGENTS.md §12 line cap, where an inline addition would push a second
 * event kind's documentation past it). Same seam as
 * `workflow-state-events-deferred.ts` / `workflow-state-events-crash` (the
 * `crash` fragment in `work-develop-crash.ts`): the composed union references
 * the fragment by name, the union stays exhaustive, and readers that predate
 * the field ignore it.
 *
 * The record is about a DIFFERENT failure than `crash`. A crash is a child
 * whose engine died; this is a child that exited 0, said so, and left its step
 * unfinished — the console pair orchard #439/#507 recorded:
 *
 *   `work-driver: safety net firing for default — 6 uncommitted path(s)`
 *   `agent done: developer in 142s` beside `… docs section + test/review_test.sh
 *   remain, then the gate. Continuing.`
 *
 * `absent` is a real state, never synthesised: a pass that committed its own
 * work carries no fragment, exactly as a pass that did not crash carries no
 * `crash`.
 */
export type DevelopUnfinishedFragment = {
  /** How the tree was read at classify time.
   *
   * - `dirty` — the pass reported ok, had NO commit of its own ahead of base,
   *   and left work in the tree. The defect the safety net used to paper over.
   * - `unreadable` — the tree or the commit count could not be read, so the
   *   driver cannot claim the pass finished. Never read as clean. */
  tree: "dirty" | "unreadable";
  /** The pass's own uncommitted paths (bounded; driver artefacts excluded).
   *  Named on the `dirty` reading; absent when the tree could not be read. */
  paths?: string[];
  /** Why the pass is not done — the same sentence the verdict carries. */
  reason: string;
};
