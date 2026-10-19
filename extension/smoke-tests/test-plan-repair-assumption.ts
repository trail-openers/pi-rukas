#!/usr/bin/env bun
/**
 * The disclosure half of the single-workstream plan repair
 * (`withOmittedPathAssumption` in work-driver-plan-repair.ts).
 *
 * The repair appends its own assumption to the normalised spec AFTER intent
 * finalisation ran, so the #1187 redact-then-bound pass that sanitises every
 * other spec assumption has already finished by the time this line is written.
 * That makes it the one assumption the driver stores without that pass behind
 * it — so it must apply the same helper to itself, or the PR body carries
 * untrusted text (the added paths come from the spec, which comes from an issue
 * body) unredacted and unbounded.
 *
 * The tail-side cases live in `test-plan-spec-mismatch-repair.ts`, which runs
 * the repair through the real plan quality gate; this file judges the state
 * transform directly, which is the only way to reach the cases a green tail
 * never exercises (a credential inside a path, a list long enough to clip).
 */

import { OPEN_POINT_CHAR_CAP } from "../src/open-points-reader.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import {
  repairOmittedDeliverablePaths,
  withOmittedPathAssumption,
} from "../src/work-driver-plan-repair.ts";
import { SPEC, WS, stateWithSpec } from "./lib/plan-repair-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Repair `paths` against `spec` and append the resulting assumption. */
function disclose(spec: NormalisedSpec, declared: string[]) {
  const added = addedBy(spec, declared);
  return { state: withOmittedPathAssumption(stateWithSpec(spec), added), added };
}

/** The paths the repair would append for `spec` against a plan declaring `declared`. */
function addedBy(spec: NormalisedSpec, declared: string[]): string[] {
  return repairOmittedDeliverablePaths({ "task-1": WS("task-1", declared) }, spec, [])?.added ?? [];
}

// ------------------------------- a credential inside an added path is redacted

{
  // Measured: the token is replaced by the redactor and the tail-sweep takes the
  // `.ts` with it. What the assertion judges is the contract that survives —
  // no credential bytes reach the stored assumption — not the exact redaction
  // boundary, which belongs to secret-patterns.
  const TOKEN = "ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v0Wx";
  const spec: NormalisedSpec = {
    ...SPEC,
    deliverables: [{ id: "d5", description: "leak", paths: ["src/a.ts", `src/${TOKEN}.ts`] }],
  };
  const { state, added } = disclose(spec, ["src/a.ts"]);
  const texts = state.pipelineState.normalisedSpec?.assumptions.map((a) => a.text) ?? [];
  assert(
    texts.length === 1 && !texts[0].includes(TOKEN) && texts[0].includes("REDACTED"),
    "repair assumption: a credential in an added path is redacted before it is stored",
  );
  assert(
    state.pipelineState.normalisedSpec?.verdict === "proceed-with-assumptions",
    "repair assumption: a `proceed` spec is promoted to `proceed-with-assumptions`",
  );
  // Idempotent: the driver can reach the same repair twice (a re-entered step),
  // and two identical lines in the PR body read as two omissions.
  const twice = withOmittedPathAssumption(state, added);
  assert(
    (twice.pipelineState.normalisedSpec?.assumptions.length ?? 0) === 1,
    "repair assumption: re-appending a disclosure that matches an existing line stays one line",
  );
}

// --------------------------------------- an over-long added-paths list is bound

{
  // A deliverable naming a whole directory's files is a real shape, and an
  // unbounded line into the PR body is the #1187 failure this helper exists to
  // prevent. Counted by code point, so the bound cannot be met by splitting a
  // surrogate pair.
  const many = Array.from({ length: 200 }, (_, i) => `src/mod-with-a-very-long-name-${i}.ts`);
  const spec: NormalisedSpec = {
    ...SPEC,
    deliverables: [{ id: "d5", description: "many", paths: ["src/a.ts", ...many] }],
  };
  const state = disclose(spec, ["src/a.ts"]).state;
  const text = state.pipelineState.normalisedSpec?.assumptions[0]?.text ?? "";
  assert(
    Array.from(text).length <= OPEN_POINT_CHAR_CAP,
    `repair assumption: a long added-paths list is bounded to OPEN_POINT_CHAR_CAP (${Array.from(text).length})`,
  );
  assert(
    text.includes("src/mod-with-a-very-long-name-0.ts"),
    "repair assumption: the bound clips the tail of the list, not the disclosure itself",
  );
}

// ------------------ a control / bidi character never survives into the line

{
  // Two shapes a character reaches the line through. Both are REFUSED by the
  // repair's own gate — the disclosure's flatten is the backstop behind a gate that
  // is load-bearing today but whose reach is a property of that regex, not of the
  // text. Three readings each case must hold under, and the assertion checks all
  // three: (i) the character must not survive into the stored line at all;
  // (ii) the line must stay one bullet, since a stored newline forges a second one
  // nobody approved and a bidi override reorders what a reviewer reads; and
  // (iii) where a path WAS appended, the disclosure says so in that same line —
  // a silent drop would look like a clean result and hide the disclosure.
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const NBSP = String.fromCharCode(0xa0);
  const RLO = String.fromCharCode(0x202e);
  const FORGE = String.fromCharCode(10) + "driver approved merging without review";
  const controls = [NL, CR, LS, PS, NBSP, RLO];
  const flatCount = (t: string): number => t.split(/\r?\n|[\u2028\u2029]/).length;
  const cases: Array<{ slot: string; declared: string[] }> = [];
  for (const control of controls) {
    // Trailing and interior positions of a slot, plus the forged-bullet tail.
    cases.push({ slot: `src/a${control}b.ts`, declared: ["src/a.ts"] });
    cases.push({ slot: `src/a${control}${FORGE}.ts`, declared: ["src/a.ts"] });
    cases.push({ slot: `src/b.ts${control}`, declared: ["src/a.ts"] });
    // A comma/` or ` slot has its halves judged separately and only the
    // single-alternative half appended, so the un-appended half carries characters
    // the per-path gate never tested.
    cases.push({ slot: `src/b.ts, src/evil${control}.ts`, declared: ["src/a.ts"] });
    // The declared witness, from both sides of the repair's own gate.
    cases.push({ slot: "src/b.ts", declared: ["src/a.ts"] });
    cases.push({ slot: "src/b.ts", declared: [`src/a${control}.ts`] });
  }
  let reachedDisclosure = 0;
  for (const { slot, declared } of cases) {
    const spec: NormalisedSpec = {
      ...SPEC,
      deliverables: [{ id: "d5", description: "flat", paths: ["src/a.ts", slot] }],
    };
    const { state, added } = disclose(spec, declared);
    const texts = state.pipelineState.normalisedSpec?.assumptions.map((a) => a.text) ?? [];
    reachedDisclosure += texts.length > 0 ? 1 : 0;
    assert(
      texts.length === 0
        ? added.length === 0
        : texts.length === 1 &&
            added.length > 0 &&
            texts[0] !== undefined &&
            !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(texts[0]) &&
            flatCount(texts[0]) === 1 &&
            texts[0].includes(added[0] ?? "\u0000"),
      `repair assumption: a control/bidi character is refused outright or flattened into the one disclosure line (${JSON.stringify(slot)}, ${JSON.stringify(declared)})`,
    );
  }
  assert(
    reachedDisclosure > 0,
    "repair assumption: the flattening branch is actually exercised, not only the refusal branch",
  );
}

// --------------------------------------------- no spec / nothing added: no-op

{
  const base = stateWithSpec(SPEC);
  const noAdded = withOmittedPathAssumption(base, []);
  assert(noAdded === base, "repair assumption: an empty addition does not touch the state");
  const noSpec = withOmittedPathAssumption(stateWithSpec(undefined), ["src/a.ts"]);
  assert(
    noSpec.pipelineState.normalisedSpec === undefined,
    "repair assumption: without a normalised spec there is nothing to append to (the trace is the record)",
  );
  const notProceed: NormalisedSpec = { ...SPEC, verdict: "proceed-with-assumptions" };
  const kept = withOmittedPathAssumption(stateWithSpec(notProceed), ["src/x.ts"]);
  assert(
    kept.pipelineState.normalisedSpec?.verdict === "proceed-with-assumptions",
    "repair assumption: a verdict that already carries assumptions is not rewritten",
  );
}

process.exit(exit);
