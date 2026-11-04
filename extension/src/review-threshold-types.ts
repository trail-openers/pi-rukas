/**
 * review-threshold-types — the severity names a review may assign, and the
 * order they rank in, as data with no behaviour attached.
 *
 * The leaf that lets `review-severity-default.ts` carry the shipped bar as a
 * typed value without importing the resolver: `ReviewSeverity` is a union of
 * strings read off `SEVERITIES`, so the type and the list cannot drift apart,
 * and neither needs the policy judge the resolver pulls in.
 */

/**
 * Which severities a project may name, most severe first.
 *
 * Read out of the judge's quote rather than asked for as a separate field: the
 * quote is the thing that gets verified against the file, so anything derived
 * from it inherits that verification. A severity mentioned in a sentence that
 * does not exist cannot be honoured.
 */
export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type ReviewSeverity = (typeof SEVERITIES)[number];
