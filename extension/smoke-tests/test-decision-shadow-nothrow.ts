#!/usr/bin/env bun
/**
 * A shadow call never throws into the caller's rule path (#1308/#1393).
 *
 * `shadowDecide` is fired without awaiting from the step router and the intent
 * gate, so any throw it lets escape would change a driver's route — the one
 * thing a shadow decision is defined never to do. These are the ways in: a
 * request-less call whose synchronous prefix throws, and an unknown seam id.
 */

import { shadowDecide } from "../src/decision-shadow.ts";
import { makeAssert, tmpDir } from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();

{
  const root = tmpDir("shadow-nothrow");
  const where = { repoRoot: root, issues: [11] };
  // A request-less enforce-mode call takes the synchronous skip path, which
  // throws on the missing request; the caller must get a resolved undefined.
  process.env.PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE = "enforce";
  let threw = false;
  let out: unknown = "pending";
  try {
    out = await shadowDecide("failure-cause", undefined as never, where);
  } catch {
    threw = true;
  }
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_DECISION_MODE_FAILURE_CAUSE");
  assert(
    !threw && out === undefined,
    "a throwing synchronous prefix resolves undefined, never throws",
  );

  const unknownSeam = await shadowDecide(
    "no-such-seam" as never,
    { question: "q", state: {}, rule: "x" },
    where,
  ).catch(() => "rejected");
  assert(unknownSeam === undefined, "an unknown seam id is not fired and does not reject");
}

process.exit(state.exit);
