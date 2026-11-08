#!/usr/bin/env bun
/**
 * lean/build — a build child that died having done NO work is re-dispatched once.
 *
 * The field shape (#2104): a `developer` child that exited 1 seconds in, having
 * made no turn and no tool call, handed the whole run back — `dispatchBuilder`
 * threw and the in-step loop of `test-lean-build-budget-retry.ts` retries only a
 * ceiling stop. A child that bought nothing gets ONE re-dispatch inside the same
 * visit, on the same prompt and a freshly armed budget, and it bills no build
 * attempt; a child that worked, or one a cap killed, still throws on the first
 * dispatch.
 *
 * Split from `test-lean-build-budget-retry.ts` for the 500-line gate
 * (AGENTS.md §12): that file owns what a CEILING stops, this one what a crash
 * does, and the two never overlap — a budget stop is never a retry candidate
 * here, because `budget.fired()` answers it before the crash branch is reached.
 */

import { BuildInfraError } from "../src/lean/build-errors.ts";
import { MAX_BUILD_ATTEMPTS } from "../src/lean/machine.ts";
import type { DispatchResult } from "../src/types.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import { commitPaths } from "./lib/lean-build-asserts.ts";
import { ROOTS, buildFixture, put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A child that exited non-zero having demonstrably done nothing. */
const NOWORK: Partial<DispatchResult> = {
  ok: false,
  exitCode: 1,
  text: "",
  toolUses: [],
  observedToolCalls: 0,
  usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
};
const EDIT_FILE = (wt: string) => put(wt, "src/retry.ts", "export const retry = () => 1;\n");

{
  const r = await runBuild({
    issue: 211,
    child: EDIT_FILE,
    dispatchResults: [NOWORK],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(w) a no-work crash is retried and the build lands (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(r.dispatched === 2, `(w) exactly one re-dispatch ran (got ${String(r.dispatched)})`);
  const rows = r.outcome?.dispatches ?? [];
  assert(
    rows.length === 2 && rows[0]?.ok === false && rows[1]?.ok === true,
    `(w) both children are billed, the dead one marked not-ok (${JSON.stringify(rows)})`,
  );
  assert(
    r.prompts.length === 2 && r.prompts[0] === r.prompts[1],
    "(w) the retried child gets the same prompt, so no budget-stop re-entry text",
  );
  assert(
    commitPaths(r.worktree).join() === "src/retry.ts",
    `(w) the retry's file is what landed (got ${commitPaths(r.worktree).join(", ")})`,
  );
}

{
  const r = await runBuild({
    issue: 212,
    child: EDIT_FILE,
    dispatchResults: () => NOWORK,
  });
  assert(
    r.threw instanceof BuildInfraError,
    `(w) a second no-work crash still throws (got ${r.threw?.name ?? r.outcome?.kind})`,
  );
  assert(
    r.dispatched === 2,
    `(w) the re-dispatch is one-shot, never a spawn loop (got ${String(r.dispatched)})`,
  );
  assert(
    (r.deadDispatches ?? []).length === 2,
    `(w) the throw bills both dead children (${String((r.deadDispatches ?? []).length)})`,
  );
}

{
  const didWork: Partial<DispatchResult> = { ...NOWORK, usage: { ...NOWORK.usage!, turns: 2 } };
  const r = await runBuild({ issue: 213, child: EDIT_FILE, dispatchResults: [didWork] });
  assert(
    r.threw instanceof BuildInfraError && r.dispatched === 1,
    `(w) a child that did work throws on the first dispatch (got ${String(r.dispatched)})`,
  );
}

{
  // Every kill cause, even the two the shared taxonomy calls retryable
  // (`inactivity` / `tool-inactivity`, retryable for the DRIVER's router), are
  // never handed the free re-dispatch here: re-spawning a child pi-rukas itself
  // ended is a spawn loop. Table-driven so no cause is left out by omission.
  const killCases = [
    "tool-inactivity",
    "inactivity",
    "timeout",
    "loop",
    "token-budget",
    "no-progress",
    "stuck-tool",
  ] as const;
  for (const [i, killCause] of killCases.entries()) {
    const r = await runBuild({
      issue: 230 + i,
      child: EDIT_FILE,
      dispatchResults: () => ({ ...NOWORK, killCause }),
    });
    assert(
      r.threw instanceof BuildInfraError && r.dispatched === 1,
      `(w) a ${killCause} kill is never re-dispatched (got ${String(r.dispatched)})`,
    );
  }
}

{
  // A rate limit the taxonomy calls FINAL — a spend cap, a dated-429 nothing
  // waits out, a quota window hours away — is no re-dispatch either, though the
  // child was never killed. Each of these has to reach the classifier as a
  // PROVIDER event, so the fix's kind is what the case judges (see
  // `failureKindFor`); a kill cause would be answered by the kill rule above.
  const finalCases: Array<[string, { reason: string; message: string }]> = [
    ["spend cap", { reason: "error", message: "HTTP 429 status code: monthly spend cap reached, resets in 9000 seconds" }],
    ["undated 429", { reason: "error", message: "429 status code, too many requests, resets in 9000 seconds" }],
    ["quota window", { reason: "error", message: "429 status code, Server requested 86400s retry delay" }],
  ];
  for (const [i, [name, errorStop]] of finalCases.entries()) {
    const r = await runBuild({
      issue: 240 + i,
      child: EDIT_FILE,
      dispatchResults: () => ({ ...NOWORK, errorStop }),
    });
    assert(
      r.threw instanceof BuildInfraError && r.dispatched === 1,
      `(w) a final provider fault (${name}) is never re-dispatched (got ${String(r.dispatched)})`,
    );
  }
}

{
  // The provider faults a re-dispatch DOES answer: a transient transport error,
  // and an error stop that carried only a `reason` and no `message` — both are
  // provider events to the classifier and both come back ok on the second child.
  const transientCases: Array<[string, { reason: string; message?: string }]> = [
    ["an upstream 503", { reason: "error", message: "upstream 503" }],
    ["a bare connection reason", { reason: "connection_error" }],
  ];
  for (const [i, [name, errorStop]] of transientCases.entries()) {
    const r = await runBuild({
      issue: 250 + i,
      child: EDIT_FILE,
      dispatchResults: [{ ...NOWORK, errorStop }],
    });
    assert(
      r.threw === undefined && r.outcome?.kind === "ok" && r.dispatched === 2,
      `(w) a transient provider fault (${name}) is re-dispatched once (got ${String(r.dispatched)})`,
    );
  }
}

{
  // The throw the second dead child makes names BOTH causes, and neither of them
  // is the raw provider body: a 5,000-char message carrying a key-shaped token
  // comes back bounded and redacted, because every cause a site names goes
  // through `dispatchFailureWhy`.
  const KEY = "sk-ant-api03-Zzzz1111222233334444";
  // The credential is at the END of a long body, so it sits far past the clip:
  // only a redact-FIRST order can scrub it, and the bound is what a clip that
  // ran BEFORE the scan could not guarantee.
  const LONG_STOP = {
    reason: "error",
    message: `HTTP 500 provider body: ${"filler ".repeat(700)} key=${KEY}`,
  };
  const r = await runBuild({
    issue: 260,
    child: EDIT_FILE,
    dispatchResults: () => ({ ...NOWORK, errorStop: LONG_STOP }),
  });
  const msg = String(r.threw?.message ?? "");
  // One child, so this throw carries the raw cause alone — the bound and the
  // redaction are asserted on it rather than on the composite, where `first:` /
  // `then:` each contribute half of the length.
  const single = await runBuild({
    issue: 261,
    child: EDIT_FILE,
    // A RULE, not the same object twice: the first child is a transient fault
    // (so the free re-dispatch runs) and the second a `crashed` child, which is
    // the one shape that throws without being re-dispatched again.
    dispatchResults: (n) =>
      n === 0 ? { ...NOWORK, errorStop: LONG_STOP } : NOWORK,
  });
  const cause = String(single.threw?.message ?? "");
  assert(
    r.threw instanceof BuildInfraError && r.dispatched === 2,
    `(w) a second dead child still throws after the free re-dispatch (got ${String(r.dispatched)})`,
  );
  assert(
    msg.includes("first: ") && msg.includes("then: "),
    `(w) the throw names both causes (got ${msg.slice(0, 90)})`,
  );
  assert(
    cause.startsWith("build dispatch failed: ") &&
      cause.length < 1_100 &&
      !cause.includes(KEY) &&
      cause.includes("HTTP 500 provider body"),
    `(w) a ~5,000-char provider body is redacted then clipped to the provider budget in the cause it names (${String(cause.length)} chars)`,
  );
  assert(
    !msg.includes(KEY),
    "neither cause of the two-child throw carries the key",
  );
}

{
  // The two positive proofs of work, each on its own: a child that reported a
  // tool call, and one the live stream saw make one. Either alone is enough to
  // make the child not-blank, so neither may be re-dispatched.
  const calledTool: Partial<DispatchResult> = { ...NOWORK, toolUses: [{ name: "bash", args: {} }] };
  const tool = await runBuild({ issue: 218, child: EDIT_FILE, dispatchResults: [calledTool] });
  assert(
    tool.threw instanceof BuildInfraError && tool.dispatched === 1,
    `(w) a child that reported a tool call throws on the first dispatch (got ${String(tool.dispatched)})`,
  );
  const seenTool: Partial<DispatchResult> = { ...NOWORK, observedToolCalls: 1 };
  const observed = await runBuild({ issue: 219, child: EDIT_FILE, dispatchResults: [seenTool] });
  assert(
    observed.threw instanceof BuildInfraError && observed.dispatched === 1,
    `(w) a child whose tool call was seen live throws on the first dispatch (got ${String(observed.dispatched)})`,
  );
}

{
  // A cap kill is a verdict on the child's run, not a blank sheet: the no-work
  // re-dispatch must not reach for it. `killCause: "abort"` is a cap the step's
  // own budget never arms, so the dispatch's own classification is what is judged.
  const aborted = { ...NOWORK, killCause: "abort" as const };
  const killed = await runBuild({ issue: 214, child: EDIT_FILE, dispatchResults: [aborted] });
  assert(
    killed.threw instanceof BuildInfraError && killed.dispatched === 1,
    `(w) a cap kill is never re-dispatched (got ${String(killed.dispatched)})`,
  );
  // A child-bound kill is the one kill cause the step may claim as its OWN
  // ceiling, and `armBudget` reads it from the CAUSE rather than a clock a harness
  // cannot fake: with a minutes lever armed, a `child-bound` child is the step's
  // budget verdict. The free no-work re-dispatch must not answer that kill — it
  // would spend the ceiling again on a verdict already in hand (#2104 R2).
  // No `verify.test` runner: the budget verdict still folds its work, and a case
  // about WHO owns this kill should not also start the driver's frozen sweep.
  const killedCeiling = await runBuild({
    issue: 217,
    child: EDIT_FILE,
    config: {
      ...configWithRunner(),
      verify: { fast: "true", test: "" },
      budgets: { ...configWithRunner().budgets, build: { turns: 0, tokens: 0, minutes: 1 } },
    },
    // A rule, not a list: the shape under test is the child's, and a list would let
    // a later child answer with different bytes. The ceiling's OWN in-step retries
    // are `test-lean-build-budget-retry.ts`'s to pin.
    dispatchResults: () => ({ ...NOWORK, killCause: "child-bound" as const, ms: 60_001 }),
  });
  assert(
    killedCeiling.outcome?.kind === "budget",
    `(w) a child the step's own ceiling stopped still takes the budget path (got ${killedCeiling.outcome?.kind ?? killedCeiling.threw?.name})`,
  );
}

{
  // `usage` absent entirely: the step cannot tell what the child did, so it
  // fails closed and pays nobody a second time.
  const unknown: Partial<DispatchResult> = {
    ok: false,
    exitCode: 1,
    text: "",
    toolUses: [],
    usage: undefined,
  };
  const r = await runBuild({ issue: 215, child: EDIT_FILE, dispatchResults: [unknown] });
  assert(
    r.threw instanceof BuildInfraError && r.dispatched === 1,
    `(w) unknown usage is not proof of no work (got ${String(r.dispatched)})`,
  );
}

{
  // The field case: the crash lands on the THIRD round, where `retriesAllowed`
  // is 0. The no-work re-dispatch buys nothing, so it must still happen — and
  // must not bill a build attempt the run never spent.
  const built = buildFixture(216);
  built.ctx.run.counters.buildAttempts = MAX_BUILD_ATTEMPTS + 1;
  const r = await runBuild({
    issue: 216,
    built,
    child: EDIT_FILE,
    dispatchResults: [NOWORK],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(w) the retry fires on a round past the cap (got ${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    r.dispatched === 2,
    `(w) there too, exactly one re-dispatch (got ${String(r.dispatched)})`,
  );
  assert(
    r.built.ctx.run.counters.buildAttempts === MAX_BUILD_ATTEMPTS + 1,
    `(w) the re-dispatch bills no build attempt (got ${String(r.built.ctx.run.counters.buildAttempts)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
