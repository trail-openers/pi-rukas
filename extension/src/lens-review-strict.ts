/**
 * lens-review-strict — the lens review's severity type, extracted from
 * lens-review.ts to break the import cycle (#980): lens-review-format.ts
 * and lens-review-diff.ts need `Severity` (for `bySeverity` / thresholds)
 * and already import types from lens-review.ts; hosting the type in a
 * strict leaf module (no imports of lens modules) lets the format module
 * import it directly and re-export it, keeping lens-review.ts the public
 * name while `lens-review-format.ts → lens-review.ts` no longer carries it.
 */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
