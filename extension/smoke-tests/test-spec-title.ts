#!/usr/bin/env bun
/**
 * #1773 — the spec's PR title: explore writes `### Title`, the driver keeps a
 * fitting one, asks exactly once when it does not fit, and drops it (so the PR
 * falls back to the whole issue title) when the second answer still does not.
 */

import { parseNormalisedSpec } from "../src/work-driver-intent.ts";
import { readTitleAnswer, settleSpecTitle } from "../src/work-title.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const reply = (title: string) =>
  `INTENT-VERDICT: proceed\n\n## Spec\n\n### Intent\nStop the loop.\n\n### Title\n${title}\n\n### Deliverables\n- d1: fix it [paths: a.ts]\n`;

const spec = parseNormalisedSpec(reply("Stop refine from naming its own issue as a duplicate"));
assert(
  spec?.title === "Stop refine from naming its own issue as a duplicate",
  `the spec parser reads ### Title (got ${JSON.stringify(spec?.title)})`,
);
assert(
  parseNormalisedSpec(reply("").replace("### Title\n\n", ""))?.title === undefined,
  "no ### Title → no title",
);

if (spec) {
  let asks = 0;
  const ask = (answer: string) => async () => {
    asks++;
    return answer;
  };

  const kept = await settleSpecTitle(spec, ask("unused"));
  assert(kept.title === spec.title && asks === 0, "a fitting title is kept and nothing is asked");

  const long = { ...spec, title: "word ".repeat(20).trim() };
  asks = 0;
  const fixed = await settleSpecTitle(long, ask("Title: `Stop refine naming its own issue`"));
  assert(
    fixed.title === "Stop refine naming its own issue" && asks === 1,
    `an over-long title is asked for once and the fitting answer used (got ${JSON.stringify(fixed.title)}, ${asks} ask)`,
  );

  asks = 0;
  const still = await settleSpecTitle(long, ask("word ".repeat(20)));
  assert(
    still.title === undefined && asks === 1,
    "a second answer that still does not fit drops the title after one ask",
  );

  const noSession = await settleSpecTitle(long, undefined);
  assert(noSession.title === undefined, "no session to ask → the over-long title is dropped");

  asks = 0;
  const cut = await settleSpecTitle(long, ask("Stop refine naming its own…"));
  assert(cut.title === undefined, "an answer that trails off in an ellipsis is not a title");
}

assert(
  readTitleAnswer("\n- **Title:** Keep titles whole\nmore") === "Keep titles whole",
  "the answer reader strips labels and markers",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
