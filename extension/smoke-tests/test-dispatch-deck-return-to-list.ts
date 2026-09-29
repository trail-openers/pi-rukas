#!/usr/bin/env bun
/**
 * #916 SLICE B (lens round-2) — onRowConfirm's steer-fallthrough must call
 * `opts.onReturnToList` after the steer prompt resolves (a job opened from
 * the agent list returns to the list), and openLiveView must isolate a
 * throwing `onReturnToList` from its own error reporting.
 */

import { onRowConfirm } from "../src/dispatch-deck-confirm.ts";
import { openLiveView } from "../src/dispatch-deck-live-view.ts";
import { startBuffer } from "../src/dispatch-deck-live.ts";
import { clearEntry, reset, snapshot, startEntry } from "../src/dispatch-deck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function rowHost() {
  return { getEntry: (k: string) => snapshot().find((e) => e.key === k), steer: () => {} };
}

function fakeCtx(editors: string[], editorsResolve: string | undefined) {
  return {
    hasUI: true,
    ui: {
      custom: (_f: unknown, _o?: unknown) => Promise.resolve("close" as const),
      editor: (title: string) => {
        editors.push(title);
        return Promise.resolve(editorsResolve);
      },
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof onRowConfirm>[0];
}

// 1. Entry WITHOUT buffer + onReturnToList → steer prompt runs, then
//    onReturnToList is called exactly once (submitted and cancelled both).
{
  reset();
  startEntry("rv-1", { label: "developer", role: "developer" });
  let submittedCalls = 0;
  const editors: string[] = [];
  await onRowConfirm(fakeCtx(editors, "go"), "rv-1", rowHost(), {
    onReturnToList: () => {
      submittedCalls++;
    },
  });
  assert(editors.length === 1, "1a: steer prompt opened (editor called once)");
  assert(submittedCalls === 1, "1b: onReturnToList called once after submitted steer");
  clearEntry("rv-1");

  reset();
  startEntry("rv-2", { label: "explore", role: "explore" });
  let cancelledCalls = 0;
  const editors2: string[] = [];
  await onRowConfirm(fakeCtx(editors2, undefined), "rv-2", rowHost(), {
    onReturnToList: () => {
      cancelledCalls++;
    },
  });
  assert(editors2.length === 1, "1c: cancelled steer prompt still opened");
  assert(cancelledCalls === 1, "1d: onReturnToList called once after cancelled steer");
  clearEntry("rv-2");

  // No-entry, no-buffer no-op branch: nothing was opened → no callback.
  reset();
  let noopCalls = 0;
  const editors3: string[] = [];
  await onRowConfirm(fakeCtx(editors3, "go"), "rv-missing", rowHost(), {
    onReturnToList: () => {
      noopCalls++;
    },
  });
  assert(editors3.length === 0, "1e: no-op branch opens no steer prompt");
  assert(noopCalls === 0, "1f: no-op branch does not call onReturnToList");
  reset();
}

// 2. openLiveView: a throwing onReturnToList must not reject openLiveView
//    (distinct trace; the live-view catch must not swallow it as a view
//    failure — the promise resolves either way).
{
  reset();
  startBuffer("rv-3");
  startEntry("rv-3", { label: "developer", role: "developer" });
  const ctx = {
    hasUI: true,
    ui: {
      custom: (_f: unknown, _o?: unknown) => Promise.resolve("returnToList" as const),
      editor: () => Promise.resolve("steer"),
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof openLiveView>[0];
  let threw = false;
  try {
    await openLiveView(
      ctx,
      "rv-3",
      {
        getEntry: (k) => snapshot().find((e) => e.key === k),
        buildSteerPrompt: () => "",
        steer: () => {},
      },
      {
        onReturnToList: () => {
          throw new Error("list reopen boom");
        },
      },
    );
  } catch {
    threw = true;
  }
  assert(!threw, "2a: throwing onReturnToList does not reject openLiveView");
  clearEntry("rv-3");
  reset();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
