/**
 * The pieces the errored-review arm of the handback head rule needs from outside the lean tree (#2667).
 *
 * A review that threw judged nothing, so over a head the run's own gate certified it has the same
 * standing a `fixed` review the gate has not spoken for has: the run owes that head the reporting step's
 * reading. The findings themselves are worded in `lean-handback-cause.ts`; this module holds the
 * one shape test both of them need, so the rule and the errored arm cannot drift apart on it.
 *
 * This module imports NO lean file — the rule asks it, never the other way round — so the two files
 * cannot form an import cycle.
 */
import { isFullCommitSha } from "./commit-sha.ts";

/** Is this value a head the rule may name? The one shape test, for the rule and the errored arm. */
export function isVerifiedHeadName(head: unknown): head is string {
  return typeof head === "string" && isFullCommitSha(head);
}
