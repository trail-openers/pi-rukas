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
 * those decide `passed`, this one only says why. The rejected-verdict arm also
 * lives here — it is about which `detail` the row carries.
 */

import { rmSync } from "node:fs";
import path from "node:path";
import { adversarialRefusal } from "../src/merge-guard-reads.ts";
import type { LedgerEntry } from "../src/review-ledger.ts";
import {
  BINDING_REFUSAL_PREFIXES,
  BRANCH,
  setupRepo,
  toolArm,
} from "./lib/adversarial-ledger-harness.ts";

// Env pins in assignment form: biome's noDelete rule refuses the
// `delete process.env.X` shape, and "" is equivalent for every reader (the
// ledger override is read via `?.trim()`, the merge guard's via `=== "1"`).
process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE = "";
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = "";
process.env.PI_ENSEMBLE_FORGE = "github";

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

// ─── a REJECTED tool review keeps its verdict detail, not a binding one
// Moved here from `test-adversarial-ledger-range.ts` for the 500-line cap. A
// rejection under `reportVerdict: "terminal"` maps to a passing-shaped result
// downstream but records `passed: false`, and the row must keep the verdict's
// own detail — a binding refusal would overwrite the reason the reviewer gave —
// and must not be decorated with range SHAs the decision never confirmed.
{
  const { dir, mergeBase } = setupRepo();
  try {
    const { row } = await toolArm(dir, {
      base: mergeBase,
      head: "HEAD",
      result: { ok: false, loopOutcome: "rejected" },
      binding: {},
    });
    assert(
      row.passed === false && row.detail === "rejected",
      `a rejected tool review keeps its verdict detail (got ${JSON.stringify(row.detail)})`,
    );
    assert(
      row.reviewedBase === undefined,
      "a rejected row is not decorated with binding fields it was never checked against",
    );
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
