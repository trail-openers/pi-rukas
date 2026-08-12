#!/usr/bin/env bun
/**
 * `proceed` has to be a decision about something.
 *
 * `specIsComplete` had exactly one caller — inside `if (spec.verdict === "park")`
 * — where it exists to REFUTE a park: a spec good enough to overturn an
 * "underspecified" verdict. Nothing ever asked the symmetric question, so
 * `INTENT-VERDICT: proceed` was accepted with zero deliverables, zero
 * acceptance criteria and no intent. The module's own docstring claimed
 * otherwise.
 *
 * The knock-on is quiet and downstream: `work-driver-plan.ts` falls back to
 * `countEnumeratedFindings` when `deliverables.length === 0`, so #290's
 * under-decomposition arithmetic degrades on exactly this input — the whole
 * cycle plans, branches and builds against a spec that named nothing to build.
 *
 * The bar here is deliberately LOWER than `specIsComplete`, in two ways.
 *
 * `specIsComplete` demands a confirmed evidence row — the right price for
 * overturning a park, the wrong price for proceeding, since a straightforward
 * issue with no contested claims has no evidence to confirm.
 *
 * Acceptance criteria are not required either. Demanding them looked right and
 * was wrong: `proceed-with-assumptions` exists precisely for a spec with a
 * defensible gap, and two existing tests (`test-intent-resolution.ts`,
 * `test-work-driver-skeleton.ts`) document cycles that proceed without them —
 * they caught the over-tightening. The bar has to be the thing whose absence
 * actually breaks something downstream, which is deliverables, not everything
 * one might wish a spec had.
 */

import { specIsActionable } from "../src/work-driver-intent.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const spec = (over: Partial<NormalisedSpec>): NormalisedSpec =>
  ({
    intent: "Add a startup check for the provider retry ceiling",
    deliverables: [
      {
        id: "d1",
        description: "retry-config-check.ts warns when maxRetryDelayMs is below 60s",
        paths: ["extension/src/retry-config-check.ts"],
      },
    ],
    acceptanceCriteria: ["A host at 10000 produces a warning naming the file to edit"],
    evidence: [],
    assumptions: [],
    openQuestions: [],
    verdict: "proceed",
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture; only the read fields matter
    ...over,
  }) as any as NormalisedSpec;

// ------------------------------------------------------ what proceed requires

{
  assert(specIsActionable(spec({})), "a spec with an intent and a deliverable is actionable");

  assert(
    !specIsActionable(spec({ deliverables: [] })),
    "canary: no deliverables is NOT actionable — accepted before, and it degrades plan's decomposition arithmetic",
  );
  assert(
    specIsActionable(spec({ acceptanceCriteria: [] })),
    "a spec with no acceptance criteria STILL proceeds — see the note above on why the bar stops at deliverables",
  );
  assert(!specIsActionable(spec({ intent: "   " })), "no intent is not actionable");
  assert(
    !specIsActionable(spec({ deliverables: [{ id: "d1", description: "  ", paths: [] }] })),
    "...and a whitespace-only deliverable does not count as content",
  );
}

// -------------------------- deliberately looser than the park-refutation bar

{
  // `specIsComplete` additionally demands a confirmed evidence row. A
  // straightforward issue with no contested claims has none, and parking it
  // would be a regression — so the proceed gate must NOT inherit that clause.
  const noEvidence = spec({ evidence: [] });
  assert(
    specIsActionable(noEvidence),
    "canary: a spec with no evidence rows still proceeds — the confirmed-evidence bar belongs to refuting a park, not to proceeding",
  );
}

{
  // But a blocking open question is a real reason to stop, on either path.
  const blocked = spec({
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    openQuestions: [{ text: "Which config file wins?", blocking: true } as any],
  });
  assert(
    !specIsActionable(blocked),
    "a blocking open question stops a proceed — the answer changes what gets built",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
