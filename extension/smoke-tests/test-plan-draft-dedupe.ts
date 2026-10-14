#!/usr/bin/env bun
/**
 * #1151 — the duplicate stage (plan-draft-dedupe.ts) drops only true restatements
 * of an operator line. An item that adds a requirement is kept, and an
 * acceptance-criterion paraphrase survives the stage and renders exactly once.
 */

import type { OperatorDirectives } from "../src/plan-directives.ts";
import { type AngleFindings, draftSpec } from "../src/plan-draft.ts";
import { dedupeAgainstOperatorLines } from "../src/plan-draft-dedupe.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const OP = "Do not change the retry backoff default in provider config";

// -------------------------------------------------
// 1. Keep: an item that adds a requirement to an operator line is not a duplicate.
{
  const adds = "Do not change retry backoff; add a test for the backoff timer";
  const res = dedupeAgainstOperatorLines([{ kind: "edge-case", text: adds, angle: "e" }], [OP]);
  assert(
    res.kept.length === 1 && res.dropped.length === 0,
    "keep: an item that adds a test requirement to the operator line survives",
  );
}

// -------------------------------------------------
// 2. Drop: a true paraphrase (same content tokens, same polarity) is a duplicate.
{
  const paraphrase = "retry backoff default: do not change it in provider config";
  const res = dedupeAgainstOperatorLines(
    [{ kind: "edge-case", text: paraphrase, angle: "e" }],
    [OP],
  );
  const [first] = res.dropped;
  assert(
    res.kept.length === 0 && first?.reason === "duplicate" && first.against === OP,
    "drop: a token-subset paraphrase of the operator line is a duplicate",
  );
}

// -------------------------------------------------
// 3. Endorsed items (settled in an operator line's favour) are never deduplicated.
{
  const paraphrase = "retry backoff default: do not change it in provider config";
  const item = { kind: "edge-case" as const, text: paraphrase, angle: "e" };
  const res = dedupeAgainstOperatorLines([item], [OP], new Set([item]));
  assert(res.kept.length === 1 && res.dropped.length === 0, "endorsed: a settled item is kept");
}

// -------------------------------------------------
// 4. The duplicate stage and the plan-draft render together: an acceptance
//    criterion paraphrasing an operator line is exempt from dedupe and renders
//    exactly once (under "Suggested additional criteria").
{
  const OP_AC = "every caller keeps protectedPathsIn unchanged";
  const AC_PARAPHRASE = "protectedPathsIn unchanged for every caller";
  const directives: OperatorDirectives = {
    acceptanceCriteria: [OP_AC],
    pitfalls: [],
    outOfScope: [],
  };
  const findings: AngleFindings[] = [
    {
      name: "criteria",
      ok: true,
      text: "",
      toolUses: [{ kind: "acceptance-criterion", text: AC_PARAPHRASE, angle: "criteria" }],
    },
  ];
  const r = draftSpec("feature", "protected paths", findings, [], [], [], 0, directives, []);
  const occurrences = r.body.split(AC_PARAPHRASE).length - 1;
  assert(
    occurrences === 1,
    `render: an AC paraphrasing an operator line appears once (found ${occurrences})`,
  );
  assert(
    !r.body.includes("dropped: duplicate of operator line"),
    "render: the AC paraphrase is not dropped by the duplicate stage",
  );
}

process.exit(exit);
