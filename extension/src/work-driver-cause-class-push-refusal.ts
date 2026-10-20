/**
 * work-driver-cause-class-push-refusal — the #1439 cause verdict, kept beside its
 * siblings rather than inline in `work-driver-cause-class.ts` (AGENTS.md §12 size cap;
 * the verdict is one self-contained diagnosis with its own measured rationale).
 *
 * #1439 — the forge said no to the push.
 *
 * Why `issue` and not `change`: the verdict is the remote's, taken on the content the
 * issue asked for. Cycle 1439 added Stripe/AWS *documentation* keys as redaction
 * fixtures — the deliverable — and GitHub push protection refused the ref. Telling the
 * operator to "fix the change" sent them to a defect that did not exist; the two real
 * actions are both upstream of the code, in the issue: allow the flagged content at
 * the URLs GitHub printed, or change the fixtures so the content is never committed
 * (assemble a test secret from fragments at runtime).
 *
 * The evidence is the refusal itself: the `remote:` lines, allow-the-secret URLs
 * included, because those URLs ARE the operator's action. The verify command's own
 * failure list is not consulted — it is empty here, and a `push-refused` park whose
 * evidence said "the verify command failed" is the misdiagnosis this replaces.
 */

import type { CauseVerdict } from "./work-driver-cause-class.ts";
import { isPushRefusal, pushRefusalEvidence } from "./work-driver-push-refusal.ts";

/** The caller's own evidence-bounding helper, injected so both sites share one binder. */
export type EvidenceLines = (texts: readonly (string | undefined)[]) => string[];

export function pushRefusalVerdict(
  failures: readonly string[],
  hit: string | undefined,
  issue: number,
  evidenceLines: EvidenceLines,
): CauseVerdict {
  // The refusal text is preserved on three surfaces; take the first that actually
  // carries a forge-authored refusal LINE (the same anchored matcher the producer used,
  // so a truncated or prose-only copy cannot win over the full one).
  const sources = [hit, ...failures];
  const refusal = sources.find((s) => isPushRefusal(s));
  const evidence =
    refusal === undefined
      ? evidenceLines(sources)
      : evidenceLines([pushRefusalEvidence(refusal), ...sources]);
  const quote = refusal === undefined ? "" : ` — ${evidence[0] ?? ""}`;
  return {
    causeClass: "issue",
    causeReason: `the forge refused the push of this branch, so nothing was published and the verify command never judged this content${quote}`,
    causeEvidence: evidence,
    userAction: `the forge refused the push (push protection / repository rules): either allow the flagged content via the URLs in the evidence, or change the issue/fixtures so the content is not committed (e.g. build test secrets from fragments at runtime), then re-run \`/work ${issue} --restart\``,
  };
}
