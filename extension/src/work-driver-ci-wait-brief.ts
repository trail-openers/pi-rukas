/**
 * #2333 — the CI-wait instructions of the driver's `ops:ci` brief, split out of
 * `work-driver-prompts-late.ts` to keep that file under the 500-line limit
 * (AGENTS.md §12), the same seam `work-driver-handoff-ops-label.ts` uses.
 *
 * These are the lines that tell an ops child HOW to wait for CI, and they are the
 * whole reason the brief exists: #2333 was a child handed "watch CI then merge"
 * that wrote its reply while the wait was still open, so the merge never happened.
 * The recipe here is the one the driver itself runs — `ciWatch`
 * (extension/src/forge-ci.ts) polls until a terminal status with an injectable
 * sleep, and `checksRedReason` (extension/src/lean/ci-tier.ts) sleeps on
 * `CI_POLL_MS` — so the child and the driver share one cadence and one cap rather
 * than the child inventing numbers the driver does not honour.
 *
 * Two rules carry the fix and are pinned by
 * `extension/smoke-tests/test-ci-doctrine-poll.ts`:
 *
 *   - **A pending check is never a reason to end the dispatch.** The child re-polls
 *     until terminal or the cap and only then writes its reply.
 *   - **The marker is the LAST act, after a terminal state, and never `pending`.**
 *     The router does have a `pending` arm (`routeCiTier` keeps the cycle at `ci`)
 *     and nothing re-polls from the child's side, so a reply that lands on it parks
 *     the cycle with nobody left waiting; an ABSENT `ci-status` routes to failure,
 *     so a marker emitted before the wait ends burns a ci-retry.
 *
 * The wording is data for the gate above, not for a reader: keep the numbers
 * (`sleep 60`, 30 minutes) in step with the constants named in
 * `test-ci-doctrine-poll.ts`, which reads them out of the implementation.
 */

/** Step 2 of the CI brief: the wait itself. */
export const CI_WAIT_STEPS: readonly string[] = [
  "  2. If the run is not terminal yet, wait with the bounded sleep-poll — NOT `gh run watch` and not any `--watch` flag: a blocking watch call ends your turn mid-wait and the merge never happens. Each iteration is TWO separate unchained tool calls — `sleep 60`, then `gh run view <id> --json status,conclusion` (never combine them in one command: no loops, no command substitution, no `;`, no `&&`). Poll until the status is terminal or 30 minutes of waiting have passed (the driver's own cap; env-tunable via `PI_ENSEMBLE_CI_WATCH_TIMEOUT_MS`). If you reach for `gh pr checks <n> --repo <owner/repo>` instead of `gh run view`, its rows are the same signal and it exits 8 while checks run.",
  "     - **A pending check is never a reason to end your turn.** Keep polling until terminal or the cap, and only then write your reply. A non-zero exit while rows still print is a pending signal, not a failed command — read the rows and poll again. A slow-run notice during the wait is not a reason to stop either.",
  "     - Terminal means the run's status is completed (any conclusion), or a check row reads pass / fail / cancel / timed_out. queued, in_progress, pending and waiting are not terminal.",
  '     - At the 30-minute cap with nothing terminal, report the wait as a failure with the reason "CI still pending at the cap" — that is the driver\'s existing retry path. Never emit `ci-status:` before a terminal state, and never `ci-status: pending`.',
];

/** Steps 3-4: the marker the driver parses, emitted only after a terminal state. */
export const CI_REPORT_STEPS: readonly string[] = [
  "  3. On success: end your reply with the line `ci-status: success` (driver routes to merge) as the LAST line, after the terminal state.",
  "  4. On failure (including the cap with checks still pending): end your reply with `ci-status: failure` AND include the failing-job summary so the developer round that follows has the failure context.",
];
