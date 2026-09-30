/**
 * work-driver-deck-header — the per-cycle dispatch-deck header (#838).
 *
 * A /work cycle gets ONE batch header row ("⏳ batch[/work #42]") under
 * which all of the cycle's driver dispatches render as members (see
 * dispatchCore's `deck` option). The header is a counter-less batch row:
 * the driver's children are independent step dispatches, not a fixed-size
 * fan-out, so a done/total counter would be noise — `size: 0` is the
 * counter-less marker (dispatch-deck-rows `formatBatchRow` omits the
 * counter for a size-0 batch).
 *
 * Ownership token: the header key ("work:<issue>") is per-issue, so a
 * second cycle on the same issue (a resumed run + a fresh `/work N`)
 * would both claim it. The token maps header-key → cycle-owner; only the
 * cycle that created the header clears it — a cycle that found the key
 * already present (headerPresent: true) never clears it, so a concurrent
 * cycle's live header is never vacated by a finishing sibling.
 *
 * Quiet mode: `startBatchEntry` and `clearBatchEntry` are quiet-gated
 * inside the deck module (startBatchEntry is a no-op; clearBatchEntry on an
 * absent key returns without doing anything — release deletes the owner
 * entry from the `owners` map, and the deck-level clear is a no-op), so
 * header + members (both quiet-gated at their own call sites) are
 * suppressed atomically — a quiet session never gets a header whose members
 * are missing, nor orphans (the orphan-member contract in
 * dispatch-deck-rows.ts renders a batchKey-less-or-orphan entry as a
 * standalone row; with the header absent a quiet session has no members
 * either, so no orphan renders).
 */

import { clearBatchEntry, startBatchEntry } from "./dispatch-deck.ts";
import { trace } from "./trace.ts";

/** header-key → cycle-owner token. */
const owners = new Map<string, string>();

// #838 lens fix — the deck header's ownership token must be unique PER
// INVOCATION, not per process: two concurrent /work cycles in one Pi process
// (a tool-started cycle + a slash-command cycle, or grouped cycles) share
// `process.pid`, and a pid-keyed token would let one cycle's release clear
// the other's live header. A module counter + pid gives each invocation its
// own token; the pid keeps tokens from colliding across processes (where the
// counter restarts at zero).
let headerTokenSeq = 0;
/** Mint a fresh per-invocation header-ownership token (pid + counter). */
export function headerToken(): string {
  return `pid:${process.pid}:${++headerTokenSeq}`;
}

/** The cycle's header key — "work:<issue>". Exported so the dispatch
 *  seam (driverDeckOpts) and the release path share one spelling. */
export function workDeckKey(issue: number): string {
  return `work:${issue}`;
}

/**
 * Claim the cycle's deck header. Returns a release function that clears
 * the header on EVERY terminal path (the caller wraps the cycle body in
 * try/finally). Idempotent per owner: a cycle that re-enters (a resumed
 * run claiming the same key) gets back its own token, not a fresh one.
 *
 * When the key is already claimed by another owner (a concurrent cycle
 * on the same issue), the header is NOT created and the returned release
 * is a no-op — this cycle's members still render (the deck's orphan
 * contract renders a batchKey-named entry standalone when the header is
 * absent — the row still shows, just ungrouped), and this cycle never
 * clears the sibling's header.
 */
export function acquireWorkDeckHeader(
  issue: number,
  ownerToken: string,
): { headerPresent: boolean; release: () => void } {
  const key = workDeckKey(issue);
  const existing = owners.get(key);
  if (existing !== undefined && existing !== ownerToken) {
    trace(
      `work-driver: deck header ${key} held by cycle ${existing}; this cycle's rows render standalone`,
    );
    return { headerPresent: true, release: () => undefined };
  }
  // The owner is this cycle (first claim, or a re-entry with its own token —
  // the header was already created by this same owner, so no re-create).
  const firstClaim = existing === undefined;
  owners.set(key, ownerToken);
  if (firstClaim) {
    // Counter-less batch header (size 0 — formatBatchRow omits the
    // done/total counter; see the module header for the rationale).
    startBatchEntry(key, { label: `/work #${issue}`, size: 0 });
  }
  return {
    headerPresent: true,
    release: () => {
      if (owners.get(key) !== ownerToken) return; // not ours — never clobber
      owners.delete(key);
      clearBatchEntry(key);
    },
  };
}

/**
 * #838 — the deck option for a driver dispatch: the cycle header key
 * (batchKey) plus the per-dispatch row label. The label is
 * `#<issue> <step> · <workstream|role>` — the workstream id for a
 * per-workstream develop dispatch, the dispatch's own label otherwise
 * (so `explore:speculative[ws]` keeps its existing tag shape). The deck
 * row is display-only (startJob's `deckLabel`): the job's own label —
 * what the driver's events and the cap checkpoint's `developer[<id>]`
 * parse see — is the caller's `label`.
 */
export function driverDeckOpts(
  issue: number,
  step: string,
  tag: string,
): { cycleKey: string; label: string; deckLabel?: string } {
  const label = `#${issue} ${step} · ${tag}`;
  return { cycleKey: workDeckKey(issue), label, deckLabel: label };
}
