/**
 * The `ci` step's poll cadence, kept out of both halves it bounds.
 *
 * One minute between reads of the forge is the step's own rhythm and nothing
 * else's: too fast and a repo with a 40-job matrix pays an API read per job per
 * few seconds, too slow and the `ci` budget is spent sleeping rather than
 * waiting on checks. It lives here, rather than in `ci.ts` or `ci-tier.ts`,
 * because both halves read it — the wait loop in `ci-tier.ts` sleeps on it, and
 * `ci.ts` re-exports it as the step's documented cadence — and a value two files
 * import cannot drift from itself.
 */
export const CI_POLL_MS = 60_000;
