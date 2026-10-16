#!/usr/bin/env bun
/**
 * #1362 round 3 — `pipelineState.dirtyRootExemptBaseline` is validated on the
 * resume path, the same #533 rule that covers `commitPrRoot` and
 * `consolidationCompleteness`: the cast in `readState` is the only runtime gate
 * for the record, so the validator is what stops a partial or hand-edited value
 * reaching a restore.
 *
 * Why this field earns it: the claim reads it to decide which `??` files under
 * an exempt prefix it spares. A value that is not a string array would either
 * throw inside the predicate mid-restore or, worse, read as "nothing matches"
 * and quietly spare the cycle's own output under a claim that says the root was
 * verified restored.
 */

import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const base = () => initialState(1362, 1000) as unknown as Record<string, unknown>;
const withBaseline = (v: unknown) => {
  const s = base();
  (s.pipelineState as Record<string, unknown>).dirtyRootExemptBaseline = v;
  return s;
};

// Absent validates — every pre-#1362 state file, and every cycle with no
// exemption list, must still resume.
assert(
  validateDiscriminants(base()).length === 0,
  "an absent baseline validates clean (a pre-#1362 state file still resumes)",
);

// The real shape validates.
assert(
  validateDiscriminants(withBaseline([".claude/settings.local.json", ".vscode/x"])).length === 0,
  "a string-array baseline validates clean",
);
assert(
  validateDiscriminants(withBaseline([])).length === 0,
  "an empty baseline validates (it is a real answer: nothing was pre-existing)",
);

// Anything else is refused, naming the field.
{
  const cases: [unknown, string][] = [
    ["not-an-array", "is not an array"],
    [{ a: 1 }, "is not an array"],
    [[1, 2], "non-string entry"],
    [[".claude/x", 3], "non-string entry"],
    [[null], "non-string entry"],
  ];
  for (const [value, expect] of cases) {
    const findings = validateDiscriminants(withBaseline(value));
    assert(
      findings.length === 1 &&
        findings[0].includes("dirtyRootExemptBaseline") &&
        findings[0].includes(expect),
      `a baseline of ${JSON.stringify(value)} is refused with a finding naming the field and "${expect}" (got ${JSON.stringify(findings)})`,
    );
  }
}

// A corrupt baseline halts the resume rather than reading as "nothing matches":
// the caller (refuseInvalidState) treats a non-empty result as a hard stop.
assert(
  validateDiscriminants(withBaseline(["ok", {}])).length === 1,
  "a single bad entry is one finding — the driver halts rather than resuming on it",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
