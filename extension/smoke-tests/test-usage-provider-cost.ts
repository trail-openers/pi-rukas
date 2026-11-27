#!/usr/bin/env bun
/**
 * `usage.costFromProvider` — whether a cost is what the provider billed.
 *
 *   - Pi >= 1.5 marks each usage `cost.totalFromProvider`; a child's usage is
 *     provider-billed only when every message's is (Pi's own combine rule)
 *   - Pi 1.4 carries no flag: the usage, and the fold's JSON, carry none either
 *   - the fold, the lens aggregate and lean's loader keep the same rule
 *   - the token-budget quantity does not move with the flag
 *   - a fixer's session continuation keeps its own flag into lean's fold
 *   - `--capabilities` publishes `usageCostFromProvider`
 *
 * Offline and pure.
 */
import { createUsageTally } from "../src/adversarial-usage.ts";
import { lastAgentEndFinalTurn } from "../src/continuation-stream.ts";
import { continuationRow } from "../src/fixer-truncation.ts";
import { buildCapabilities } from "../src/headless/capabilities.ts";
import { validatedDispatches } from "../src/lean/state-dispatches.ts";
import { leanUsage } from "../src/lean/usage-sum.ts";
import { aggregateLensUsage } from "../src/lens-review-usage.ts";
import { emptyRunningState, ingestEvent } from "../src/progress.ts";
import type { DispatchUsage } from "../src/types.ts";
import { foldUsage } from "../src/usage-fold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A child's usage after ingesting assistant turns with these flags (undefined = Pi 1.4 shape). */
function child(flags: (boolean | undefined)[]) {
  const s = emptyRunningState("developer");
  for (const f of flags) {
    const cost = f === undefined ? { total: 0.25 } : { total: 0.25, totalFromProvider: f };
    const event = {
      type: "message_end",
      message: { role: "assistant", content: [], usage: { input: 100, output: 10, cost } },
    };
    ingestEvent(s, event as Parameters<typeof ingestEvent>[1], 0);
  }
  return s;
}

const billed = child([true, true]);
const mixed = child([true, false]);
const old = child([undefined, undefined]);
assert(billed.usage.costFromProvider === true, "every turn billed: the child is billed");
assert(mixed.usage.costFromProvider === false, "one estimated turn: the child is not billed");
assert(
  !("costFromProvider" in JSON.parse(JSON.stringify(old.usage))),
  "Pi 1.4 usage carries no flag",
);
assert(
  billed.totalTokens === old.totalTokens && billed.usage.cost === old.usage.cost,
  "tokens and cost are summed the same whatever the flag",
);

const u = (s: ReturnType<typeof child>): DispatchUsage => ({ ...s.usage });
const both = foldUsage([
  { role: "developer", usage: u(billed) },
  { role: "adversarial", usage: u(billed) },
]);
assert(both.total.costFromProvider === true, "fold: every dispatch billed, the total is billed");
const oneEstimate = foldUsage([
  { role: "developer", usage: u(billed) },
  { role: "developer", usage: u(mixed) },
]);
assert(
  oneEstimate.total.costFromProvider === false &&
    oneEstimate.byRole.developer?.costFromProvider === false,
  "fold: one estimated dispatch makes the total and its role not billed",
);
const pre15 = foldUsage([{ role: "developer", usage: u(old) }]);
assert(
  !("costFromProvider" in JSON.parse(JSON.stringify(pre15))),
  "fold over Pi 1.4 usage carries no flag in the document",
);

assert(
  aggregateLensUsage([{ usage: u(billed) }, { usage: u(mixed) }] as never)?.costFromProvider ===
    false,
  "lens aggregate: one estimated lens makes the sum not billed",
);

const tally = createUsageTally();
for (const s of [billed, mixed]) tally.accumulate({ usage: u(s) } as never);
assert(
  tally.usage.costFromProvider === false,
  "adversarial tally: one estimated round is not billed",
);

const row = (usage: DispatchUsage) => ({ role: "developer", ms: 1, ok: true, usage });
const loaded = validatedDispatches([row(u(billed)), row(u(mixed)), row(u(old))]);
assert(
  loaded[0]?.usage.costFromProvider === true && loaded[1]?.usage.costFromProvider === false,
  "lean's loader keeps the flag",
);
assert(
  validatedDispatches([row({ ...u(billed), costFromProvider: "yes" as never })]).length === 0,
  "lean's loader refuses a non-boolean flag",
);
const steps = [{ outcome: { kind: "ok", dispatches: loaded.slice(0, 2) } }] as never;
assert(leanUsage(steps).total.costFromProvider === false, "lean's fold keeps the rule");
assert(
  leanUsage([{ outcome: { kind: "ok", dispatches: [loaded[0], loaded[2]] } }] as never).total
    .costFromProvider === true,
  "lean's fold: an unmarked row neither confirms nor denies",
);

const estimatedTurn = {
  type: "agent_end",
  messages: [
    {
      role: "assistant",
      usage: { input: 9, output: 4, cost: { total: 0.7, totalFromProvider: false } },
    },
  ],
};
const turn = lastAgentEndFinalTurn(JSON.stringify(estimatedTurn));
const cont = continuationRow({ ok: true, ms: 5, usage: turn.usage }, "developer", undefined);
const withCont = leanUsage([{ outcome: { kind: "ok", dispatches: [loaded[0], cont] } }] as never);
assert(
  cont.usage.cost === 0.7 &&
    withCont.total.costFromProvider === false &&
    withCont.byRole.developer?.costFromProvider === false,
  "an estimated session continuation keeps its cost and flag into lean's fold",
);

assert(
  buildCapabilities().features.usageCostFromProvider === true,
  "features.usageCostFromProvider is true",
);

process.exit(exit);
