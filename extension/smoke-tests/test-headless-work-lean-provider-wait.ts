#!/usr/bin/env bun
/**
 * #2124 AC4 — a lean provider wait reaches the host's document through the
 * step's recorded `outcome.reason`.
 *
 * The wait is a duration, not a contract a host branches on: `work-lean-result`
 * reads no prose for `prState`/`reviewBound`-style decisions, and adding a typed
 * field for a number nobody routes on would be a second source of truth for a
 * fact the reason already states. So the projection must carry the sentence
 * verbatim into `failure.message` — including clipped, since the reason is the
 * one prose the projection does render.
 */

import type { Step } from "../src/lean/state.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { CHILDREN, leanLog, stepWith } from "./lib/lean-result-fixture.ts";
import { fakeRun, verbRun } from "./lib/work-lean-verb-fixture.ts";

const { assert, state } = makeAssert();

/** The wait sentence `providerWaitNote` composes. */
const NOTE = "waited 60s for a transient provider fault";

/** The one projected issue of a verb run, typed for reading absent fields. */
function issueOf(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const issues = doc.issues as Record<string, unknown>[] | undefined;
  return Array.isArray(issues) ? issues[0] : undefined;
}

/** The `failure.message` of a projection's only issue. */
function messageOf(doc: Record<string, unknown>): string | undefined {
  const failure = issueOf(doc)?.failure as Record<string, unknown> | undefined;
  return typeof failure?.message === "string" ? failure.message : undefined;
}

// ── (1) the step's reason carries the wait sentence into the document.
{
  const steps: Step[] = leanLog({
    prUrl: "https://example.test/pull/7",
    draft: false,
    dispatches: CHILDREN,
  });
  // `exhausted` is the kind the projection renders as a failure message.
  steps[1] = stepWith("build", {
    kind: "exhausted",
    reason: `the developer produced no change; ${NOTE}`,
    dispatches: CHILDREN,
  });
  const r = await verbRun(["7"], async () => ({
    summary: "work-lean #7: handed-back (exit 10)",
    result: fakeRun({ code: 10, state: "handed-back", steps }),
  }));
  const message = messageOf(r.doc);
  assert(
    message !== undefined && message.includes(NOTE),
    `(1) the document's failure message carries the wait sentence (got ${JSON.stringify(message)})`,
  );
}

// ── (2) a run that never waited: no wait sentence anywhere.
{
  const steps = leanLog({
    prUrl: "https://example.test/pull/7",
    draft: false,
    dispatches: CHILDREN,
  });
  steps[1] = stepWith("build", {
    kind: "exhausted",
    reason: "the developer produced no change",
    dispatches: CHILDREN,
  });
  const r = await verbRun(["7"], async () => ({
    summary: "work-lean #7: handed-back (exit 10)",
    result: fakeRun({ code: 10, state: "handed-back", steps }),
  }));
  const message = messageOf(r.doc) ?? "";
  assert(
    !/waited \d+s for a transient provider fault/.test(message),
    `(2) a run that never waited says nothing about waiting (got ${JSON.stringify(message)})`,
  );
}

process.exit(state.exit);
