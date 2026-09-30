#!/usr/bin/env bun
/**
 * #838 — driver deck: steer + agent-list tests (companion to
 * test-dispatch-deck-driver.ts, extracted for the 500-line gate).
 *
 * Sections 5 (steer to a driver-shaped job) and 6 (agent-list projection).
 */

import { childHandles } from "../src/async-jobs-registry.ts";
import { buildAgentListLines } from "../src/agent-list.ts";
import { steerFromDeck } from "../src/dispatch-deck-interactive.ts";
import * as dispatchDeck from "../src/dispatch-deck.ts";
import { steerChild } from "../src/dispatch-steer.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 5. Steer to a driver-shaped job: steerChild/steerFromDeck deliver to the
//    child's stdin with the {type:'steer', message} envelope, tagged
//    source "deck-ui" (the deck-UI steer path's lifecycle tag).
{
  const lines: string[] = [];
  const fakeStdin = {
    write(s: string) {
      lines.push(s);
    },
  };
  childHandles.set("j-driver-838", {
    stdin: fakeStdin as unknown as NodeJS.WritableStream,
    label: "#42 develop · default",
    role: "developer",
  });
  const r = steerChild("j-driver-838", "stop and report status", "deck-ui");
  assert(r.delivered === true, "steerChild: delivered to a driver-shaped job");
  assert(r.label === "#42 develop · default", "steerChild: returns the driver row's label");
  assert(lines.length === 1, "steerChild: exactly one stdin write");
  const line0 = lines[0];
  assert(line0 !== undefined, "steerChild: the stdin line is present");
  const parsed = line0 === undefined ? {} : JSON.parse(line0);
  assert(
    parsed.type === "steer" && parsed.message === "stop and report status",
    "steerChild: stdin line is the {type:'steer', message} envelope",
  );
  const ui = { notify: () => {}, editor: undefined, setStatus: () => {}, editorValue: "" };
  const r2 = await steerFromDeck(ui as unknown as Parameters<typeof steerFromDeck>[0], "j-driver-838", "hello from deck");
  assert(r2.delivered === true, "steerFromDeck: delivered to the driver row");
  assert(lines.length === 2, "steerFromDeck: a second stdin write (total 2)");
  const line1 = lines[1];
  assert(line1 !== undefined, "steerFromDeck: the second stdin line is present");
  const parsed2 = line1 === undefined ? {} : JSON.parse(line1);
  assert(
    parsed2.type === "steer" && parsed2.message === "hello from deck",
    "steerFromDeck: envelope carries the message",
  );
  childHandles.delete("j-driver-838");
}

// 6. A driver row appears in buildAgentListLines (the #914 agent list
//    projects the deck's snapshot; a driver member is a deck entry).
{
  dispatchDeck.reset();
  dispatchDeck.startEntry("j-agent-1", {
    label: "#42 develop · default",
    role: "developer",
    batchKey: "work:42",
  });
  dispatchDeck.startBatchEntry("work:42", { label: "/work #42", size: 0 });
  const entries = dispatchDeck.snapshot();
  const rows = buildAgentListLines(entries, 80, Date.now());
  const jobRow = rows.find((r) => r.key === "j-agent-1");
  assert(jobRow !== undefined, "agent list: driver row is present");
  assert(
    jobRow?.text.includes("#42 develop · default") === true,
    "agent list: row carries the driver label",
  );
  assert(jobRow?.selectable === true, "agent list: driver row is selectable");
  dispatchDeck.clearEntry("j-agent-1");
  dispatchDeck.clearBatchEntry("work:42");
  dispatchDeck.reset();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
