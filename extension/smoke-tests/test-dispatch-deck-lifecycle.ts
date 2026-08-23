#!/usr/bin/env bun
/**
 * Dispatch-deck batch/lifecycle unit tests (#117 / #139 / #141), split out
 * of test-dispatch-deck.ts (#171, AGENTS.md §12 file-size limit):
 *  - batch entry lifecycle: start → updateBatchProgress → clear
 *  - formatBatchRow shape
 *  - snapshot() vs batchSnapshot() separation
 *  - ticker lifecycle (single entries and batch-only)
 *  - PI_ENSEMBLE_QUIET_STATUS=1 short-circuits everything
 *  - detach removes the widget
 */

import {
  attach,
  batchSnapshot,
  clearBatchEntry,
  clearEntry,
  detach,
  formatBatchRow,
  isTicking,
  reset,
  snapshot,
  startBatchEntry,
  startEntry,
  updateBatchProgress,
  updateEntry,
} from "../src/dispatch-deck.ts";
import { type RunningState, emptyRunningState } from "../src/progress.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeState(role: string, opts: Partial<RunningState> = {}): RunningState {
  const base = emptyRunningState(role);
  return { ...base, ...opts, usage: { ...base.usage, ...(opts.usage ?? {}) } };
}

interface WidgetCall {
  key: string;
  content: string[] | ((tui: unknown, theme: unknown) => unknown) | undefined;
  options?: { placement?: string };
}

function fakeCtx(): { calls: WidgetCall[]; ctx: Parameters<typeof attach>[0] } {
  const calls: WidgetCall[] = [];
  const ctx = {
    ui: {
      setWidget: (
        key: string,
        content: WidgetCall["content"],
        options?: { placement?: string },
      ) => {
        calls.push({ key, content, options });
      },
      // setStatus retained for type compatibility but not used by the deck anymore.
      setStatus: (_key: string, _text: string | undefined) => {},
    },
  } as unknown as Parameters<typeof attach>[0];
  return { calls, ctx };
}

// 13. Batch entry lifecycle (#139).
{
  reset();
  startBatchEntry("batch-x", { label: "explore×3", size: 3 });
  assert(batchSnapshot().length === 1, "startBatchEntry adds one batch row");
  assert(batchSnapshot()[0]?.completed === 0, "batch starts at 0 completed");
  updateBatchProgress("batch-x", 1);
  assert(batchSnapshot()[0]?.completed === 1, "updateBatchProgress advances completed");
  updateBatchProgress("batch-x", 0);
  assert(batchSnapshot()[0]?.completed === 1, "updateBatchProgress doesn't regress");
  updateBatchProgress("batch-x", 3);
  assert(batchSnapshot()[0]?.completed === 3, "updateBatchProgress reaches size");
  clearBatchEntry("batch-x");
  assert(batchSnapshot().length === 0, "clearBatchEntry removes the row immediately");
}

// 14. formatBatchRow shape (#139).
{
  const startedAt = 7_000_000;
  const fresh = formatBatchRow(
    { key: "b", label: "explore×3", size: 3, completed: 0, seq: 0, startedAt },
    startedAt + 5000,
  );
  assert(fresh.startsWith("⏳ batch["), "batch row starts with hourglass and batch[…]");
  assert(fresh.includes("explore×3"), "row includes the batch label");
  assert(fresh.includes("0/3 done"), "row shows 0/3 done early on");
  assert(fresh.includes("3 running"), "row shows running count when any remain");

  const partial = formatBatchRow(
    { key: "b", label: "explore×3", size: 3, completed: 1, seq: 0, startedAt },
    startedAt + 60_000,
  );
  assert(partial.includes("1/3 done"), "after one finishes: 1/3 done");
  assert(partial.includes("2 running"), "after one finishes: 2 running");

  const finished = formatBatchRow(
    { key: "b", label: "explore×3", size: 3, completed: 3, seq: 0, startedAt },
    startedAt + 90_000,
  );
  assert(finished.includes("3/3 done"), "all done: 3/3 done");
  assert(!finished.includes("running"), "all done: no 'running' suffix");
}

// 15. snapshot() excludes batch entries — dispatch_peek consumes this.
{
  reset();
  startEntry("member-a", { label: "explore[task-A]", role: "explore" });
  startBatchEntry("batch", { label: "explore×3", size: 3 });
  startEntry("member-b", { label: "explore[task-B]", role: "explore" });
  const singles = snapshot();
  assert(singles.length === 2, "snapshot() returns only single entries (no batch)");
  assert(
    singles.every((e) => e.key !== "batch"),
    "snapshot() never includes the batch row",
  );
  assert(batchSnapshot().length === 1, "batchSnapshot() returns the batch row");
}

// 16. Ticker lifecycle.
{
  reset();
  assert(!isTicking(), "ticker is not armed when no entries");
  startEntry("a", { label: "developer", role: "developer" });
  assert(isTicking(), "ticker arms when first entry registers");
  clearEntry("a");
  assert(!isTicking(), "ticker stops when last entry drains");
  startBatchEntry("bonly", { label: "explore×2", size: 2 });
  assert(isTicking(), "ticker arms for a batch-only state");
  clearBatchEntry("bonly");
  assert(!isTicking(), "ticker stops when the batch row clears with no singles left");
}

// 17. PI_ENSEMBLE_QUIET_STATUS=1 short-circuits start/update.
{
  reset();
  process.env.PI_ENSEMBLE_QUIET_STATUS = "1";
  startEntry("muted", { label: "developer", role: "developer" });
  updateEntry("muted", makeState("developer", { elapsedMs: 9000 }));
  startBatchEntry("muted-b", { label: "developer×2", size: 2 });
  assert(snapshot().length === 0, "quiet env var prevents single entry registration");
  assert(batchSnapshot().length === 0, "quiet env var prevents batch entry registration");
  delete process.env.PI_ENSEMBLE_QUIET_STATUS;
  startEntry("audible", { label: "developer", role: "developer" });
  assert(snapshot().length === 1, "deck resumes when env var unset");
}

// 18. detach removes the widget.
{
  reset();
  const { calls, ctx } = fakeCtx();
  attach(ctx);
  startEntry("a", { label: "developer", role: "developer" });
  await new Promise((r) => setImmediate(r));
  detach();
  const last = calls[calls.length - 1];
  assert(last?.content === undefined, "detach calls setWidget(key, undefined)");
  assert(snapshot().length === 0, "detach drains entries");
  assert(batchSnapshot().length === 0, "detach drains batches");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
