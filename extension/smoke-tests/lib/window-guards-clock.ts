/**
 * #1934 — the frozen round clock the window-guard witnesses share.
 *
 * Lives in `lib/` rather than in a test file because BOTH
 * test-review-findings-untouched-confirm.ts and
 * test-review-findings-window-guards.ts assert against the same clock, and
 * importing a symbol from a test file runs that file's whole top level —
 * including its `process.exit` — inside the importer's run. A clock has no top
 * level to run. See `window-guards-helpers.ts` for the same reason.
 */
export const NOW = 500_000;
