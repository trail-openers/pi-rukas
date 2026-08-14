#!/usr/bin/env bun
/**
 * Concurrent cycles do not finish. Serialise them.
 *
 * Measured across 69 terminal cycles in the durable session store and 29 state
 * files: **every one of the 10 autonomous merges ran with zero other cycles in
 * flight.** No exception. Cycles that ran alongside another were ~2.4× slower
 * per role — which is what pushes a developer past the 25-minute inactivity
 * watchdog and `ops` past its cap — and two of the four lantern cycles that
 * reached commit-pr were destroyed by each other through the shared repo-root
 * integration point rather than by anything wrong with their own work.
 *
 * This reverses a previous judgement, deliberately. The old default of 3 was
 * chosen because "strict sequentiality is what made /work slow enough to be a
 * standing complaint", and 3 sat inside a band other tools use. That reasoning
 * was sound in the abstract and is contradicted by this repo's own record: a
 * cycle that never merges is not fast.
 *
 * The knob still exists. An operator who wants concurrency sets
 * `PI_ENSEMBLE_PARALLEL_GROUPS`; what changes is which way the default leans.
 */

import {
  MAX_PARALLEL_GROUPS_DEFAULT,
  resolvedParallelGroups,
} from "../src/work-driver-grouping.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// -------------------------------------------------------- the default

{
  assert(
    MAX_PARALLEL_GROUPS_DEFAULT === 1,
    `canary: cycles run one at a time by default (got ${MAX_PARALLEL_GROUPS_DEFAULT}) — every autonomous merge on record had zero concurrent cycles`,
  );
  assert(
    withEnv({ PI_ENSEMBLE_PARALLEL_GROUPS: undefined, PI_ENSEMBLE_PARALLEL_WORK: undefined }, () =>
      resolvedParallelGroups(),
    ) === 1,
    "...and that is what the queue actually resolves with no env set",
  );
}

// ------------------------------------------ the operator can still opt in

{
  assert(
    withEnv({ PI_ENSEMBLE_PARALLEL_GROUPS: "3" }, () => resolvedParallelGroups()) === 3,
    "an operator who wants concurrency still gets it — this changes the default, not the capability",
  );
  assert(
    withEnv({ PI_ENSEMBLE_PARALLEL_GROUPS: "3", PI_ENSEMBLE_PARALLEL_WORK: "0" }, () =>
      resolvedParallelGroups(),
    ) === 1,
    "...and the pre-existing hard-off switch still wins",
  );
  assert(
    withEnv({ PI_ENSEMBLE_PARALLEL_GROUPS: "not-a-number" }, () => resolvedParallelGroups()) === 1,
    "a garbage value falls back to the default rather than to NaN",
  );
}

// ------------------------------ the terminal step must not die on a cap

{
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const SRC = path.resolve(import.meta.dirname, "..", "src");

  // `handoff` is where the operator finds out what happened, so this file used
  // to assert the dispatch carried NO timeout override at all: a killed handoff
  // had left the operator with nothing — no comment, no label, no artefact —
  // twice in one overnight run. Unbounded is not the property that was wanted,
  // though. It is what let lantern #626 spend 25.8 min posting a comment whose
  // body was already on disk. The property that was wanted is that the artefact
  // survives the dispatch, and `test-handoff-bounded.ts` asserts THAT
  // behaviourally — bound exceeded and dispatch thrown both still produce
  // `handoff-emitted` via the in-process `gh` path.
  //
  // So the bound is back, and what is checked here is the thing that makes it
  // safe: the fallback the bound hands off to must still exist.
  const handoff = readFileSync(path.join(SRC, "work-driver-handoff.ts"), "utf8");
  assert(
    /gh \$\{objType\} comment/.test(handoff) && /--add-label needs-human-attention/.test(handoff),
    "the handoff still posts the comment and applies the label in-process when the dispatch does not",
  );

  // And the inactivity watchdog is deliberately UNCHANGED. It fires on 25
  // minutes of total silence, which only became too tight because concurrency
  // made every role ~2.4x slower. Serialising removes that; weakening a genuine
  // hang detector to accommodate a cause we just fixed would be the wrong
  // repair.
  const support = readFileSync(path.join(SRC, "spawn-support.ts"), "utf8");
  assert(
    /return 25 \* 60_000;/.test(support),
    "the inactivity watchdog stays at 25 min — the slowdown that made it bite is what got fixed",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
