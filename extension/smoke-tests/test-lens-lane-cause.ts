#!/usr/bin/env bun
/**
 * #2261 (adversarial round 3, finding 2) — the lane's provider cause is decided by
 * the SAME predicate the retry loop uses, and never by the child's prose.
 *
 * `lens-review-child-failure.ts` owns one judgement: what a failed lane says about
 * why it failed. It read that cause off `result.text` — the model's own words, which
 * the lens prompt orders the reviewer to quote the diff WITH. A line of reviewed
 * source reading `400 status code … maximum context length` therefore stamped the lane
 * "the provider refused this lens's prompt and it was NOT retried", on a child whose
 * provider refused nothing at all.
 *
 * And it did worse than mislabel. `hasEvidence` discounts a child whose prose carries
 * a provider cause — correctly, for a real refusal, which answered nothing — so a
 * lane whose findings were only DIFF-authored prose had those findings discarded and
 * the lane became blocked / REVIEW_INCOMPLETE, while the retry loop (which reads the
 * structured `errorStop` via `isProviderContextLengthFailure`) had correctly spent all
 * four attempts. One channel decided the story, another decided the retries.
 *
 * `test-lens-provider-refusal.ts` pins the retry COUNTS from the child side; this file
 * pins the ROW from the failure-classifier side, which is where the mislabel and the
 * discarded evidence lived. Cases drive `failedLensRow` directly: the shape under test
 * is what one row says, and driving a real child would exercise the loop's predicate a
 * second time rather than the classifier's.
 */

import { failedLensRow } from "../src/lens-review-child-failure.ts";
import { CONTEXT_LENGTH_HINT } from "../src/lens-provider-cause.ts";
import { isReviewIncomplete } from "../src/lens-review-incomplete.ts";
import type { Finding, LensRunResult } from "../src/lens-review-types.ts";
import type { DispatchResult } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const findings: Finding[] = [
  {
    lens: "SECURITY",
    severity: "HIGH",
    path: "src/parser.ts",
    line: 42,
    title: "Unbounded read in the diff reader",
  },
];

function result(over: Partial<DispatchResult>): DispatchResult {
  return {
    role: "code-review-specialist",
    ok: false,
    text: "",
    toolUses: [],
    ms: 600,
    exitCode: 1,
    ...over,
  } as DispatchResult;
}

/** A failed lane classified the way `runLensChild` hands it over. */
function row(over: Partial<DispatchResult>, attempts = 4, found: Finding[] = findings): LensRunResult {
  return failedLensRow({
    lens: "SECURITY",
    result: result(over),
    attempts,
    findings: found,
    startMs: 0,
    boundMs: 600_000,
    lastError: `attempt ${String(attempts)}/4: exit 1`,
  });
}

/** The line of reviewed source the child was told to quote verbatim. It carries a 400
 * AND the size vocabulary, because that is what a fixture, a test name, or an error
 * string in the change under review really does say. */
const DIFF_AUTHORED =
  'const msg = "400 status code (no body): This model\'s maximum context length is 8192 tokens";';

// ── (1) prose alone mints no provider cause, and costs the lane nothing.
{
  const r = row({ text: DIFF_AUTHORED, thinkingOnly: true });
  assert(
    (r.parseError ?? "").includes(CONTEXT_LENGTH_HINT) === false,
    `(1) diff-authored size wording does not stamp the provider cause on the lane (got: ${String(r.parseError)})`,
  );
  assert(
    r.blocked === false,
    `(1) and the lane is not called unreviewed on the strength of prose (blocked=${String(r.blocked)})`,
  );
  assert(
    r.findings.length === 1,
    `(1) and the findings survive — they were the only evidence this round had (got ${String(r.findings.length)})`,
  );
  assert(
    r.summary !== undefined,
    `(1) and the closing summary survives with them (got: ${String(r.summary)})`,
  );
}

// ── (2) the same wording with NO evidence at all is still not a provider story.
// Nothing refused this request, so the row says what is known: the last error.
{
  const r = row({ text: DIFF_AUTHORED }, 4, []);
  assert(
    (r.parseError ?? "").includes(CONTEXT_LENGTH_HINT) === false,
    `(2) a silent-with-prose lane is not called a provider refusal either (got: ${String(r.parseError)})`,
  );
  assert(
    r.blocked === true,
    `(2) and it stays blocked on the evidence rule alone, which is the honest reason (blocked=${String(r.blocked)})`,
  );
}

// ── (3) the real refusal still reads, from the structured channel only.
{
  const r = row(
    {
      text: "",
      errorStop: {
        reason: "error",
        message:
          '400 status code (no body): {"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
      },
    },
    1,
    [],
  );
  assert(
    (r.parseError ?? "").includes(CONTEXT_LENGTH_HINT),
    `(3) a 400 + size wording in errorStop still names the provider cause (got: ${String(r.parseError)})`,
  );
  assert(
    r.blocked === true,
    `(3) and the lane is blocked, because a refused prompt answered nothing (blocked=${String(r.blocked)})`,
  );
}

// ── (4) the row's wording follows the ATTEMPTS the loop actually made. The refusal
// class is never retried, so a row claiming a refusal alongside four attempts is
// describing something the loop did not do; and a row for a lane that WAS retried must
// not say it was not.
{
  const refused = row(
    {
      text: "",
      errorStop: {
        reason: "error",
        message: "400 Bad Request: prompt is too long for the model's context window",
      },
    },
    1,
    [],
  );
  assert(
    (refused.parseError ?? "").includes("1 attempt") ||
      (refused.parseError ?? "").includes("never retried") ||
      (refused.parseError ?? "").includes("not retried"),
    `(4) a one-attempt refusal's row says what the loop did (got: ${String(refused.parseError)})`,
  );
  assert(
    (refused.parseError ?? "").includes("4 attempts") === false,
    `(4) and does not misreport the attempt count (got: ${String(refused.parseError)})`,
  );

  // A lane that spent its whole budget AND carried provider-shaped prose must never
  // be stamped "NOT retried" — four attempts were made, and the sentence that says
  // otherwise is the one the operator acts on.
  const retried = row({ text: DIFF_AUTHORED, thinkingOnly: true }, 4);
  assert(
    (retried.parseError ?? "").includes("NOT retried") === false,
    `(4b) a lane the loop retried four times is never described as untried (got: ${String(retried.parseError)})`,
  );
}

// ── (5) the kill-cause rows are untouched by this rule — the bound row and a
// cap-kill row keep their findings and their own reasons.
{
  const bounded = row({ text: "partial review", killCause: "child-bound", thinkingOnly: true }, 1);
  assert(
    (bounded.parseError ?? "").includes("lens bound"),
    `(5) a bound-ended lane still names its bound (got: ${String(bounded.parseError)})`,
  );
  assert(
    bounded.blocked === true,
    `(5) and stays blocked — it never gave a verdict (blocked=${String(bounded.blocked)})`,
  );
  assert(
    bounded.findings.length === 1,
    `(5) and its findings are kept (got ${String(bounded.findings.length)})`,
  );
}

// ── (6) a provider refusal + a self-inflicted cap kill + findings is STILL a
// refused prompt (#2261 regression, reproduced through the real `runLensChild`).
// `hasEvidence` once collapsed to `findings.length > 0` for a cap-killed child, so
// the lane came back `blocked:false` with no reason: `laneReason` never reached the
// provider clause, `isReviewIncomplete` said the round was covered, and the summary
// printed "the provider refused this lens's prompt … not retried" beside "(killed:
// token-budget; not retried: self-inflicted cap)". A lane whose prompt the provider
// refused is not reviewed, whatever killed the child on top of it; the findings it
// did file stay attached for disclosure.
{
  const r = row(
    {
      text: "Reviewing the auth change, the session handler reads the cookie before",
      thinkingOnly: true,
      killCause: "token-budget",
      errorStop: { reason: "error", message: "400 Bad Request: prompt is too long" },
    },
    1,
  );
  assert(
    r.blocked === true,
    `(6) a provider-refused child is blocked even when a cap kill also fired and it filed a finding (blocked=${String(r.blocked)})`,
  );
  assert(
    (r.parseError ?? "").includes(CONTEXT_LENGTH_HINT),
    `(6) and the lane reason names the provider cause the operator can act on (got: ${String(r.parseError)})`,
  );
  assert(
    isReviewIncomplete([r]) === true,
    `(6) and the round reads as incomplete — a refused prompt reviewed nothing (isReviewIncomplete=${String(isReviewIncomplete([r]))})`,
  );
  assert(
    r.findings.length === 1,
    `(6) while its findings stay attached for disclosure (got ${String(r.findings.length)})`,
  );
}

// ── (6b) the control: the SAME cap kill and finding with no provider refusal on
// `errorStop` keeps the #952 behaviour — the partial review is evidence, the lane
// is not blocked.
{
  const r = row({ text: "partial review of my lane", thinkingOnly: true, killCause: "token-budget" }, 1);
  assert(
    r.blocked === false,
    `(6b) a cap-killed child the provider never refused keeps its partial review (blocked=${String(r.blocked)})`,
  );
  assert(
    r.findings.length === 1,
    `(6b) and its findings are kept (got ${String(r.findings.length)})`,
  );
}

console.log(`\nlens lane cause ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`);
process.exit(failures());
