#!/usr/bin/env bun
/**
 * #2284 — `docs/lean.md`'s helper-child paragraph says the broker honours `none`.
 *
 * The paragraph beside lean's step table is the only place the harness states what
 * a lean helper child can and cannot do with a forge: no login, a broker for its
 * reads, and what `PI_ENSEMBLE_FORGE=none` covers. Before #2284 it said `none`
 * turned off the DRIVER's reads ONLY, and named the broker as the exception that
 * "still calls `detectForge` directly and runs the parent's CLI" — which documented
 * the defect as if it were the design.
 *
 * A doc sentence nobody greps is a sentence that silently goes stale again, so the
 * needles below are the enforcement (precedent: `test-lean-guard-fail-closed-switch.ts`,
 * `test-lean-report-bound-switch.ts`): the paragraph must name both consumers, carry
 * the refusal's exact text as the child sees it, name the single shared predicate,
 * say the socket still binds, and offer the escape hatch by name.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { FORGE_READ_OFF_REASON } from "../src/forge-read-off-switch.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const lean = readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "docs", "lean.md"),
  "utf8",
);

// The paragraph is the helper-child section's, and the needles are checked against
// that span rather than the whole file: a mention anywhere else would pass a gate
// whose subject is the paragraph a reader actually lands on.
const at = lean.indexOf("Every child lean dispatches");
assert(at >= 0, "docs/lean.md still has the helper-child paragraph beside the step table");
const para = lean.slice(at, lean.indexOf("\n\n", at));

assert(
  para.includes("`PI_ENSEMBLE_FORGE=none`"),
  "the paragraph still states the off value",
);
assert(
  para.includes("both") && para.includes("broker"),
  "and now says it covers BOTH readers of it, driver and broker",
);
assert(
  para.includes(FORGE_READ_OFF_REASON),
  `and carries the refusal the child reads, verbatim: ${FORGE_READ_OFF_REASON}`,
);
assert(
  para.includes("forgeEnvIsOff") && para.includes("forge-off.ts"),
  "and names the single predicate that decides off, in its own module",
);
assert(
  para.includes("resolveCycleForge") && para.includes("work-driver-forge-ctx.ts"),
  "and names the driver's consumer of that predicate",
);
assert(
  para.includes("handleLine") && para.includes("forge-read-broker.ts"),
  "and names where the broker's refusal lands",
);
assert(
  para.includes("socket still binds") && para.includes("tool still registers"),
  "and says the child keeps its tool, so a reader does not expect the tool to vanish",
);
assert(
  para.includes("PI_ENSEMBLE_FORGE_READ_OFF_GUARD=0"),
  "and offers the escape hatch by name",
);
assert(
  para.includes("git config --get remote.*") && para.includes("gh"),
  "and names what the parent issues NOTHING of under none: no CLI and no remote read",
);
// The stale claim itself, refused by name: the paragraph documented the exception.
assert(
  !para.includes("still calls\n`detectForge` directly and runs the parent's CLI") &&
    !para.includes("own forge reads only"),
  "and no longer claims the driver is the only reader of none",
);

console.log(
  `\n${failures() === 0 ? "docs green" : "docs RED"} (${String(failures())} failing)`,
);
process.exit(failures());
