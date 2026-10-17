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

import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Seams whose PRODUCTION caller main's #1187 deleted (the open-point gate became
 * topic-neutral and `security-class.ts` was removed), so no module fires them.
 * The exemption is not a free pass: `anySourceNamesSeam` still requires the id to
 * occur in some `src/` module, which is what distinguishes a seam retired on
 * purpose from one that is simply dead config.
 */
const RETIRED_SEAM_CALLERS: ReadonlySet<string> = new Set(["security-open-point"]);

/** Whether any `src/` module still names this seam id. */
function anySourceNamesSeam(key: string): boolean {
  const needle = `"${key}"`;
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith(".ts")) continue;
    try {
      if (readFileSync(path.join(SRC, name), "utf8").includes(needle)) return true;
    } catch {
      // Unreadable file: this seam is not named there.
    }
  }
  return false;
}

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
    // A seam main's #1187 left with no caller is excused, but only on the
    // positive evidence that SOME module names it — `git rm` of the last caller
    // (the #1187 case: `askSecuritySeam` deleted with `security-class.ts`) is a
    // retired seam, and a seam nothing references at all is dead config.
    new RegExp(`(?:\\bdecide|\\bshadowDecide)\\(\\s*"${key}"`).test(owner) ||
      (RETIRED_SEAM_CALLERS.has(key) && anySourceNamesSeam(key)),
    `seam ${key}: its owner ${spec.owner} calls decide("${key}") or shadowDecide("${key}")${RETIRED_SEAM_CALLERS.has(key) ? " (caller-less seam: some src/ module must still name it)" : ""}`,
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

// 4 — the per-field bounds (#1393) are part of the contract: a typo'd bound
// makes the seam rule-only rather than leaving a model-visible text unbounded.
assert(
  seamContractViolations(fixtureSpec({ fields: { tail: { max: 600, from: "end" } } })).length === 0,
  "a well-formed field bound is accepted",
);
assert(
  seamContractViolations(fixtureSpec({ fields: { tail: { max: 600 } } })).length === 0,
  "a bound with no direction is accepted (it defaults to the head)",
);
rejects({ fields: { tail: { max: 0 } } }, /positive max/, "a field bound with a zero max");
rejects({ fields: { tail: { max: -5 } } }, /positive max/, "a field bound with a negative max");
rejects(
  { fields: { tail: {} as { max: number } } },
  /positive max/,
  "a field bound with no max at all",
);
rejects(
  { fields: { tail: { max: 10, from: "middle" as "start" } } },
  /unknown direction/,
  "a field bound with an unknown direction",
);
// The two shadow seams must actually declare bounds, or the fix is inert: a
// caller handing over a whole provider message would get the record-wide bound
// only, with no per-field bound on the seam.
assert(
  Object.keys(SEAMS["failure-cause"].fields ?? {}).length >= 2 &&
    SEAMS["failure-cause"].fields?.lastOutput?.from === "end",
  "failure-cause bounds providerMessage and lastOutput, keeping the TAIL of the output",
);
assert(
  SEAMS["security-open-point"].fields?.openPoint !== undefined,
  "security-open-point bounds its openPoint field",
);

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
