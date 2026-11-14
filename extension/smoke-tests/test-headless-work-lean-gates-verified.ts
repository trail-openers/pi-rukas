#!/usr/bin/env bun
/**
 * `gates.handback.verified` is the projection's own answer, not the step's claim.
 *
 * `shippedVerified` is what the handback step wrote about its own rewind, and the
 * projection prints it beside the head the step says it shipped. Read verbatim, that
 * pairing is a story the record can tell by itself: nothing binds a `true` to a green
 * `verify` about the head the run shipped, so a log whose every gate went red still
 * publishes `verified: true` next to the head no gate ever certified — while `prState`,
 * which asks the gate, says `draft`. One run, two fields, two answers, and the
 * mergeable one is the field a host reads.
 *
 * So the published flag is the step's claim put BACK through the gate the way
 * `prStateOf` reads it: a `true` survives only when the run's newest `verify` is green
 * about that exact head with no newest `ci` refusing it. `false` and `null` pass
 * through untouched, because the cautious answer needs no corroborating — the only
 * claim that costs a host a merge is the positive one.
 *
 * Split from `test-headless-work-lean-gates.ts` for the §12 size cap, along the seam
 * this one field already had: that file pins the readings, this one pins the gate
 * behind the reading that could disagree with `prState`.
 */

import type { Outcome, Step } from "../src/lean/state.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { HEAD, URL, driveLean } from "./lib/lean-result-fixture.ts";
import { UNSHIPPED, gateSteps } from "./lib/lean-result-gates-fixture.ts";

const { assert, failures } = makeAssert();

/** A gate that refused, with the reason a real red carries. */
const RED: Outcome = {
  kind: "red",
  reason: "frozen tests failing: tests/AC1-retry.test.sh (exited 1)",
};
/** A gate that certified `head`. */
const green = (head: string): Outcome => ({ kind: "green", verifiedHead: head });
/** The reporting step's own claim: it shipped `head`, and it says the gate agreed. */
function claim(head: string, verified: boolean | undefined): Outcome {
  return {
    kind: "done",
    reason: "handback comment posted",
    posted: true,
    shippedHead: head,
    ...(verified === undefined ? {} : { shippedVerified: verified }),
  };
}

/** The head the run's OTHER green certified — never the one this run shipped. */
const OTHER = UNSHIPPED;

/** Project one log's `gates.handback` and assert the shared output contract on the way. */
async function handbackOf(opts: {
  verify: Outcome[];
  /** The head `publish` says it pushed; the handback always claims this one. */
  published: string;
  /** The step's own claim; `undefined` = the record says nothing. */
  verified?: boolean;
  /** The pipeline's verdict; `undefined` = the run has no `ci` step. */
  ci?: Outcome;
}): Promise<Record<string, unknown>> {
  const steps = gateSteps({
    verify: opts.verify,
    publish: { kind: "ok", prUrl: URL, publishedHead: opts.published, draft: false },
    ...(opts.ci === undefined ? {} : { ci: opts.ci }),
    handback: claim(opts.published, opts.verified),
  });
  const r = await driveLean("handed-back", 10, steps);
  assert(r.violations.length === 0, `the output contract holds (${r.violations.join("; ")})`);
  const gates = r.issue?.gates as Record<string, unknown> | undefined;
  return gates?.handback as Record<string, unknown>;
}

// ─── (1) a `true` with no green behind it is published as `false` ───────────────
// The log's ONLY gate verdict is red and the head the step names is the one publish
// pushed, so the sole evidence for the claim is the claim itself.
{
  const h = await handbackOf({ verify: [RED], published: HEAD, verified: true });
  assert(
    h.head === HEAD && h.verified === false,
    `a true no green supports publishes false, beside the head the step named (${JSON.stringify(h)})`,
  );
}

// ─── (2) a green about a DIFFERENT head is no green for this one ────────────────
// The run's only green certified another commit while the handback shipped this one.
// The green is real, and it is still not about these bytes.
{
  const h = await handbackOf({ verify: [green(OTHER)], published: HEAD, verified: true });
  assert(
    h.head === HEAD && h.verified === false,
    `a green about another head publishes false (${JSON.stringify(h)})`,
  );
}

// ─── (3) the newest gate speaks, not the oldest ─────────────────────────────────
// The gate went green on the shipped head and then red on a re-run. Log position is
// the run's current verdict, so its own gate no longer clears this head.
{
  const h = await handbackOf({ verify: [green(HEAD), RED], published: HEAD, verified: true });
  assert(
    h.verified === false,
    `a newer red outranks an older green about the shipped head (${JSON.stringify(h)})`,
  );
}

// ─── (4) a newest `ci` that is not green refuses the claim too ──────────────────
// The same rule `prState` applies: the pipeline's verdict on the head the PR stands
// on is as much a refusal as a red gate.
{
  const h = await handbackOf({
    verify: [green(HEAD)],
    published: HEAD,
    verified: true,
    ci: { kind: "red", reason: "required checks red at the verified head" },
  });
  assert(
    h.verified === false,
    `a red pipeline under a green gate publishes false (${JSON.stringify(h)})`,
  );
}

// ─── (5) CONTROL: the claim the gate really backs ───────────────────────────────
// Same log as (1) with one verdict swapped, which is what makes (1) a case about the
// gate rather than about a projection that ignores the field.
{
  const h = await handbackOf({ verify: [green(HEAD)], published: HEAD, verified: true });
  assert(
    h.head === HEAD && h.verified === true,
    `control: a green about the shipped head keeps the true (${JSON.stringify(h)})`,
  );
}

// ─── (6) the two cautious arms stay the step's own, untouched ───────────────────
// A `false` is already the refusal, and a claim the record never made is the
// projection's own null; re-deriving either would let the gate overrule a refusal —
// or invent a verdict the run never gave.
{
  const refused = await handbackOf({ verify: [green(HEAD)], published: HEAD, verified: false });
  assert(
    refused.head === HEAD && refused.verified === false,
    `a step that said false publishes false even under a green gate (${JSON.stringify(refused)})`,
  );
  const mute = await handbackOf({ verify: [green(HEAD)], published: HEAD });
  assert(
    mute.head === HEAD && mute.verified === null,
    `a step that said nothing publishes null, not the gate's answer (${JSON.stringify(mute)})`,
  );
}

console.log(`\nexit ${String(failures())}`);
process.exit(failures());
