/**
 * headless/host — the DriverHost a headless run executes in (headless S4, #1024).
 *
 * `emit` writes one NDJSON v1 line per eventLog entry (ndjson.ts). The index in
 * the idempotency key is the event's position in the cycle's log, which the emit
 * sink already tracks; the host counts what it has been handed for the issue.
 * `sendUserMessage` — the chat channel in Pi — becomes a `log` line, so nothing
 * the driver would have shown a human is lost in headless mode.
 */

import type { DriverHost } from "../work-driver-host.ts";
import type { WorkEvent } from "../workflow-state-events.ts";
import { type NdjsonLine, eventKey, formatLine } from "./ndjson.ts";

export type LineWriter = (line: string) => void;

/** A DriverHost for one issue, writing NDJSON lines through `write`. */
export function createHeadlessHost(issue: number, write: LineWriter): DriverHost {
  let index = 0;
  const put = (line: NdjsonLine) => write(formatLine(line));
  return {
    sendUserMessage: (text) => {
      put({ v: 1, kind: "log", at: new Date().toISOString(), issue, message: text });
    },
    emit: (event: WorkEvent) => {
      const at = new Date().toISOString();
      const eventAt = typeof event.at === "number" ? event.at : Date.now();
      put({
        v: 1,
        kind: event.kind,
        at,
        issue,
        key: eventKey(issue, index++, eventAt),
        event,
      });
    },
  };
}
