/**
 * adversarial-policy — the verdict policy a reportOnly adversarial review is
 * judged by (#1114 / #1154), split out of adversarial.ts (500-line cap).
 */

/**
 * Whether the loop runs as one reviewer dispatch (#1114) and, if so, how its
 * verdict is judged (#1154).
 *
 * The rule, stated once: `reportVerdict` is REQUIRED whenever `reportOnly` is
 * true and must be absent otherwise — a reportOnly review with neither value
 * set is rejected as a missing policy, one with only `reportVerdict` as an
 * orphan.
 */
export type ReportPolicy =
  | {
      /**
       * #1114 — exactly ONE reviewer dispatch: no developer dispatch, no fix
       * round. The result carries the parsed verdict in `adversarialRounds` and
       * its findings in `text`; the driver routes from the round record. The
       * review-ledger entry is still written (#912) with `loopOutcome` set to
       * `approved` on a pass and `rejected` otherwise. An unparsed verdict is an
       * infrastructure outcome, never a verdict.
       */
      reportOnly: true;
      /**
       * #1154 — how the reportOnly verdict is judged. "terminal": the review is
       * the loop's only round, so it is judged by the terminal-round rule
       * (ISSUES_FOUND passes; only CRITICAL_ISSUES_FOUND or an unreadable reply
       * fails) — the tool path. "routed": judged as round N of 3, so ISSUES_FOUND
       * routes to a fix pass — the /work driver's per-round reviews. Set by the
       * adversarial_loop tool (terminal) and by the /work fan-out (routed).
       */
      reportVerdict: "terminal" | "routed";
    }
  | { reportOnly?: false | undefined; reportVerdict?: undefined };

/**
 * #1161 — the runtime fence behind the `ReportPolicy` type. Returns the named
 * reason when the policy is unsound, or undefined when it is sound.
 *
 * What the fence adds over the type: the `adversarial_loop` tool boundary
 * receives LLM-supplied JSON, which no type binds, so this check is what
 * enforces the rule there.
 */
export function reportPolicyError(policy: {
  reportOnly?: unknown;
  reportVerdict?: unknown;
}): string | undefined {
  if (policy.reportOnly !== undefined && typeof policy.reportOnly !== "boolean") {
    return "reportOnly must be a boolean when set";
  }
  if (policy.reportOnly !== true) {
    return policy.reportVerdict === undefined ? undefined : "reportVerdict requires reportOnly";
  }
  if (policy.reportVerdict === "terminal" || policy.reportVerdict === "routed") return undefined;
  return policy.reportVerdict === undefined
    ? "reportOnly review without a verdict policy"
    : "reportVerdict is not a recognised verdict policy";
}

/**
 * #1161 — the infra-failure sentence `runAdversarialLoop` returns for a reason
 * from `reportPolicyError`: the reason, then the two values a policy is allowed
 * to take, then the disclaimer that says this is not a review rejection.
 *
 * Exported so the smoke test asserts against the sentence the caller actually
 * sees rather than a copy of it: the reason stays a literal in the test (the
 * spec) and the wrapper stays production text.
 */
export function policyInfraFailureText(reason: string): string {
  return `Adversarial loop infrastructure failure: ${reason} (reportVerdict must be "terminal" or "routed"). No verdict was produced — this is NOT a review rejection.`;
}
