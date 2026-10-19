#!/usr/bin/env bun
/**
 * #1677 — a carried row (still open from an earlier round, not resolved by this
 * one) is listed under its own "Carried from earlier rounds" heading in the
 * advisory section, after this round's own advisory findings. Pure rendering:
 * no git repo and no findings store, so it runs in milliseconds. The summary
 * and residual renderers are covered in test-review-findings-resolve.ts and
 * test-review-findings-lineless.ts, which drive them through the real review.
 */

import { advisorySection } from "../src/lens-review-advisory.ts";
import type { Finding } from "../src/lens-review-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const finding = (title: string, line: number): Finding => ({
  lens: "security",
  severity: "MEDIUM",
  path: "src/a.ts",
  line,
  title,
  description: `the finding text for ${title}`,
});

const freshAdvisory = finding("Fresh advisory", 4);
const oldAdvisory: Finding = { ...finding("Old advisory", 2), carried: true };
const text = advisorySection([oldAdvisory, freshAdvisory]).join("\n");
const carriedAt = text.indexOf("Carried from earlier rounds (1)");

assert(carriedAt > 0, "the carried advisory row sits under the labelled carried heading");
assert(
  text.indexOf("Fresh advisory") < carriedAt,
  "this round's own advisory finding is listed before the carried heading",
);
assert(
  text.indexOf("Old advisory") > carriedAt,
  "the carried row is listed after the carried heading, never with this round's findings",
);
assert(
  !advisorySection([freshAdvisory]).join("\n").includes("Carried from earlier rounds"),
  "no carried heading when no advisory row is carried",
);

process.exit(exit);
