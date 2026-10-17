#!/usr/bin/env bun
/**
 * The two wiring guarantees #1393 is named for, asserted where they are actually
 * wired rather than where they are convenient to fake.
 *
 *   1. **One record per failure.** One forced dispatch failure through the acting
 *      caller (the step router's entry point, `shadowFailureCause`) writes
 *      EXACTLY ONE `decisions.jsonl` record. Not zero — the pre-#1393 silence,
 *      which left S5 no sample for exactly the causes the rule reads best — and
 *      not two, a skip plus a call record for one decision. Three shapes are
 *      checked, because they reach the log by three different paths: an EXACT
 *      rule match (one record, no backend), an INFERRED cause (one record, one
 *      backend), and a provider OUTAGE (one THROTTLED skip, so a 40-failure burst
 *      is still one record).
 *   2. **index.ts attaches the session model.** A shadow seam asks the Pi
 *      session's registry and model, which `attach()` captures on
 *      `session_start`. If the entry point ever stopped attaching, every shadow
 *      call would silently degrade to rule-only and the S5 sample would be empty
 *      with nothing to show it — a failure no other test here can see, since each
 *      one attaches on its own. So it is asserted as the wiring fact it is:
 *      through the real extension entry point, and by whether a backend was
 *      actually consulted.
 *
 * Offline: the session model is a stub registry; nothing touches the network.
 */

import path from "node:path";
import { __inFlightForTests, __resetShadowForTests } from "../src/decision-shadow.ts";
import extensionEntry from "../src/index.ts";
import { classifyFailureCause, shadowFailureCause } from "../src/work-driver-failure-taxonomy.ts";
import {
  STUB_MODEL,
  llmReply,
  makeAssert,
  records,
  stubRegistry,
  tmpDir,
} from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Tail = Parameters<typeof classifyFailureCause>[0];
type Where = Parameters<typeof shadowFailureCause>[2];

/** What the acting step router does with one failure: classify, then ask in shadow. */
function act(tail: Tail, where: Where) {
  const cls = classifyFailureCause(tail);
  shadowFailureCause(tail, cls, where);
  return cls;
}

/** Wait for `n` records AND for every in-flight shadow call to have released. */
async function settled(file: string, n: number): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 200; i++) {
    if (records(file).length >= n && __inFlightForTests() === 0) break;
    await sleep(10);
  }
  // One more turn: an append racing the last release must not be missed.
  await sleep(20);
  return records(file);
}

const QUESTION = "What caused this dispatch failure?";
/** A 429 only in the SUBAGENT's own words: inferred, so the model is asked (#1262). */
const INFERRED_429: Tail = {
  kind: "dispatch-failed",
  errorTail: "tests for the 429 status path pass",
};
const ANSWER = () => llmReply(JSON.stringify({ label: "rate-limited", justification: "stub" }));

/**
 * Register the real extension entry point on a capture-only `pi` and fire one of
 * its handlers. Deliberately minimal: this test's claim is WHICH handler the
 * entry point registers and what reaches it, so nothing is installed the
 * extension does not already call.
 */
async function entryHandler(
  event: string,
): Promise<((event: unknown, ctx: unknown) => unknown) | undefined> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    registerTool: () => undefined,
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    sendUserMessage: () => undefined,
    getCommands: () => [],
    getAllTools: () => [],
    setActiveTools: () => undefined,
  };
  await extensionEntry(pi as never);
  return handlers.get(event);
}

// ---------------------------------------------- one forced failure, one record

{
  const cwd = tmpDir("wiring-attached");
  const attached = stubRegistry({ llm: ANSWER });
  const start = await entryHandler("session_start");
  assert(start !== undefined, "the entry point registers a session_start handler");
  await start?.({}, { modelRegistry: attached.registry, model: STUB_MODEL, cwd });

  // An EXACT cause: pi-rukas killed the child itself. The rule answered, no
  // model is asked, and BEFORE #1393 nothing at all was written.
  const root = tmpDir("wiring-exact");
  const where = { repoRoot: root, issues: [31] } as Where;
  const log = path.join(root, ".pi", "work-state", "31", "decisions.jsonl");
  __resetShadowForTests();
  act({ kind: "dispatch-failed", killCause: "timeout" }, where);
  const recs = await settled(log, 1);
  assert(
    recs.length === 1 &&
      calls(attached).llm === 0 &&
      recs[0]?.seam === "failure-cause" &&
      recs[0]?.question === QUESTION &&
      recs[0]?.ruleAnswer === "self-killed:timeout" &&
      recs[0]?.exactRuleMatch === true &&
      recs[0]?.skipped === undefined,
    `one exact-match failure writes exactly ONE record — not zero, not two — marked exact, with no backend (${recs.length} record(s), ${calls(attached).llm} calls)`,
  );

  // An INFERRED cause: the model IS asked, and the call's own single record is
  // the whole audit trail.
  const root2 = tmpDir("wiring-asked");
  const where2 = { repoRoot: root2, issues: [32] } as Where;
  const log2 = path.join(root2, ".pi", "work-state", "32", "decisions.jsonl");
  const asked = stubRegistry({ llm: ANSWER });
  await start?.({}, { modelRegistry: asked.registry, model: STUB_MODEL, cwd });
  __resetShadowForTests();
  const cls = act(INFERRED_429, where2);
  const recs2 = await settled(log2, 1);
  assert(
    recs2.length === 1 && cls.cause === "rate-limited:429" && calls(asked).llm === 1,
    `one inferred-cause failure writes exactly ONE record and asks ONE backend call (${recs2.length} record(s), ${calls(asked).llm} calls, cause ${cls.cause})`,
  );
  // The record's `ruleAnswer` is the SEAM's label (`rate-limited`), not the
  // taxonomy's cause: the seam classifies into its own label space while
  // `cls.cause` is what the router acts on. Both are asserted above.
  assert(
    recs2[0]?.ruleAnswer === "rate-limited" &&
      recs2[0]?.skipped === undefined &&
      (recs2[0]?.backends as { answer?: string }[])?.[0]?.answer === "rate-limited" &&
      (recs2[0]?.final as { source?: string } | undefined)?.source === "rule",
    "the asked record carries the rule's label, the backend's answer, the rule as the final source, and no skip marker",
  );

  // A provider OUTAGE: one throttled skip, so a burst stays bounded.
  const root3 = tmpDir("wiring-outage");
  const where3 = { repoRoot: root3, issues: [33] } as Where;
  const log3 = path.join(root3, ".pi", "work-state", "33", "decisions.jsonl");
  const burst = stubRegistry({ llm: ANSWER });
  await start?.({}, { modelRegistry: burst.registry, model: STUB_MODEL, cwd });
  __resetShadowForTests();
  for (let i = 0; i < 40; i++)
    act({ kind: "dispatch-failed-provider", providerMessage: "socket hang up" }, where3);
  const recs3 = await settled(log3, 1);
  assert(
    recs3.length === 1 && calls(burst).llm === 0 && recs3[0]?.skipped !== undefined,
    `40 provider-outage failures write ONE throttled skip record and ask no model (${recs3.length} record(s), ${calls(burst).llm} calls)`,
  );

  // After shutdown the same call degrades to rule-only rather than throwing:
  // detach() dropped the context, so there is nothing to ask.
  const shutdown = await entryHandler("session_shutdown");
  await shutdown?.({}, {});
  const before = calls(asked).llm;
  const detachedRoot = tmpDir("wiring-detached");
  act({ kind: "dispatch-failed", errorTail: "exit 1" }, {
    repoRoot: detachedRoot,
    issues: [35],
  } as Where);
  const detachedLog = path.join(detachedRoot, ".pi", "work-state", "35", "decisions.jsonl");
  const recs4 = await settled(detachedLog, 1);
  assert(
    calls(asked).llm === before && recs4.length === 1 && recs4[0]?.mode === "shadow",
    `after session_shutdown the call is rule-only but still leaves one record (${calls(asked).llm - before} calls, ${recs4.length} record)`,
  );
}

/** `stubRegistry` returns `{ registry, calls }`; this keeps the reads above short. */
function calls(stub: { calls: { classify: number; llm: number } }): { llm: number } {
  return stub.calls;
}

process.exit(state.exit);
