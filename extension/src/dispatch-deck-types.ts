/**
 * dispatch-deck-types — the deck's row contract, as a leaf.
 *
 * `DeckEntry` and `StartEntryOpts` are the two shapes every writer and reader
 * of the live deck shares. They are extracted from dispatch-deck.ts at the
 * AGENTS.md §12 / `test-file-size-limit.ts` 500-line cap: the deck module
 * carries the widget, the nav listener, the ticker and the render paths, and
 * the entry that threads a parent link onto a row would be the line that
 * pushed it over. dispatch-deck.ts RE-EXPORTS both from here, so every
 * existing import site keeps its path — the guarantee is the re-export, not
 * an importer count.
 *
 * This module is a LEAF: it imports only types that live elsewhere in the
 * type layer (progress.ts's RunningState), never from dispatch-deck.ts.
 */
import type { RunningState } from "./progress.ts";

/** One live row in the dispatch deck / agent list. */
export interface DeckEntry {
  key: string;
  label: string;
  state: RunningState;
  seq: number;
  startedAt: number;
  batchKey?: string;
  /**
   * The jobId of the job that dispatched this one — the deck's parent link.
   * Set by `startEntry` from the caller's `parentKey`, which the dispatch
   * layer threads from `dispatchCore`'s opts (the async job's own id, as the
   * tool-level pipelines receive it in `WorkHooks.jobId`).
   *
   * Deck-only: the link never reaches the child process (no spawn arg, env
   * var or prompt), so a subagent never sees it. Absent for a top-level
   * dispatch — never an empty string, never the child's own key. Consumers
   * that project a row explicitly (dispatch-peek's serialise, the agent
   * list's row builder) do NOT read it: adding it changes no rendered text.
   */
  parentKey?: string;
}

/** What a caller of `startEntry` supplies for a new row. */
export interface StartEntryOpts {
  label: string;
  role: string;
  tag?: string;
  batchKey?: string;
  /** Deck parent link — see DeckEntry.parentKey. */
  parentKey?: string;
}
