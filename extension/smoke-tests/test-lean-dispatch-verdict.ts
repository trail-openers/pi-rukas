#!/usr/bin/env bun
/**
 * lean/dispatch-verdict — the one tail all four dispatch sites share.
 *
 * `build-dispatch`, `challenge-dispatch`, `specify-attempt` and `review-fix-child`
 * each hand this helper their own `*InfraError` and prefix, so the whole surface
 * is the cause precedence (kill cause, then provider message, then provider
 * reason, then exit code) and the fact that the rows travel on the error. The
 * step suites only ever see the message after the prefix, so a precedence that
 * quietly changed — a `killCause` reported as a provider fault, say — is visible
 * nowhere but here.
 */

import type { DispatchResult } from "../src/types.ts";
import type { DispatchUsageRow } from "../src/lean/step-budget.ts";
import { throwIfDispatchFailed } from "../src/lean/dispatch-verdict.ts";

class TestInfraError extends Error {
  readonly dispatches?: DispatchUsageRow[];
  constructor(message: string, dispatches?: DispatchUsageRow[]) {
    super(message);
    if (dispatches !== undefined) this.dispatches = dispatches;
  }
}

const ROWS: DispatchUsageRow[] = [
  { role: "developer", ms: 5, ok: false, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } },
];

let exit = 0;
/** Counters, so the assertions below are not vacuous: an arm that never reached
 * the tail would otherwise print ✓ for a call that never happened. */
let thrown = 0;
let returned = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Run the tail and report what it threw, or null when it returned. */
function verdict(over: Partial<DispatchResult>): TestInfraError | null {
  const result = {
    role: "developer",
    ok: true,
    text: "",
    toolUses: [],
    ms: 1,
    exitCode: 0,
    ...over,
  } as DispatchResult;
  try {
    throwIfDispatchFailed(result, TestInfraError, "prefix: ", ROWS);
    returned++;
    return null;
  } catch (err) {
    thrown++;
    return err as TestInfraError;
  }
}

{
  assert(verdict({}) === null, "an ok child with no kill and no error stop does not throw");

  const killed = verdict({ ok: true, killCause: "timeout" });
  assert(
    killed?.message === "prefix: timeout",
    `an ok:true child the harness killed still throws, naming the kill cause (got ${String(killed?.message)})`,
  );

  const provider = verdict({ ok: false, errorStop: { reason: "error", message: "upstream 503" } });
  assert(
    provider?.message === "prefix: upstream 503",
    `an errorStop's message is the cause when it has one (got ${String(provider?.message)})`,
  );

  const both = verdict({ ok: false, killCause: "inactivity", errorStop: { reason: "error", message: "upstream 503" } });
  assert(
    both?.message === "prefix: inactivity",
    `a self-kill outranks the provider message — a kill is never reported as a provider fault (got ${String(both?.message)})`,
  );

  const reason = verdict({ ok: false, errorStop: { reason: "connection_error" } });
  assert(
    reason?.message === "prefix: connection_error",
    `an errorStop with only a reason names the reason (got ${String(reason?.message)})`,
  );

  const plain = verdict({ ok: false, exitCode: 7 });
  assert(
    plain?.message === "prefix: exit 7",
    `with no cause at all the exit code is the last word (got ${String(plain?.message)})`,
  );
  assert(
    verdict({ ok: false, exitCode: null })?.message === "prefix: exit null",
    "a child that never reported a status reads as exit null, not exit undefined",
  );

  assert(killed instanceof TestInfraError, "the error thrown is the ctor the site passed in");
  assert(
    killed?.dispatches === ROWS,
    "the cost rows travel on the error — a child that died still spent its tokens",
  );

  assert(
    returned === 1 && thrown === 6,
    `every arm reached the tail: one return and six throws (got ${String(returned)} returned, ${String(thrown)} thrown)`,
  );
}

process.exit(exit);
