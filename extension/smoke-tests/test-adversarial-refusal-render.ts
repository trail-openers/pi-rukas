#!/usr/bin/env bun
/**
 * #1360 — the refusal RENDERER, split out of `test-adversarial-ledger-range.ts`
 * for the 500-line cap.
 *
 * `adversarialRefusal` is the string an operator reads when the merge guard
 * refuses a branch whose adversarial row the bindings rejected. It quotes the
 * row's own `detail` so the operator is not told to re-run a review that just
 * ran — which makes it a small renderer with three inputs it must survive: a
 * binding refusal, a row with no detail at all, and a LEGACY row whose detail
 * is not even a string (rows written before #1360 carry `detail` values this
 * code has never seen).
 *
 * The range/HEAD/tree BINDING arms live in `test-adversarial-ledger-range.ts`;
 * those decide `passed`, this one only says why.
 */

import {
  BINDING_REFUSAL_PREFIXES,
  BRANCH,
} from "./lib/adversarial-ledger-harness.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import { adversarialRefusal } from "../src/merge-guard-reads.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const rowAt = (over: Partial<LedgerEntry>): LedgerEntry =>
  ({
    branch: BRANCH,
    kind: "adversarial",
    patchId: "a".repeat(64),
    passed: false,
    at: Date.now(),
    ...over,
  }) as LedgerEntry;

const refused = adversarialRefusal(
  BRANCH,
  rowAt({
    detail: "range-not-branch: reviewed 1111aaaa..2222bbbb, branch range is 3333cccc..2222bbbb",
  }),
);
assert(
  refused.includes("range-not-branch: reviewed 1111aaaa..2222bbbb"),
  "adversarialRefusal: a binding refusal's detail is quoted verbatim",
);
assert(
  BINDING_REFUSAL_PREFIXES.some((p) => refused.includes(`${p}: `)),
  "adversarialRefusal: the quoted detail is one of the exported binding prefixes",
);

const bare = adversarialRefusal(BRANCH, rowAt({}));
assert(
  !bare.includes("detail:") && bare.includes("passed=false"),
  `adversarialRefusal: a row with no detail renders none (got ${JSON.stringify(bare.slice(0, 120))})`,
);

const legacy = adversarialRefusal(BRANCH, rowAt({ detail: 42 as never }));
assert(
  !legacy.includes("detail:") && legacy.includes("patchId=aaaaaaaa"),
  `adversarialRefusal: a legacy non-string detail renders as no detail, not "42" / "undefined" (got ${JSON.stringify(legacy.slice(0, 140))})`,
);

const multiline = adversarialRefusal(
  BRANCH,
  rowAt({ detail: "range-unverifiable: git said\nsecond line\ttabbed" }),
);
assert(
  !multiline.includes("\nsecond line") && multiline.includes("second line tabbed"),
  "adversarialRefusal: newlines and tabs in the detail collapse to spaces",
);

const long = adversarialRefusal(BRANCH, rowAt({ detail: `tree-changed: ${"x".repeat(600)}` }));
assert(
  long.length < 700 && long.includes("tree-changed:"),
  `adversarialRefusal: a runaway detail is clamped, the refusal stays one bounded line (${long.length} chars)`,
);

const none = adversarialRefusal(BRANCH, undefined);
assert(
  none.includes("latest: none") && none.includes("PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE"),
  "adversarialRefusal: no row on file still names the override",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
