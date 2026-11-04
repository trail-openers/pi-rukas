/**
 * review-severity-default — the ONE definition of the blocking bar a project
 * gets when it says nothing.
 *
 * A leaf module on purpose: the pure format helpers and the doctrine resolver
 * both need this value, and neither may import the other for it. The resolver
 * pulls in the policy judge and the child spawn behind it, so a constant read
 * by the format leaf would drag a process-spawning dependency into a module
 * that is supposed to answer questions about data. Anything that needs the bar
 * imports it from here; a second literal is a second rule about severity that
 * can drift from the one that produced the verdict beside it.
 *
 * HIGH, because most repositories state no bar anywhere, and at a MEDIUM bar
 * that majority got ordinary best-practice findings turned into fix orders.
 * Lowering is the project's decision — through a citation-verified sentence
 * (`review-threshold.ts`) or the operator's `PI_ENSEMBLE_REVIEW_THRESHOLD`.
 */
import type { ReviewSeverity } from "./review-threshold-types.ts";

export const DEFAULT_REVIEW_THRESHOLD: ReviewSeverity = "HIGH";
