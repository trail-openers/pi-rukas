/**
 * headless/host — the DriverHost a headless run executes in (headless S4, #1024).
 *
 * `emit` writes one NDJSON v1 line per eventLog entry (ndjson.ts). The index in
 * the idempotency key is the event's position in the state's eventLog, supplied
 * by the emit sink, so a resumed cycle re-emits identical keys.
 * `sendUserMessage` — the chat channel in Pi — becomes a `log` line, so nothing
 * the driver would have shown a human is lost in headless mode. A driver event
 * outside the stable subset is marked `unstable: true` (ndjson.ts).
 */

import type { DriverHost } from "../work-driver-host.ts";
import type { WorkEvent } from "../workflow-state-events.ts";
import { type NdjsonLine, eventKey, formatLine, isStableKind } from "./ndjson.ts";

export type LineWriter = (line: string) => void;

/** A DriverHost for one issue, writing NDJSON lines through `write`. */
export function createHeadlessHost(issue: number, write: LineWriter): DriverHost {
  const put = (line: NdjsonLine) => write(formatLine(line));
  return {
    sendUserMessage: (text) => {
      put({ v: 1, kind: "log", at: new Date().toISOString(), issue, message: text });
    },
    emit: (event: WorkEvent, index: number) => {
      const at = new Date().toISOString();
      const eventAt = typeof event.at === "number" ? event.at : Date.now();
      put({
        v: 1,
        kind: event.kind,
        at,
        issue,
        key: eventKey(issue, index, eventAt),
        event,
        ...(isStableKind(event.kind) ? {} : { unstable: true as const }),
      });
    },
  };
}

/**
 * A DriverHost for a verb that is not tied to an issue (plan, research,
 * agents-md, lens-review — headless S6, #1021). Messages become `log` lines
 * without `issue`; an event, which these pipelines do not emit, still gets a
 * line (marked unstable when its kind is).
 */
export function createVerbHost(write: LineWriter): DriverHost {
  const put = (line: NdjsonLine) => write(formatLine(line));
  return {
    sendUserMessage: (text) => {
      put({ v: 1, kind: "log", at: new Date().toISOString(), message: text });
    },
    emit: (event: WorkEvent) => {
      put({
        v: 1,
        kind: event.kind,
        at: new Date().toISOString(),
        event,
        ...(isStableKind(event.kind) ? {} : { unstable: true as const }),
      });
    },
  };
}
