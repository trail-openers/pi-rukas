#!/usr/bin/env bun
/**
 * SEAMS — the decision-seam registry stays true (#1308), modelled on
 * test-marker-contracts.ts.
 *
 *   1. every registered seam satisfies `seamContractViolations`, its key is
 *      its id, and its owner module exists and calls `decide("<id>"`;
 *   2. the validator actually rejects each unsafe shape the epic forbids —
 *      a gate never observed to fail is worthless: tie-break on a fail-closed
 *      seam, replace without an evidence check, a score question under
 *      may-add-only or tie-break, a missing field, and a new seam that
 *      enforces before any evidence says it should;
 *   3. fail-closed is derived from the rule's default, not declared.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SEAMS,
  type SeamSpec,
  isFailClosed,
  seamContractViolations,
} from "../src/decision-seam-registry.ts";
import { fixtureSpec, makeAssert } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const SRC = path.resolve(import.meta.dirname, "..", "src");

// 1 — the real registry.
const entries = Object.entries(SEAMS as Record<string, SeamSpec>);
assert(entries.length > 0, `the registry declares ${entries.length} seam(s)`);
for (const [key, spec] of entries) {
  const v = seamContractViolations(spec);
  assert(
    v.length === 0,
    `seam ${key}: satisfies the contract${v.length ? ` (${v.join("; ")})` : ""}`,
  );
  assert(spec.id === key, `seam ${key}: registry key equals its id`);
  let owner = "";
  try {
    owner = readFileSync(path.join(SRC, spec.owner), "utf8");
  } catch {
    assert(false, `seam ${key}: owner ${spec.owner} exists`);
    continue;
  }
  assert(
    // A shadow seam's owner fires decide() through shadowDecide (decision-shadow.ts).
    new RegExp(`(?:\\bdecide|\\bshadowDecide)\\(\\s*"${key}"`).test(owner),
    `seam ${key}: its owner ${spec.owner} calls decide("${key}") or shadowDecide("${key}")`,
  );
}

// 2 — the validator rejects every forbidden shape.
const rejects = (over: Partial<SeamSpec>, needle: RegExp, msg: string) => {
  const v = seamContractViolations(fixtureSpec(over));
  assert(
    v.some((x) => needle.test(x)),
    `rejects ${msg}${v.length ? "" : " (accepted!)"}`,
  );
};
assert(seamContractViolations(fixtureSpec()).length === 0, "the baseline fixture is valid");
rejects(
  { composition: "tie-break" },
  /tie-break on a fail-closed/,
  "tie-break on a fail-closed seam",
);
assert(
  seamContractViolations(fixtureSpec({ composition: "tie-break", ruleDefault: "ok" })).length === 0,
  "...but accepts tie-break when the rule's default passes",
);
rejects(
  { composition: "replace", evidence: "none" },
  /replace without/,
  "replace without evidence",
);
rejects(
  {
    kind: "score",
    labels: { low: "l", mid: "m", high: "h" },
    ruleDefault: "low",
    passing: ["high"],
    composition: "may-add-only",
  },
  /score question/,
  "a score question under may-add-only",
);
rejects(
  {
    kind: "score",
    labels: { low: "l", mid: "m", high: "h" },
    ruleDefault: "high",
    passing: ["high"],
    composition: "tie-break",
  },
  /score question/,
  "a score question under tie-break",
);
for (const f of [
  "id",
  "kind",
  "instructions",
  "labels",
  "ruleDefault",
  "passing",
  "composition",
  "defaultMode",
  "evidence",
  "owner",
  "timeoutMs",
  "tokenBudget",
] as const) {
  const spec: Partial<SeamSpec> = fixtureSpec();
  delete spec[f];
  assert(
    seamContractViolations(spec).includes(`missing field: ${f}`),
    `rejects a seam missing '${f}'`,
  );
}
rejects(
  { ...SEAMS["policy-judge"], id: "my-new-seam" },
  /starts in shadow/,
  "a new seam copying the judge's enforcing shape — grandfathering is a closed list, not a field",
);
rejects({ defaultMode: "enforce" }, /starts in shadow/, "a new seam that enforces by default");
rejects(
  { labels: { true: "t", maybe: "m" }, kind: "bool", ruleDefault: "true", passing: ["true"] },
  /bool/,
  "a bool seam with non-bool labels",
);
rejects({ ruleDefault: "nope" }, /ruleDefault/, "a rule default that is not a label");
rejects({ passing: ["ok", "flag"] }, /every label passes/, "a seam where nothing can fail");
rejects(
  { labels: { ok: "o", undecided: "u" }, ruleDefault: "ok", passing: ["ok"] },
  /reserved/,
  "'undecided' as a label",
);

// 3 — fail-closed is a derivation.
assert(isFailClosed(fixtureSpec()), "a seam whose rule defaults to a non-pass is fail-closed");
assert(!isFailClosed(fixtureSpec({ ruleDefault: "ok" })), "...and one defaulting to a pass is not");
assert(
  isFailClosed(SEAMS["policy-judge"]),
  "the policy judge is fail-closed (it defaults to unstated)",
);

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
