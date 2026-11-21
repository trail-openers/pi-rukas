#!/usr/bin/env bun
/**
 * The `gates` switch is discoverable, which is the half of the contract a knob has to
 * keep on its own: a field that appears in no inventory is a field no host can code
 * against, and `--capabilities` is how a host asks what this build reads and writes.
 *
 * Split from `test-headless-work-lean-gates.ts` for the size gate, along the seam the
 * file's own sections drew — the projection's readings there, the switch's discoverability
 * here (G8 + G12).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { HEADLESS_FEATURES, buildCapabilities } from "../src/headless/capabilities.ts";
import { HEADLESS_INPUTS } from "../src/headless/inputs.ts";
import { GATE_SEVERITIES } from "../src/lean/gate-severities.ts";
import { SEVERITIES } from "../src/review-threshold-types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// A knob that appears in no inventory is a knob that does not exist: `--capabilities`
// is how a host asks what this build reads and writes, and a field it does not
// mention is a field no host can code against.
{
  assert(
    HEADLESS_FEATURES.leanGates === true,
    "features.leanGates is true on a build that writes the object",
  );
  const names = HEADLESS_INPUTS.map((i) => i.name);
  // The list's own order is the collation `test-headless-inputs.ts` enforces (the
  // `__`-to-space localeCompare that mostly ignores the separators), not ASCII order —
  // so the new entry has to sit where THAT rule puts it, and this is the same rule, not
  // a second opinion about it.
  assert(
    JSON.stringify(
      [...names].sort((a, b) => a.replace(/_/g, " ").localeCompare(b.replace(/_/g, " "))),
    ) === JSON.stringify(names),
    "HEADLESS_INPUTS stays sorted",
  );
}

// `issues[].gates` is a host-facing surface, and `docs/headless.md` is the host contract
// — the file a host integrator reads, and the one the projection's own comments cite for
// which absence rule governs which field. A surface named only in `configuration.md` is
// a surface no host reading the contract finds.
{
  const host = readFileSync(
    path.resolve(import.meta.dirname, "..", "..", "docs", "headless.md"),
    "utf8",
  );
  assert(
    host.includes("`issues[].gates`"),
    "docs/headless.md documents issues[].gates as a host surface",
  );
  assert(
    host.includes("features.leanGates"),
    "docs/headless.md names the capability a host checks before reading the object",
  );
  // The two absence rules are the part a host cannot infer from one run's JSON, and the
  // projection's comments point here for them rather than restating them.
  assert(
    host.includes("NULL rule") && host.includes("OMISSION rule"),
    "docs/headless.md states which gates fields follow the null rule and which the omission rule",
  );
  // The cap and the field are the host-facing half of the review-incomplete change: a host
  // that merges on `cap` has to be able to read from the contract that a `ready` PR with
  // unjudged lanes carries a DIFFERENT cap, and that `reviewComplete` is the field that
  // says so. Neither is inferable from one run's JSON.
  assert(
    host.includes("`review-incomplete`") && host.includes("`issues[].reviewComplete`"),
    "docs/headless.md names the review-incomplete cap and the issues[].reviewComplete field",
  );
  assert(
    host.includes("awaiting-human-merge` means `ready`") && host.includes("with every lens judged"),
    "docs/headless.md qualifies the awaiting-human-merge-means-ready claim with every lens judged",
  );
  // The row that makes that promise has to name BOTH answers the predicate reads, or it
  // over-claims: a `review` step that threw without recording a bound judged nothing, and
  // a row describing only the budget-stop arm would tell a host the cap proves lenses ran
  // when the record said nothing either way.
  assert(
    host.includes("ended on a throw that recorded no verdict"),
    "docs/headless.md names the review-died-without-a-record arm beside the stopped-with-lanes arm",
  );
}

// The record's tally is keyed by the words the REVIEWING layer publishes, and the list
// is restated in `lean/gate-severities.ts` rather than imported (that file's jsdoc says
// why). The restatement is only safe while something compares it to the original — so
// this does, against `SEVERITIES` itself. Without it a fifth word at the layer silently
// drops every finding filed under it from `gates.review.rounds`, which then loads clean
// and prints as a whole tally.
{
  assert(
    JSON.stringify(GATE_SEVERITIES) === JSON.stringify(SEVERITIES),
    `GATE_SEVERITIES is the reviewing layer's vocabulary, in its order (record ${JSON.stringify(GATE_SEVERITIES)} vs reviewing layer ${JSON.stringify(SEVERITIES)})`,
  );
  // The published capabilities list is the host's copy of the same vocabulary, so a
  // drift between it and the record's own list is a host coding against a word the
  // loader refuses.
  const published = buildCapabilities().contracts.resultSchema.gateSeverities;
  assert(
    JSON.stringify(published) === JSON.stringify(GATE_SEVERITIES),
    `--capabilities publishes the vocabulary the record is keyed by (${JSON.stringify(published)})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
