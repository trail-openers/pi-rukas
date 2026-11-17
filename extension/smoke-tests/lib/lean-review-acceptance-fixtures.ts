/**
 * lib/lean-review-acceptance-fixtures — the spec, the log and the two derived
 * shapes the acceptance-briefs suites share.
 *
 * `test-lean-review-acceptance-briefs.ts` and its derived-spec sibling drive the
 * SAME review step over the SAME fixture contract, and each was carrying its own
 * copy of the criteria, the issue body and the step log. Two copies of a fixture
 * are two definitions of what a row means: the pair drifted apart in one place
 * already (one suite's `logFor` carried a placeholder frozen digest, the other's
 * read the repo's own bytes) and neither agreed to stop. So the shape lives here
 * and each suite keeps only its own assertions.
 *
 * The digest rule is the load-bearing part and is repeated below rather than
 * hidden: a case that buys a fix wave MUST hand the step `realFrozen`, because
 * the step re-hashes the committed bytes and a made-up digest turns the case into
 * a tampering refusal.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import type { PiSpec } from "../../src/lean/spec.ts";
import { renderPiSpec } from "../../src/lean/spec.ts";
import { sha256 } from "../../src/lean/specify-proof.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";
import { frozenBlob } from "./lean-review-fixtures.ts";

/** A full lowercase oid, in the shape `state.ts` insists on for a head. */
export const HEAD = "0123456789abcdef0123456789abcdef01234567";

/** The newline, spelled for the assertions that read one line out of a posted body. */
export const NL = String.fromCharCode(10);

/**
 * The run's three criteria — one of each `verify` shape.
 *
 * The three shapes exist because each reads its cell from a different place in
 * the log, so a suite that dropped one would stop covering that reader.
 */
export const CRITERIA = [
  { id: "AC1", text: "The meter refuses the draw once the quota is spent.", verify: "test" as const },
  { id: "AC2", text: "The preservation script still exits 0.", verify: "command" as const },
  { id: "AC3", text: "The refusal reads well to a human.", verify: "manual" as const },
];

/** An issue body whose `pi-spec v1` block carries all three criteria. */
export const ISSUE_BODY = `Add a quota check to the meter.\n\n${renderPiSpec({
  problem: "The meter must refuse the draw once the quota is spent.",
  criteria: CRITERIA,
  size: "M",
})}\n`;

/**
 * A spec the `specify` step derived rather than read off the issue, in the record
 * shape `state.ts` stores on the run.
 *
 * The prose body beside it holds no parsable `pi-spec v1` block, which is the
 * only state in which the derived record is the run's contract — and therefore
 * the only state that exercises the table's fallback to it.
 */
export const DERIVED_SPEC: PiSpec = {
  problem: "The meter must refuse the draw once the quota is spent.",
  criteria: CRITERIA.map((c) => ({ ...c })),
  size: "M",
};

/** The prose-only issue body that makes `DERIVED_SPEC` the run's only contract. */
export const PROSE_BODY = "Add a quota check to the meter, in prose only.\n";

/**
 * The log the step reads, matching what the fixture repo really holds.
 *
 * `frozen` overrides the recorded digest of the frozen test. A case that buys a fix
 * wave MUST pass the repo's own hash (`realFrozen(repoRoot, head)`): the review
 * step's integration re-hashes the committed bytes, so a made-up digest makes every
 * fix round "change the frozen acceptance contract" and the case measures that
 * refusal instead of what it names. A case that buys no fixer never reaches that
 * proof and the placeholder is enough.
 */
export function logFor(head: string, frozen?: Record<string, string>): Step[] {
  const step = (state: string, outcome: Outcome | undefined, n = 0): Step => ({
    key: `7:${state}:${String(n)}`,
    state: state as Step["state"],
    startedAt: 1,
    outcome,
  });
  return [
    step("specify", { kind: "ok", frozen: frozen ?? { "tests/AC1.test.ts": "a".repeat(64) }, tests: { AC1: ["tests/AC1.test.ts"] } }),
    step("verify", {
      kind: "green",
      verifiedHead: head,
      commandCriteria: { AC2: "passed" },
      commandNotRunnable: {},
    }),
    step("publish", { kind: "ok", prUrl: "https://github.com/o/r/pull/11", publishedHead: head }),
  ];
}

/** The frozen record a fix-wave case must hand `logFor`: the digest of the repo's own
 * committed bytes, which is the one the step's own frozen proof accepts. */
export function realFrozen(repoRoot: string, head: string): Record<string, string> {
  return { "tests/AC1.test.ts": sha256(frozenBlob(repoRoot, head)) };
}
