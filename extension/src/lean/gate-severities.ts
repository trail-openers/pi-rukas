/**
 * lean/gate-vocabulary — the severity words a lean run's record may count, on its own.
 *
 * `review-threshold-types.ts` owns `SEVERITIES` for the classic driver's threshold
 * setting, and the lean record's per-round tally is keyed by exactly those four words.
 * The list is restated here rather than imported because the two surfaces fail in
 * opposite directions: a threshold config that gained a fifth word would put a key on
 * the HOST contract that no loader judged, and a host that branches on `gates.review`
 * counts would silently stop seeing findings. So this file is the record's own list,
 * and `test-headless-work-lean-gates.ts` pins it against the reviewing layer's — the
 * one place the two are allowed to be compared, so a drift is a failing test rather
 * than a host reading half the severities.
 */

export const GATE_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type GateSeverity = (typeof GATE_SEVERITIES)[number];
