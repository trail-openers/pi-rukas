#!/usr/bin/env bun
/**
 * The default is 3 concurrent groups. This reverses the v0.12.41 default-1
 * decision (operator decision 2026-08-26). The original measurement (69
 * terminal cycles, every autonomous merge ran alone, concurrent cycles ~2.4x
 * slower per role) was sound at the time but predates two structural changes:
 *   - #544 shipped capability-preserving dispatch caps (loop detector, typed
 *     kill causes) — the unbounded slow-dispatch behaviour that made concurrent
 *     cycles degrade each other is structurally different now.
 *   - Every workstream develops in its own detached worktree under .worktrees/
 *     and patches are applied under a single integration lock (in-process
 *     promise chain + O_EXCL lockfile), eliminating the shared repo-root
 *     contention that destroyed 2 of 4 nessie cycles at commit-pr.
 * The sequential default (1) was judged too conservative for current operator
 * workflow: a 6-group queue ran entirely sequential under cap=1.
 *
 * The knob still exists. An operator who wants strict sequentiality sets
 * `PI_ENSEMBLE_PARALLEL_GROUPS=1`; what changes is which way the default leans.
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
    MAX_PARALLEL_GROUPS_DEFAULT === 3,
    `canary: three concurrent groups by default (got ${MAX_PARALLEL_GROUPS_DEFAULT}) — operator decision 2026-08-26 reverting v0.12.41's sequential default`,
  );
  assert(
    withEnv({ PI_ENSEMBLE_PARALLEL_GROUPS: undefined, PI_ENSEMBLE_PARALLEL_WORK: undefined }, () =>
      resolvedParallelGroups(),
    ) === 3,
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
    withEnv({ PI_ENSEMBLE_PARALLEL_GROUPS: "not-a-number" }, () => resolvedParallelGroups()) === 3,
    "a garbage value falls back to the default (3) rather than to NaN",
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
  // though. It is what let nessie #626 spend 25.8 min posting a comment whose
  // body was already on disk. The property that was wanted is that the artefact
  // survives the dispatch, and `test-handoff-bounded.ts` asserts THAT
  // behaviourally — bound exceeded and dispatch thrown both still produce
  // `handoff-emitted` via the in-process `gh` path.
  //
  // So the bound is back, and what is checked here is the thing that makes it
  // safe: the fallback the bound hands off to must still exist. Post-#612
  // the fallback routes through the forge adapter (issueComment + labelCreate
  // + labelAdd) rather than raw `gh` exec.
  // #674 — the forge post was moved to work-driver-handoff-post.ts (file-size
  // hygiene). The canary reads the post module, not the handoff handler.
  const post = readFileSync(path.join(SRC, "work-driver-handoff-post.ts"), "utf8");
  assert(
    /forge\.issueComment/.test(post) &&
      /forge\.labelCreate/.test(post) &&
      /forge\.labelAdd/.test(post),
    "the handoff still posts the comment and applies the label in-process when the dispatch does not (via the forge adapter)",
  );

  // And the inactivity watchdog is deliberately UNCHANGED. It fires on 25
  // minutes of total silence. The structural fixes (#544 dispatch caps +
  // worktree isolation) remove the contention that made it bite; weakening a
  // genuine hang detector to accommodate causes we already fixed would be the
  // wrong repair.
  const support = readFileSync(path.join(SRC, "spawn-support.ts"), "utf8");
  assert(
    /return 25 \* 60_000;/.test(support),
    "the inactivity watchdog stays at 25 min — the slowdown that made it bite is what got fixed",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
