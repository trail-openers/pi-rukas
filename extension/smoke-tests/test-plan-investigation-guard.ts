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
 * The provenance half defers to `isProvenanceShape` rather than restating it;
 * this suite pins that the deferral is REAL (the two agree on every case), which
 * is the property a duplicated predicate loses silently.
 *
 * Run: cd extension && bun run smoke-tests/test-plan-investigation-guard.ts
 */
import { isCacheEntry } from "../src/plan-investigation-guard.ts";
import { isProvenanceShape } from "../src/plan-provenance.ts";

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
    }
  };
  const cases: [string, string][] = [
    ["key is not a string", "key"],
    ["createdAt is not a number", "createdAt"],
    ["a finding is missing its text", "finding"],
    ["a gap carries an unknown severity", "gap"],
    ["labels are not strings", "labels"],
    ["a fileable entry carries an empty spec", "empty spec"],
  ];
  for (const [name, what] of cases) {
    const e = entry();
    mutate(e, what);
    assert(isCacheEntry(e) === false, `${name} is a miss, not a filing`);
  }
}

console.log(`\n${exit === 0 ? "PASS" : "FAIL"} test-plan-investigation-guard`);
process.exit(exit);
