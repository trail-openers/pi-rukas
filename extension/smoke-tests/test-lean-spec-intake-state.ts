/**
 * test-lean-spec-intake-state — the persisted derived contract, the accessor's
 * rule, and what the run's PR says about it.
 *
 * Three things a `require`-mode run never exercised, each of which fails quietly
 * if it is wrong:
 *
 *   1. the run record must round-trip `derivedSpec` — a step that resumed without
 *      it would build against criteria its earlier steps never saw, and the
 *      cheapest way to find that is on disk rather than in review;
 *   2. the accessor must prefer the body's block and stand in ONLY for the
 *      missing-block reason — standing in for a malformed block would let a
 *      broken authored contract pass as someone else's good one;
 *   3. the PR body must say `spec: derived` when the record says so and print
 *      nothing when it does not, because the line's whole purpose is telling a
 *      reviewer which claim to check.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishBody } from "../src/lean/publish-body.ts";
import { specFor, specSource } from "../src/lean/spec-for.ts";
import type { PiSpec } from "../src/lean/spec.ts";
import { parsePiSpec, renderPiSpec } from "../src/lean/spec.ts";
import type { DerivedSpec } from "../src/lean/state-derived-spec.ts";
import { assertDerivedSpec, derivedSpecProblem } from "../src/lean/state-derived-spec.ts";
import { assertRunFile, createRun } from "../src/lean/state.ts";

let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    console.log(`✓ ${label}`);
  } else {
    failed++;
    console.log(`✗ ${label}`);
  }
}

const SPEC: PiSpec = {
  problem: "the engine cannot start from a prose ticket",
  criteria: [
    { id: "AC1", text: "a prose issue is derived into a contract", verify: "test" },
    { id: "AC2", text: "an authored block still wins", verify: "test" },
  ],
  size: "S",
};

const BLOCK = `\`\`\`pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``;

const DERIVED: DerivedSpec = { spec: SPEC, model: "some-model", at: 1_700_000_000_000 };

function runWith(derived?: DerivedSpec) {
  return {
    ...createRun({ issue: 7, version: "1", models: {}, baseSha: "", branch: "b" }),
    ...(derived === undefined ? {} : { derivedSpec: derived }),
  };
}

// ── the accessor: body first, derived second, and never a third thing.
{
  const fromBody = specFor(BLOCK, { derivedSpec: DERIVED });
  assert(fromBody.ok && fromBody.source === "issue", "an authored block wins over the record");
  const derivedOnly = specFor("just prose", { derivedSpec: DERIVED });
  assert(
    derivedOnly.ok && derivedOnly.source === "derived",
    "a run that holds a derived spec gets it for a blockless body",
  );
  assert(
    JSON.stringify(derivedOnly.ok ? derivedOnly.spec : null) === JSON.stringify(SPEC),
    "…and it is the recorded contract, byte for byte",
  );
  const nothing = specFor("just prose", {});
  assert(
    !nothing.ok && nothing.reason === "no pi-spec v1 block",
    `no block and nothing derived is today's refusal (got ${JSON.stringify(nothing)})`,
  );
  // The one arm that must NOT be papered over: a malformed authored block is the
  // author's defect, and standing in for it would let a broken contract run.
  const malformed = specFor("```pi-spec v1\n{oops\n```", { derivedSpec: DERIVED });
  assert(
    !malformed.ok && malformed.reason !== "no pi-spec v1 block",
    `a malformed block is refused even for a derived run (got ${JSON.stringify(malformed)})`,
  );
  assert(
    specSource({}) === "issue" && specSource({ derivedSpec: DERIVED }) === "derived",
    "specSource reads the record, so a resumed run reports provenance too",
  );
}

// ── the record round-trips the derivation, and refuses a corrupt one.
{
  const file = join(mkdtempSync(join(tmpdir(), "lean-derived-")), "7.json");
  const written = assertRunFile(runWith(DERIVED), file);
  assert(
    written.derivedSpec?.model === "some-model" && written.derivedSpec.at === DERIVED.at,
    "derivedSpec survives the validator with its provenance",
  );
  assert(
    JSON.stringify(written.derivedSpec?.spec) === JSON.stringify(SPEC),
    "…and the contract itself is unchanged",
  );
  assert(assertRunFile(runWith(), file).derivedSpec === undefined, "no derivation: absent field");

  const bad = (value: unknown): string => {
    try {
      assertRunFile({ ...runWith(), derivedSpec: value }, file);
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  };
  assert(bad("derived").includes("must be an object"), "a string derivedSpec is refused");
  assert(bad({ spec: SPEC, model: 1, at: 1 }).includes("model"), "…a non-string model is refused");
  assert(bad({ spec: SPEC, model: "m", at: "now" }).includes("at"), "…a non-numeric at is refused");
  assert(
    bad({ spec: {}, model: "m", at: 1 }).includes("parse"),
    `…a spec that is not a contract is refused (got ${JSON.stringify(bad({ spec: {}, model: "m", at: 1 }))})`,
  );
  // A hand-edited record that smuggled in an L-sized contract would have nine
  // steps build a change `ready` would never have approved.
  assert(
    bad({ spec: { ...SPEC, size: "L" }, model: "m", at: 1 }).includes("ready"),
    "…a not-ready contract is refused on load",
  );
  assert(
    derivedSpecProblem({ spec: SPEC, model: "m", at: 1 }) === undefined,
    "the shared validator accepts what the run validator accepts",
  );
  assert(
    assertDerivedSpec({ spec: SPEC, model: "m", at: 1 }).model === "m",
    "…and returns the canonicalised record",
  );
}

// ── the PR body says where the contract came from, and only when it must.
{
  const base = {
    issue: 7,
    spec: SPEC,
    tests: { AC1: ["a.test.ts"], AC2: ["b.test.ts"] },
    verifyKind: "green" as const,
    verifiedHead: "0".repeat(40),
    version: "0.0.0",
    baseSha: "1".repeat(40),
    models: { build: "m" },
    draft: false,
  };
  const authored = publishBody(base);
  assert(
    !authored.includes("spec: derived"),
    "an authored run's body carries no provenance line (today's bytes)",
  );
  const derivedBody = publishBody({ ...base, specSource: "derived" });
  assert(derivedBody.includes("spec: derived"), "a derived run's body says so");
  assert(
    derivedBody.includes("carried no `pi-spec v1` block"),
    "…and names the reason, so a reader knows what to fix",
  );
  assert(
    derivedBody.includes("a prose issue is derived into a contract"),
    "…and still carries the criteria table itself",
  );
  // The whole claim about `require` mode's bytes: the derived body is the authored
  // body with exactly two lines added (the provenance line and its blank) and
  // nothing else moved. A one-sided diff would mean the switch changed the body of
  // runs that never turned it on.
  const authoredLines = authored.split("\n");
  const derivedLines = derivedBody.split("\n");
  const provenance = derivedLines.findIndex((l) => l.startsWith("`spec: derived`"));
  const withoutProvenance = [
    ...derivedLines.slice(0, provenance - 1),
    ...derivedLines.slice(provenance + 1),
  ];
  assert(provenance > 0, "the provenance line is present");
  assert(
    derivedLines[provenance - 1] === "" && derivedLines[provenance + 1] === "",
    "…set off by a blank line on each side",
  );
  assert(
    JSON.stringify(withoutProvenance) === JSON.stringify(authoredLines),
    "…and every remaining line is the authored body's, in order",
  );
  // The block the comment prints must be one the parser reads back: a derived
  // contract that renders into something unparseable would be corrected on the
  // issue in a shape nobody could paste back.
  const rendered = renderPiSpec(SPEC);
  assert(parsePiSpec(rendered).ok, "a derived contract renders into a readable block");
}

process.exit(failed);
