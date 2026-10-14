/**
 * adversarial-policy — the verdict policy a reportOnly adversarial review is
 * judged by (#1114 / #1154), split out of adversarial.ts (500-line cap).
 *
 * `ReportPolicy` is discriminated: `reportVerdict` is REQUIRED whenever
 * `reportOnly` is true and must be absent otherwise, so no reportOnly caller
 * gets a verdict policy by omission. Untyped JS callers can still omit it, so
 * `reportPolicyError` is the runtime fence (#1161): a reportOnly review without
 * a recognised policy fails as an infra failure instead of being silently
 * judged as a routed round.
 */

/**
 * Whether the loop runs as one reviewer dispatch (#1114) and, if so, how its
 * verdict is judged (#1154).
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
       * adversarial_loop tool (terminal) and by the /work fan-out (routed);
       * required whenever reportOnly is true.
       */
      reportVerdict: "terminal" | "routed";
    }
  | { reportOnly?: false | undefined; reportVerdict?: undefined };

/**
 * #1161 — the runtime fence behind the `ReportPolicy` type. Returns the named
 * reason when the policy is unsound, or undefined when it is sound.
 *
 * The adversarial_loop tool receives LLM-supplied JSON params, so the TypeScript
 * union is not enforced at that boundary; this check is what enforces it.
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
  return "reportOnly review without a verdict policy";
}

/** The one predicate every reader of `reportOnly` uses (#1161). */
export function isReportOnly(policy: { reportOnly?: unknown }): boolean {
  return policy.reportOnly === true;
}
