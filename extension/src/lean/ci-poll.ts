/**
 * The `ci` step's poll cadence, kept out of both halves that read it.
 *
 * One minute between reads of the forge: fast enough to notice a finished check,
 * slow enough that a wide job matrix does not pay an API read per job. `ci-tier.ts`
 * sleeps on it and `ci.ts` re-exports it as the step's documented cadence.
 */
export const CI_POLL_MS = 60_000;
