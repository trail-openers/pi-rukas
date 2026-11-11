/**
 * lib/deck-parent-stub — the dispatch stub behind
 * `test-dispatch-deck-parent.ts` (#2188 ticket A), split out at AGENTS.md §12's
 * 500-line cap along the seam the gate already had: this file is the RIG (what
 * a fake research child is), the test file is the CLAIMS.
 *
 * The one thing the split must not lose is that every child goes through the
 * REAL `dispatchCore`. `setResearchDispatch` replaces `dispatchCore` wholesale
 * (research-driver.ts's `_dispatchOverride ?? dispatchCore`), so a stub that
 * called `startJob` itself would register the deck row from its OWN arguments
 * and stay green with the `opts → startJob` forwarding line deleted. Forwarding
 * to the real `dispatchCore` under `setupSpawnGuard()` makes that hop executed
 * evidence: the deck row is registered synchronously inside `startJob`, before
 * the spawn guard rejects the child.
 */

import * as dispatchDeck from "../../src/dispatch-deck.ts";
import { dispatchCore } from "../../src/dispatch.ts";
import type { ResearchDispatchFn } from "../../src/research-driver.ts";

/** One child the pipeline dispatched, as the stub observed it. */
export interface Child {
  /** The label the pipeline ASKED for, before any clipping. The angle dispatch
   *  site clips to 24 chars, so `research-adoption-alternatives` reaches the
   *  deck row as `research-adoption-altern` — the population is asserted on the
   *  requested name, the row on the clipped one. */
  requested: string;
  /** The label the deck row got (the real dispatchCore's `opts.label ?? role`). */
  rowLabel?: string;
  /** The jobId the deck held for THIS leg, decided synchronously as its row
   *  appeared (see `claimOwnRow`); "" when no row was registered. */
  jobId: string;
  parentKey?: string;
  /** The opts object the real dispatchCore received — proof of the hop. */
  optsSeen: Record<string, unknown>;
  /** The parentKey the DECK row carried, read off the deck at the moment the
   *  row was sighted (not off the stub's opts record) — see rowSeen. */
  rowParentKey?: string | null;
  /** True when the deck row carried no batchKey — asserted per child because a
   *  parent link must not drag a batch grouping along with it. */
  rowBatchKeyAbsent: boolean;
  /** Resolves the instant this child's own deck row is sighted in a snapshot.
   *  The row is created synchronously by the real startJob and erased when the
   *  child's work settles (the settle path's clearEntry), so under the spawn
   *  guard the window is short and its timing is not the contract — the gate
   *  waits for ONE sighting rather than mistaking "already cleared" for "never
   *  registered". */
  rowSeen: Promise<boolean>;
}

/** One schema-valid `report_research_claim` toolUse. The pipeline's fail-closed
 *  rule (D8) halts the whole run when an angle produced no structured claim,
 *  and the spawn guard means no angle ever can — so the stub fabricates the
 *  population every later phase reads. */
export function claimToolUse(angle: string, n: number): unknown {
  return {
    name: "report_research_claim",
    arguments: {
      kind: "finding",
      text: `Verified behaviour ${n} of the topic (${angle})`,
      source: "https://example.com/spec",
      sourceKind: "url",
      confidence: "high",
      staleness: "stable",
      angle,
    },
  };
}

/** Settle messages (guard rejections) of the children seen so far. */
const pendingRows: Promise<string>[] = [];

/** The child population the installed stub has been asked to dispatch.
 *
 *  A re-dispatch is a FULL second child (`research-driver.ts` re-runs
 *  `runResearchAngle`, so the #773 fallback leg gets its own entry with its
 *  own deck row) — which is why the fallback leg is asserted off this list
 *  rather than excluded from it: the driver builds the angle's `ctx` ONCE and
 *  hands the same object to both legs, so a shared-ctx threading defect is
 *  exactly as visible on the second entry as on the first, and only a leg
 *  nobody ever dispatched would be invisible here.
 */
const observed: Child[] = [];

/** The row a leg owns: the fields the gate reads off the deck, captured at the
 *  moment the row was sighted — not off the stub's recollection of what it was
 *  handed. `undefined` means the window closed without a sighting. */
interface RowEvidence {
  parentKey: string | null;
  batchKeyAbsent: boolean;
}

/** How many polls a sighting waits for. One child is a guard rejection a
 *  microtask away, so the window is short by design; the bound only has to
 *  outlast `dispatchCore`'s own async prelude. */
const ROW_POLL_TRIES = 200;

/**
 * Watch for the row `call()` registers, and read its evidence the instant it is
 * sighted. The returned `key` is this leg's row, decided SYNCHRONOUSLY.
 *
 * `startJob` registers the deck row synchronously, before any of its own awaits,
 * and a synchronous call cannot interleave — so the row that exists immediately
 * after `call()` returns and did not exist before it is the caller's own row,
 * and no sibling of a `Promise.all` fan-out can answer for it. Both alternatives
 * are unsound: "the last row with my role" is identification BY POSITION, which
 * the fan-out shares (two legs see the same last row, one row is never claimed,
 * and the gate reports a deck that "never held the row" for a link that was
 * there); and subtracting the PRE-DRIVE population fails because a sibling's job
 * settles — the guard rejects it synchronously — while this leg is still in
 * flight, so its id has already left the live set and the one leftover of a set
 * difference goes to whoever asks first.
 *
 * The row is then POLLED, not read once: `startJob`'s settle path clears it on
 * the guard rejection, so a single read after an await would mistake "already
 * cleared" for "never registered".
 */
function claimOwnRow(call: () => void): {
  key: string;
  evidence: Promise<RowEvidence | undefined>;
} {
  const before = new Set(dispatchDeck.snapshot().map((e) => e.key));
  call();
  const key = dispatchDeck.snapshot().find((e) => !before.has(e.key))?.key ?? "";
  const evidence = (async () => {
    if (key === "") return undefined;
    for (let tries = 0; tries < ROW_POLL_TRIES; tries++) {
      const row = dispatchDeck.snapshot().find((e) => e.key === key);
      if (row) {
        return {
          parentKey: row.parentKey === undefined ? null : row.parentKey,
          batchKeyAbsent: row.batchKey === undefined,
        };
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    return undefined;
  })();
  return { key, evidence };
}

/** Install the stub for one drive: the observed population and the pending
 *  settle messages start empty.
 *
 *  `failAngles` name the ANGLE NAMES (the `a.name` the pipeline assigns, which
 *  is what the child label `research-${a.name}` is built from — not the
 *  caller-visible, possibly 24-char-clipped label). A retrieval child for one
 *  of those angles answers with zero claims and the verbatim `Insufficient
 *  credit` anchor, which classifies as `credit-exhausted` and drives the
 *  driver's #773 wigolo re-dispatch — the FOURTH dispatch leg, default-ON.
 *  That leg is the one a stub that only ever returned success could never
 *  reach, and its deck row is claimed and asserted exactly like every other
 *  child's.
 *
 *  The entailment / memo-synthesis children are NOT in scope for `failAngles`
 *  and need no guard here: their labels are fixed strings that no angle name
 *  matches, and `angle` is derived from the label, so a failure injection can
 *  only ever reach a retrieval leg — which is what keeps the deep tier's
 *  CLAIM-SUPPORT verdict coming from a real dispatch rather than from an
 *  injected failure.
 */
export function installResearchDispatchStub(failAngles: readonly string[] = []): void {
  observed.length = 0;
  pendingRows.length = 0;
  // Typed as the seam's own function type (not `as never`): an untyped stub
  // would make a mis-named or missing parentKey invisible to the type-checker,
  // the exact hole this ticket's own tsconfig entry exists to close.
  const stub: ResearchDispatchFn = async (_pi, spec, opts = {}) => {
    const seen: Record<string, unknown> = { ...opts };
    const requested = opts.label ?? spec.label ?? "";
    const angle = /^research-(.+)$/.exec(requested)?.[1] ?? "web-current";
    // A clipped label still identifies its angle: `research-adoption-altern`
    // is the `adoption-alternatives` angle, so match either direction.
    const legFails = failAngles.some(
      (f) => angle === f || f.startsWith(angle) || angle.startsWith(f),
    );
    const mine: Child = {
      requested,
      rowLabel: spec.label,
      jobId: "",
      parentKey: opts.parentKey,
      optsSeen: seen,
      rowParentKey: undefined,
      rowBatchKeyAbsent: false,
      rowSeen: Promise.resolve(false),
    };
    observed.push(mine);
    // The REAL dispatchCore under the spawn guard (the test-dispatch-deck-driver.ts
    // pattern): its startEntry is the row this gate observes, and the guard's
    // rejection is the executed evidence that the hop ran. Its own result is
    // discarded: under the guard it can only reject.
    let childRow: Promise<string> | undefined;
    const row = claimOwnRow(() => {
      childRow = dispatchCore(_pi, spec, opts).then(
        () => "resolved",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    });
    mine.jobId = row.key;
    mine.rowSeen = row.evidence.then((evidence) => {
      if (evidence === undefined) return false;
      mine.rowParentKey = evidence.parentKey;
      mine.rowBatchKeyAbsent = evidence.batchKeyAbsent;
      return true;
    });
    if (childRow) pendingRows.push(childRow);
    return {
      role: spec.role,
      ok: true,
      // Two shapes, split by the label the caller sees: an entailment reviewer
      // answers CLAIM-SUPPORT lines, a retrieval/synthesis child answers claims.
      // A single text for both would either leave the deep tier with nothing to
      // entail (so no entailment child is ever dispatched, and the assertion
      // about it would be about a pass that never ran) or leave the adoption
      // memo empty.
      text: requested.includes("entailment")
        ? "CLAIM-SUPPORT: 1 — full\nCLAIM-SUPPORT: 2 — full\nchecked both."
        : requested.includes("memo-synthesis")
          ? "RECOMMENDATION:\nAdopt with conditions: wait out the 4-day embargo.\n\nCOMPARISON:\n| candidate | weekly |\n"
          : legFails
            ? // The verbatim anchor `classifyParallelOutcome` reads (see
              // research-fallback.ts): anything else classifies as
              // `unparseable` and the selector keeps it on parallel, so the
              // fallback leg would never be dispatched and the assertion
              // about it would be about a run that never ran.
              "parallel run died: Insufficient credit"
            : "summary of what was established",
      toolUses: requested.includes("entailment") || legFails ? [] : [claimToolUse(angle, 1), claimToolUse(angle, 2)],
      ms: 1,
      exitCode: 0,
    };
  };
  setResearchDispatch(stub);
}

// Imported last so the stub's own module loads the seam it replaces.
import { setResearchDispatch } from "../../src/research-driver.ts";

/** The children the installed stub has dispatched — the population the gate
 *  asserts on. */
export function observedChildren(): Child[] {
  return observed;
}

/** Each child's settle message, in dispatch order: every one of them must name
 *  the spawn guard, which is what proves the deck row came from the real
 *  `dispatchCore` rather than from a stub that called `startJob` itself. */
export async function settleMessages(): Promise<string[]> {
  return Promise.all(pendingRows);
}
