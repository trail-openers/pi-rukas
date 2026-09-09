#!/usr/bin/env bun
/**
 * Phase 0b — deterministic under-specification precheck (plan-precheck.ts).
 *
 * The literature's top spec defect (under-specification) used to be
 * discovered LAST, by the LLM gap gate, after the full investigation
 * fan-out. The precheck routes the strongest-signal case BEFORE any
 * dispatch: descriptor under the word floor AND zero code identifiers AND
 * no context param → targeted questions, zero dispatches, seconds not
 * minutes. All three signals must be absent — a legitimately terse
 * descriptor that names code, or arrives with context, is never blocked.
 */

import { runPlanPipeline, setPlanDispatch } from "../src/plan-driver.ts";
import { PRECHECK_WORD_FLOOR, precheckDescriptor } from "../src/plan-precheck.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------------- units

{
  const thin = precheckDescriptor("bug", "fix login bug", undefined);
  assert(!thin.ok, "thin bug descriptor (3 words, no code id, no context) fires");
  assert(thin.questions.length === 3, `three targeted questions (got ${thin.questions.length})`);
  assert(
    thin.questions.some((q) => /observed wrong behaviour/.test(q)),
    "bug type gets the observed-vs-expected question",
  );

  const thinFeature = precheckDescriptor("feature", "add dark mode", undefined);
  assert(!thinFeature.ok, "thin feature descriptor fires");
  assert(
    thinFeature.questions.some((q) => /observable behaviour or outcome/.test(q)),
    "non-bug types get the expected-outcome question",
  );

  const withCode = precheckDescriptor("bug", "fix plan-tool.ts", undefined);
  assert(withCode.ok, "a code identifier grounds the investigation — never blocked");

  const withContext = precheckDescriptor("bug", "fix login bug", "the OAuth callback 500s");
  assert(withContext.ok, "a context param grounds the investigation — never blocked");

  const longEnough = precheckDescriptor(
    "feature",
    "add retry handling to the provider backoff path",
    undefined,
  );
  assert(longEnough.ok, `>= ${PRECHECK_WORD_FLOOR} words passes without code ids or context`);

  const whitespaceContext = precheckDescriptor("bug", "fix login bug", "   \n  ");
  assert(!whitespaceContext.ok, "whitespace-only context does not count as context");
}

// -------------------------------------------------- pipeline: zero dispatch

{
  let dispatches = 0;
  setPlanDispatch((() => {
    dispatches++;
    return Promise.resolve({
      role: "explore",
      ok: true,
      text: "",
      toolUses: [],
      ms: 1,
      exitCode: 0,
    });
  }) as never);

  const r = await runPlanPipeline(
    { registerTool: () => {} } as never,
    { descriptor: "fix login bug", dryRun: true },
    process.cwd(),
  );

  assert(dispatches === 0, `precheck fires BEFORE any dispatch (got ${dispatches} dispatches)`);
  assert(r.filed === false, "nothing filed");
  assert(
    r.filingFailure?.reason === "needs-clarification",
    `discriminated reason needs-clarification (got ${r.filingFailure?.reason})`,
  );
  assert(
    /too thin to ground an investigation/.test(r.spec) && /re-run start_plan_driver/.test(r.spec),
    "the spec text explains and says how to proceed",
  );
  assert(
    /Which code area/.test(r.spec),
    "the targeted questions are in the operator-visible spec text",
  );
  assert(
    (r.timings ?? []).some((t) => t.phase === "total"),
    "timings present even on the precheck early return",
  );

  setPlanDispatch(null);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
