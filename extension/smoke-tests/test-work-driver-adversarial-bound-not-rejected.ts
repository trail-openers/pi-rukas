/**
 * #1863 M4 — a review phase the driver KILLED must never be read as a rejection.
 *
 * THE BUG. `interpretReview` set `infra: true` only for a result that was `ok`
 * and produced no parsable verdict. A killed review phase comes back as
 * `infraFailureResult`: `ok: false`, no verdict. That fell to the bottom arm —
 * `{ok: false, infra: false}` — which is the exact shape of a REJECTION, and
 * every no-verdict route in the step handler is keyed on `infra || threw`. So
 * the cycle recorded `adversarial-rejected` with an `adversarial-loop` cap:
 * "the reviewer rejected this diff", about a reviewer the driver had itself
 * killed at its run bound. The operator then saw a review outcome that no
 * reviewer ever gave.
 *
 * THE FIX, and why this test is at this layer. The correction is applied at the
 * single seam where a loop result becomes a verdict — the caller passes
 * `noVerdictAs: "infra-failure"` built from the loop's OWN structural account
 * (`loopOutcome` / `killCause`), never from the child's prose. So the test must
 * cover three things:
 *
 *   1. `interpretReview` honours the discriminant against EVERY text the dead
 *      child might have emitted, including a well-formed `VERDICT: REJECT` —
 *      a dead child's last words quote anything.
 *   2. WITHOUT the discriminant, the same `ok: false` result still reads as a
 *      rejection. That is the shape this issue fixed, and a test that only
 *      covers the fixed direction would pass after a regression that removed
 *      the parameter entirely.
 *   3. The fan-out actually SUPPLIES the discriminant for the two structural
 *      accounts and withholds it otherwise, so a genuine parsed rejection still
 *      reaches the interpretation layer untouched.
 *
 * The third point is what the real-spawn test cannot check: it observes a bound
 * kill from outside and cannot see which arm of the reading the driver took.
 */

import { interpretReview } from "../src/work-driver-adversarial-fix.ts";
import type { DispatchResult } from "../src/types.ts";

let exit = 0;
function assert(cond: boolean, msg: string, actual?: unknown) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    if (actual !== undefined) console.error(`   actual: ${JSON.stringify(actual)}`);
    exit = 1;
  }
}

/** A result shaped like `infraFailureResult` for a killed review phase. */
function killed(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    ok: false,
    role: "adversarial-developer",
    finalAssistantMessage: "",
    exitCode: 137,
    durationMs: 1_800_000,
    transcriptPath: "/tmp/none.json",
    // The three fields that make this distinguishable from a real rejection:
    killCause: "child-bound",
    loopOutcome: "infra-failure",
    ...over,
  } as DispatchResult;
}

const REJECT_TEXT = "Verdict: REJECT. Three HIGH findings in the auth path.";

// ── 1. With the discriminant, NOTHING the dead child said re-reads as a verdict.
{
  for (const text of [
    "",
    REJECT_TEXT,
    "**VERDICT:** CRITICAL_ISSUES_FOUND",
    "VERDICT — APPROVED (I reviewed every line)",
  ]) {
    const r = interpretReview(killed({ finalAssistantMessage: text }), 1, "infra-failure");
    assert(
      r.ok === false && r.infra === true && r.fixRequested === false,
      `a killed review reads as infra-failure whatever it said (${text ? text.slice(0, 34) : "<empty>"})`,
      r,
    );
  }
}

// ── 2. Without it, the same result is STILL read as a rejection.
// This is the pre-fix shape. It must stay true, because the fix is at the
// CALLER, not in the default behaviour of the interpretation function: a
// caller that forgets to pass the discriminant gets the old (wrong) reading,
// which is why the call site is covered below rather than trusted.
{
  const r = interpretReview(killed(), 1);
  assert(
    r.ok === false && r.infra === false && r.fixRequested === false,
    "without the discriminant an ok:false no-verdict result still reads as a REJECTION (the pre-fix shape this issue fixed)",
    r,
  );
}

// ── 3. A genuine parsed rejection is never re-read as infra.
{
  const rejected = interpretReview(
    {
      ...killed({ killCause: undefined, loopOutcome: undefined, finalAssistantMessage: REJECT_TEXT }),
      ok: true,
      exitCode: 0,
      adversarialRounds: [
        {
          round: 3,
          status: "CRITICAL_ISSUES_FOUND",
          verdictParsed: true,
          findings: ["HIGH: token replay"],
        },
      ],
    } as DispatchResult,
    3,
    undefined,
  );
  assert(
    rejected.ok === false && rejected.infra === false,
    "a real reviewer's parsed rejection is still a rejection — the fix is narrow, not a blanket approval",
    rejected,
  );
}

// ── 4. The call site supplies the discriminant from the STRUCTURAL fields only.
// Parsed from source, because the fan-out needs a whole driver to run and this
// assertion is about which fields the call reads. An earlier draft of the fix
// keyed on the reply text, which is exactly the mistake this covers.
{
  const src = await Bun.file(
    new URL("../src/work-driver-adversarial-fanout-run.ts", import.meta.url),
  ).text();
  const call = src.slice(src.indexOf("const reading = interpretReview("));
  const window = call.slice(0, call.indexOf(");"));
  assert(
    window.includes('result.loopOutcome === "infra-failure"'),
    "the fan-out passes the discriminant from the loop's own outcome field",
    window.trim(),
  );
  assert(
    window.includes('result.killCause === "child-bound"'),
    "and from the structured kill cause the child itself carried",
    window.trim(),
  );
  assert(
    !/finalAssistantMessage|result\.text|\.includes\(/.test(window),
    "and NOT from the child's prose — a dead child's last words quote any verdict",
    window.trim(),
  );
}

console.log(
  exit === 0
    ? "OK: #1863 a review the driver killed is an infra failure, never a rejection"
    : "FAILED",
);
process.exit(exit);
