#!/usr/bin/env bun
/**
 * AC3 (#2030) — what `causeFromIntegrateFailure` says when integrate() failed
 * while APPLYING the consolidation.
 *
 * `integrate()` already reports the structured discriminator `failure: "apply"`
 * for both the cherry-pick-conflict and the patch-apply arms, and the
 * `CommitPrFallbackCause` union already carries `"apply-conflict"`. The
 * classifier dropped the discriminator on the floor: every apply failure was
 * reported to the operator as `other`, so a conflict park blamed the change
 * rather than the pick.
 *
 * Fails today on the "apply" → "apply-conflict" arms (the union gains no new
 * member: an unreadable discriminator still answers "other").
 */
import { causeFromIntegrateFailure } from "../src/work-driver-commit-helpers.ts";
import type { IntegrateResult } from "../src/work-driver-integrate.ts";

const FILE = "test-AC3-integrate-apply-cause.ts";
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`FAIL ${FILE}: ${msg}`);
    exit = 1;
  }
}

const apply = (failure: string): IntegrateResult =>
  ({ ok: false, reason: "cherry-pick conflict — the batch was aborted.", failure } as IntegrateResult);

assert(
  causeFromIntegrateFailure(apply("apply")) === "apply-conflict",
  `integrate() failure "apply" maps to cause "apply-conflict" (got ${JSON.stringify(causeFromIntegrateFailure(apply("apply")))})`,
);
assert(
  causeFromIntegrateFailure(apply("dirty-repoRoot")) === "dirty-repoRoot",
  "the existing dirty-repoRoot mapping is unchanged",
);
assert(
  causeFromIntegrateFailure(apply("push-refused")) === "push-refused",
  "the existing push-refused mapping is unchanged",
);
// A failure with no discriminator is not an apply failure: it stays "other",
// so this is a mapping, not a catch-all.
assert(
  causeFromIntegrateFailure({ ok: false, reason: "unreadable" } as IntegrateResult) === "other",
  "an unreadable discriminator still answers \"other\" (no new union member)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
