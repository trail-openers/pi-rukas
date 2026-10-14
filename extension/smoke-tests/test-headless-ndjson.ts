#!/usr/bin/env bun
/**
 * #1024 (headless S4) — the NDJSON v1 schema: every line the host writes
 * validates, the event key is `<issue>:<index>:<at>`, and the kinds are the
 * documented set. Offline.
 */
import { createHeadlessHost } from "../src/headless/host.ts";
import { NDJSON_KINDS, eventKey, validateNdjsonLine } from "../src/headless/ndjson.ts";
import { createEmitSink, emitPersisted } from "../src/work-state-emit.ts";
import { KNOWN_EVENT_KINDS } from "../src/workflow-state-validate.ts";
import { appendEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const now = new Date().toISOString();

// ── Schema: the kind set is the event kinds plus log and pi-resolved.
assert(
  NDJSON_KINDS.includes("log") &&
    NDJSON_KINDS.includes("pi-resolved") &&
    NDJSON_KINDS.includes("interrupted"),
  "NDJSON kinds include log, pi-resolved and the interrupted event kind",
);
assert(
  NDJSON_KINDS.length === KNOWN_EVENT_KINDS.length + 2,
  "NDJSON kinds are exactly the event kinds plus two",
);

// ── Validator.
assert(
  validateNdjsonLine({ v: 1, kind: "log", at: now, message: "x" }).length === 0,
  "a log line validates",
);
assert(validateNdjsonLine({ v: 2, kind: "log", at: now }).length > 0, "v other than 1 is rejected");
assert(
  validateNdjsonLine({ v: 1, kind: "nope", at: now }).length > 0,
  "an unknown kind is rejected",
);
assert(
  validateNdjsonLine({ v: 1, kind: "log", at: "yesterday" }).length > 0,
  "a non-ISO at is rejected",
);
assert(
  validateNdjsonLine({ v: 1, kind: "step-started", at: now, issue: 5 }).length > 0,
  "a driver event line without key is rejected",
);
assert(validateNdjsonLine("not an object").length > 0, "a non-object line is rejected");

// ── Host: the emit sink writes one valid line per event, keyed issue:index:at.
{
  const lines: string[] = [];
  const host = createHeadlessHost(9, (l) => lines.push(l));
  const sink = createEmitSink((e, index) => host.emit(e, index));
  const s1 = appendEvent(initialState(9), { kind: "step-started", step: "explore", at: 100 });
  const s2 = appendEvent(s1, { kind: "step-started", step: "plan", at: 200 });
  // The state writer calls emitPersisted on every persist; a repeat emits nothing.
  emitPersisted(sink, s2);
  emitPersisted(sink, s2);
  host.sendUserMessage("hello");
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  assert(lines.length === 3, "two events and one log line are written, nothing twice");
  assert(
    parsed.every((p) => validateNdjsonLine(p).length === 0),
    "every host line validates against v1",
  );
  assert(
    parsed[0]?.key === eventKey(9, 0, 100) && parsed[1]?.key === eventKey(9, 1, 200),
    "keys are issue:index:at",
  );
  assert(
    parsed[2]?.kind === "log" && parsed[2]?.message === "hello",
    "sendUserMessage becomes a log line",
  );
  assert(
    parsed.every((p) => p.issue === 9 && p.v === 1),
    "every line carries v and issue",
  );
}

process.exit(exit);
