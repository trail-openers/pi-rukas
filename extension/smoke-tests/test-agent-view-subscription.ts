#!/usr/bin/env bun
/**
 * #915 block 12 — openLiveView: single-subscription guarantee
 * (open → append → close).
 *
 * before: test-agent-view-steer-loop.ts tested the steer re-open loop /
 * after: the loop is retired; the single-subscription guarantee is
 * tested here (#915).
 */

import { dropBuffer, feedRawEvent, startBuffer } from "../src/dispatch-deck-live.ts";
import { openLiveView } from "../src/dispatch-deck-live-view.ts";
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

{
  dropBuffer("iv12");
  reset();
  startBuffer("iv12");
  startEntry("iv12", { label: "developer", role: "developer" });
  let n = 0,
    rc = 0,
    d = -1;
  const ctx = {
    ui: {
      custom: (f: (t: unknown) => unknown) => {
        n++;
        const t = {
          requestRender: () => {
            rc++;
          },
        };
        f(t);
        if (n === 1) {
          const b = rc;
          feedRawEvent("iv12", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "x" }] },
          });
          d = rc - b;
        }
        return Promise.resolve("returnToList" as const);
      },
      setWidget: () => {},
      getEditorText: () => "",
      onTerminalInput: () => () => {},
    },
  } as unknown as Parameters<typeof openLiveView>[0];
  const p = openLiveView(ctx, "iv12", {
    getEntry: (k) => snapshot().find((e) => e.key === k),
  });
  for (let i = 0; n < 1 && i < 200; i++) await new Promise((r) => setTimeout(r, 10));
  assert(n === 1, "12a: custom called once (no re-open loop)");
  assert(d === 1, `12b: one append → one render (got ${d})`);
  await p;
  const after = rc;
  feedRawEvent("iv12", {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "y" }] },
  });
  assert(rc === after, "12c: no render after close");
  clearEntry("iv12");
  dropBuffer("iv12");
  reset();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
