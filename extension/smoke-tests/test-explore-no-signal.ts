#!/usr/bin/env bun
/**
 * An explore reply the driver cannot read is not permission to build.
 *
 * Two channels can carry explore's decision: the `## Spec` block (intent path)
 * and the legacy `EXPLORE-VERDICT` token. `runExplore` tries the spec block
 * first and, when it does not parse, falls through to the legacy router — a
 * deliberate degradation so an older prompt or a drifting agent still works.
 *
 * The hole was what happened when **neither** channel said anything:
 * `parseExploreVerdict` returned null, no cap-hit fired, and the function
 * returned `next` — advancing to plan on a reply from which the driver had
 * extracted no decision whatsoever. Plan, branch and develop then ran blind.
 *
 * The single-issue intent cycle is the case that matters, and it is the common
 * one: `work-driver-prompts-early.ts` sets `useLegacyVerdict = !intentEnabled
 * || issues.length > 1`, so on that path the prompt **never asks for** the
 * legacy token the fallback looks for. The degradation could not fire by
 * construction — it could only ever fall through.
 */

import { exploreProducedNoSignal } from "../src/work-driver-explore.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// -------------------------------------------------------------- the hole

{
  assert(
    exploreProducedNoSignal(true, null),
    "canary: intent path, no spec block, no legacy verdict — this advanced to plan on a reply nobody could read",
  );
  assert(exploreProducedNoSignal(true, undefined), "...undefined is the same absence");
}

// ------------------------------------- the documented degradation survives

{
  // An older prompt still emits the legacy token. That is a real decision and
  // must keep working — this fix must not turn a supported fallback into a park.
  for (const v of ["NEEDS_WORK", "ALREADY_COMPLETE", "NEEDS_CLARIFICATION"]) {
    assert(
      !exploreProducedNoSignal(true, v),
      `a legacy ${v} verdict is a decision — the fallback still works`,
    );
  }
}

// ------------------------------------------- the legacy path is untouched

{
  // With the intent path off, the legacy router owns the decision and its
  // absent-verdict behaviour is pre-existing and out of scope here.
  assert(
    !exploreProducedNoSignal(false, null),
    "canary: with intent DISABLED nothing changes — the fix is scoped to the path that suppresses its own fallback",
  );
  assert(!exploreProducedNoSignal(false, "NEEDS_WORK"), "...and a legacy verdict still decides");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
