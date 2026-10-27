#!/usr/bin/env bun
/**
 * #1377 — the cache entry guard (plan-investigation-guard.ts).
 *
 * The guard is the only thing between a hand-edited `pi-plan-cache` file and a
 * verbatim filing, so it has to reject the shapes the render and the digest
 * would not reproduce. Two rules carry that, both from the #1377 review:
 *
 *   - plain object only — `Object.create({ line })` passes a bare `typeof
 *     o.line` while the object has no line of its own;
 *   - own keys only — the provenance render and digest enumerate `Object.keys`,
 *     so anything inherited or symbol-keyed validates here and renders nothing
 *     there: a digest covering bytes the body never carried.
 *
 * The provenance half defers to `validateProvenance` rather than restating it,
 * and to all of it rather than to the shape alone: this suite pins both halves
 * — that the two agree on every shape, and that a well-shaped entry carrying a
 * bad VALUE (a line terminator, a `@`, an over-long line, a malformed marker
 * key) is a miss. Shape alone would file a hand-edited `"ok\n## Open points"`
 * verbatim through the gate the tool closes.
 *
 * Run: cd extension && bun run smoke-tests/test-plan-investigation-guard.ts
 */
import { isCacheEntry } from "../src/plan-investigation-guard.ts";
import { EXCLUSION_DISCLOSURE_MAX_ROWS } from "../src/plan-duplicate-disclosure.ts";
import { isProvenanceShape, validateProvenance } from "../src/plan-provenance.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A well-formed entry the guard must accept — the baseline every case below mutates. */
function entry(): Record<string, unknown> {
  return {
    key: "k",
    createdAt: 1,
    inventory: { memory: [], related: [], errors: [] },
    barrier: { findings: [], neverClaimDisclosure: [] },
    gaps: [],
    reviewed: {
      fileable: true,
      title: "T",
      spec: "BODY",
      priorContext: [],
      labels: ["auto-filed"],
      provenance: { line: "filed by the loop", marker: { run: "cron" } },
    },
  };
}

/** The entry with `reviewed.provenance` replaced — the one mutation both blocks share. */
function withProv(value: unknown): Record<string, unknown> {
  const e = entry();
  (e.reviewed as Record<string, unknown>).provenance = value;
  return e;
}

console.log("the entry shape:");
{
  const accepted: unknown = entry();
  assert(isCacheEntry(accepted) === true, "a well-formed entry is accepted");
  assert(isCacheEntry(null) === false, "null is not an entry");
  assert(isCacheEntry("string") === false, "a string is not an entry");
  assert(isCacheEntry([]) === false, "an array is not an entry");
}

console.log("plain-object rule:");
{
  const inherited = Object.create(entry());
  assert(isCacheEntry(inherited) === false, "an entry whose fields are inherited is rejected");
  const e = entry();
  Object.setPrototypeOf(e, { key: "k", createdAt: 1 });
  assert(isCacheEntry(e) === false, "an entry with an Object.create(null) shape is rejected");
}

console.log("own-key rule (the render/digest agreement):");
{
  // A non-enumerable own key is invisible to `Object.keys` (what the render and
  // the digest walk) but visible to a guard that reads `x.field` — precisely the
  // bytes that would be hashed and never filed.
  const e = entry();
  Object.defineProperty(e, "createdAt", { value: 1, enumerable: false });
  assert(
    isCacheEntry(e) === false,
    "a non-enumerable own key is rejected — the digest would cover what the render cannot see",
  );

  const sym = entry();
  Object.defineProperty(sym, Symbol("extra"), { value: 1 });
  assert(
    isCacheEntry(sym) === false,
    "a symbol-keyed property is rejected — it renders and digests as nothing",
  );
}

console.log("provenance: the guard defers to the one validator (no drift):");
{
  const cases: [string, unknown][] = [
    ["well-formed", { line: "l", marker: { a: "1" } }],
    ["__proto__-keyed marker", { line: "l", marker: JSON.parse('{"__proto__":"x"}') }],
    ["prototype-held marker", { line: "l", marker: Object.create({ a: "1" }) }],
    ["inherited line", Object.create({ line: "l", marker: { a: "1" } })],
    ["symbol-keyed marker", { line: "l", marker: { [Symbol("a")]: "1" } }],
    ["non-string marker value", { line: "l", marker: { a: 1 } }],
    ["array marker", { line: "l", marker: [] }],
    ["no marker", { line: "l" }],
    ["null", null],
  ];
  for (const [name, value] of cases) {
    const e = entry();
    (e.reviewed as Record<string, unknown>).provenance = value;
    const guard = isCacheEntry(e);
    const validator = value === undefined ? true : isProvenanceShape(value);
    assert(
      guard === validator,
      `guard and validator agree on the "${name}" provenance (guard=${guard} validator=${validator})`,
    );
  }
  // The agreement is now with `validateProvenance`, not the shape predicate: on
  // a shaped object with a bad value the two differ, and the guard follows the
  // validator. That divergence is the fix, so it is asserted explicitly rather
  // than left to the block below.
  const shapedButBad = { line: "ok\n## x", marker: {} };
  assert(
    isProvenanceShape(shapedButBad) === true &&
      validateProvenance(shapedButBad).ok === false &&
      isCacheEntry(withProv(shapedButBad)) === false,
      "the guard follows validateProvenance where isProvenanceShape would have accepted (a shaped line carrying a terminator)",
  );
}

console.log("provenance: the guard applies the FULL value rules, not just the shape:");
{
  // A hand-edited cache file is JSON, so its SHAPE is nearly always right —
  // `{ line: string, marker: object }` costs nothing to fake. What the
  // pre-dispatch gate actually refuses is VALUES. A guard that calls only
  // `isProvenanceShape` admits every one of the cases below and files them
  // verbatim through the door the tool closed, which is the whole point of this
  // block: the assertion that matters is that a shaped-but-invalid value is a
  // MISS. Terminators are built from code points so no invisible byte hides in
  // this file (and so a formatter cannot replace one silently).
  const terminators = [0x0a, 0x0d, 0x0b, 0x0c, 0x0085, 0x2028, 0x2029].map(
    (cp) => `ok${String.fromCodePoint(cp)}## x`,
  );
  const valueCases: [string, unknown][] = [
    ...terminators.map((line) => [`a terminator in the line (${JSON.stringify(line)})`, { line, marker: {} }] as [string, unknown]),
    ["a NUL in the line", { line: "ok\u0000x", marker: {} }],
    ["a DEL in the line", { line: "ok\u007fx", marker: {} }],
    ["an '@' in the line", { line: "filed by @someone", marker: {} }],
    ["a '<' in the line", { line: "ok<script>", marker: {} }],
    ["an over-long line", { line: "x".repeat(301), marker: {} }],
    ["an empty line", { line: "    ", marker: {} }],
    ["an uppercase marker key", { line: "ok", marker: { Bad_Key: "v" } }],
    ["a marker value with a space", { line: "ok", marker: { k: "has space" } }],
    ["a marker value with a newline", { line: "ok", marker: { k: "a\nb" } }],
  ];
  for (const [name, value] of valueCases) {
    const e = entry();
    (e.reviewed as Record<string, unknown>).provenance = value;
    assert(
      isCacheEntry(e) === false,
      `the guard refuses a well-shaped but INVALID provenance value: ${name}`,
    );
  }
  // And the honest one still passes — the block above is only meaningful if the
  // rule is not simply "reject provenance".
  const good = entry();
  assert(
    isCacheEntry(good) === true,
    "the guard still accepts a valid provenance (the value rules are not a blanket refusal)",
  );
}

console.log("the rest of the entry still guards:");
{
  // Each mutator is a STATEMENT body, not an arrow-expression assignment: the
  // lint refuses `e.key = 7` inside an expression, and a table of mutators is
  // the cheapest way to assert the six independent field guards the same way.
  const mutate = (e: Record<string, unknown>, what: string): void => {
    const reviewed = e.reviewed as Record<string, unknown>;
    if (what === "key") {
      e.key = 7;
    } else if (what === "createdAt") {
      e.createdAt = "1";
    } else if (what === "finding") {
      (e.barrier as Record<string, unknown>).findings = [{ name: "a", ok: true, toolUses: [] }];
    } else if (what === "gap") {
      e.gaps = [{ severity: "BLOCKER", description: "d", resolution: "r" }];
    } else if (what === "labels") {
      reviewed.labels = [42];
    } else if (what === "empty spec") {
      reviewed.fileable = true;
      reviewed.spec = "   ";
    } else if (what === "downgradedFrom is not a string") {
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "medium",
        rationale: "self",
        downgradedFrom: 7,
      };
    } else if (what === "excludedIssues is not an array") {
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "medium",
        rationale: "self",
        excludedIssues: "1856",
      };
    } else if (what === "an excluded issue is missing its reason") {
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "medium",
        rationale: "self",
        excludedIssues: [{ number: 1856, state: "OPEN", title: "t" }],
      };
    } else if (what === "a downgrade that suppressed nothing") {
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "medium",
        rationale: "self",
        downgradedFrom: "high",
        excludedIssues: [],
      };
    } else if (what === "a downgrade of a level that was never high") {
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "low",
        rationale: "self",
        downgradedFrom: "high",
        excludedIssues: [{ number: 1856, state: "OPEN", title: "t", reason: "the subject" }],
      };
    } else if (what === "excludedIssues past the bound the disclosure budgets") {
      // #1856 review round 4: the renderer never reads more than
      // EXCLUSION_DISCLOSURE_MAX_ROWS rows and the producer emits at most one row
      // per named token, so an array an order of magnitude past that is bytes no
      // filter wrote — and the guard must not walk an unbounded array from a
      // hand-edited file.
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "medium",
        rationale: "self",
        downgradedFrom: "high",
        excludedIssues: Array.from({ length: EXCLUSION_DISCLOSURE_MAX_ROWS * 10 + 1 }, (_, i) => ({
          number: 100 + i,
          state: "CLOSED",
          title: "t",
          reason: "the subject",
        })),
      };
    } else if (what === "excludedIssues with no downgradedFrom to explain them") {
      // The pair the producer writes: rows always arrive with the downgrade that
      // produced them. Suppressed candidates claiming that nobody suppressed
      // anything is a disclosure asserting the opposite of its own bytes.
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "medium",
        rationale: "self",
        excludedIssues: [{ number: 1856, state: "OPEN", title: "t", reason: "the subject" }],
      };
    } else if (what === "an unknown duplicate-risk level") {
      (e.barrier as Record<string, unknown>).duplicateRisk = {
        level: "HIGH",
        rationale: "self",
      };
    }
  };
  const cases: [string, string][] = [
    ["key is not a string", "key"],
    ["createdAt is not a number", "createdAt"],
    ["a finding is missing its text", "finding"],
    ["a gap carries an unknown severity", "gap"],
    ["labels are not strings", "labels"],
    ["a fileable entry carries an empty spec", "empty spec"],
    // #1856: the duplicate-risk verdict gained optional fields; a cached entry
    // whose new fields are malformed must be a miss, not a filing whose
    // disclosure renders bytes the guard never admitted.
    ["a downgraded duplicateRisk carries a non-string level", "downgradedFrom is not a string"],
    ["a duplicateRisk's excludedIssues is not an array", "excludedIssues is not an array"],
    ["an excluded duplicate is missing its reason", "an excluded issue is missing its reason"],
    // #1856 round 2: a downgrade is a claim the operator reads, so an internally
    // inconsistent one is a miss — a `high`→X downgrade must be medium and must
    // name what it suppressed, and level must be one of the four marker values.
    ["a downgrade that suppressed no issue", "a downgrade that suppressed nothing"],
    ["a downgrade whose level is not medium", "a downgrade of a level that was never high"],
    // #1856 round 4: the array itself is bounded, and a downgrade and its rows
    // are a pair in both directions.
    [
      "a duplicateRisk whose excludedIssues exceed the bound",
      "excludedIssues past the bound the disclosure budgets",
    ],
    [
      "a duplicateRisk with excludedIssues and no downgradedFrom",
      "excludedIssues with no downgradedFrom to explain them",
    ],
    ["a duplicate-risk level outside the marker's four values", "an unknown duplicate-risk level"],
  ];
  for (const [name, what] of cases) {
    const e = entry();
    mutate(e, what);
    assert(isCacheEntry(e) === false, `${name} is a miss, not a filing`);
  }
}

{
  // #1856: the extended shape the driver WRITES must round-trip the guard — the
  // pre-#1856 two-field shape stays valid too, so an entry written before the
  // source-issue exclusion existed is still a hit.
  const e = entry();
  (e.barrier as Record<string, unknown>).duplicateRisk = {
    level: "medium",
    rationale: "DUPLICATE_RISK: high — #1856 restates this",
    downgradedFrom: "high",
    downgradeReason: "the plan's own subject",
    excludedIssues: [{ number: 1856, state: "OPEN", title: "self", reason: "the subject" }],
  };
  assert(isCacheEntry(e) === true, "the #1856 extended duplicateRisk shape is a cache hit");
  const legacy = entry();
  (legacy.barrier as Record<string, unknown>).duplicateRisk = {
    level: "high",
    rationale: "duplicates #5",
  };
  assert(isCacheEntry(legacy) === true, "the pre-#1856 two-field verdict stays a cache hit");
}

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-investigation-guard`);
process.exit(exit);
