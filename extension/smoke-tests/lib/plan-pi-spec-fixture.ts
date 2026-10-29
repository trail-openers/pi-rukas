/**
 * Shared fixture for the two `plan-pi-spec` smoke tests: the drafted-body builder
 * every assertion measures against, and the one home for the `assert` counter.
 *
 * Split from `test-plan-pi-spec.ts` by the AGENTS.md §12 file-size cap — the
 * mapper/bounds/render assertions live in the test itself and the filing-path
 * assertions in `test-plan-pi-spec-filing.ts`, and both need this body shape
 * verbatim: it is what makes the mapper's section slicing observable.
 */

import type { PiSpec } from "../../src/lean/spec.ts";

let exit = 0;

/** The counter both files share: each ends by exiting on it. */
export function specExit(): number {
  return exit;
}

/** One assertion, printed as it lands. */
export function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The mapped spec, or a thrown error naming the case. The mapper returns undefined
 * for an epic, a spike or a criteria-less draft, and a test that expects a spec
 * must say so loudly rather than cast the undefined away.
 */
export function mustSpec(spec: PiSpec | undefined, label: string): PiSpec {
  if (spec === undefined) throw new Error(`${label}: the draft must map to a spec`);
  return spec;
}

/** A drafted body carrying exactly these acceptance-criteria bullets. */
export function draftBody(criteria: string[]): string {
  const bullets = criteria.map((s) => `- ${s}`).join("\n");
  return [
    "## Context & motivation",
    "",
    "Descriptor: d",
    "Type: feature",
    "",
    "## Acceptance criteria",
    "",
    bullets,
    "",
    "## References",
    "",
    "- references/plan.md",
    "",
    "## Test surface",
    "",
    "- extension/src/plan-pi-spec.ts",
    "",
    "## Edge cases & pitfalls",
    "",
    "- none",
    "",
    "## Open Questions",
    "",
    "- (none)",
    "",
    "## Out of scope",
    "",
    "- everything not named in the sections above",
    "",
  ].join("\n");
}
