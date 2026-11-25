/**
 * lean/pre-verify-share-switch — the ONE reader of the share of the cell budget the steps that
 * run BEFORE the first verify may spend. `pre-verify-share.ts` holds the rule it feeds and no
 * renderer consults either.
 *
 * The value is a whole number of percent, 0 to 100, and it has ONE spelling — digits. `0` is the
 * ONLY off value. Anything else that is not a whole percent in that range (`40.5`, `101`, `-1`,
 * `0x10`, `1e2`, `abc`, empty) is not a share an operator meant, so it reads as the shipped
 * default rather than as off — an accidental empty value must never silently disable a cap.
 *
 * Read at CALL time, not at module load: the lean smoke files share one bun process and pin arms
 * with `lib/env-scope.ts` `withEnv`.
 */

/** The shipped share of the cell budget the pre-verify steps get, in percent. */
export const DEFAULT_PRE_VERIFY_SHARE_PERCENT = 40;

/** The share of the cell budget the pre-verify steps may spend, 0 to 100 (0 = switched off). */
export function leanPreVerifySharePercent(): number {
  // NOT `Number(raw)` alone: that reader takes `""` for 0 (off, when the operator meant nothing),
  // `"0x10"` for 16 and `"1e2"` for 100.
  const text = (process.env.PI_ENSEMBLE_LEAN_PRE_VERIFY_SHARE ?? "").trim();
  const parsed = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  return Number.isInteger(parsed) && parsed <= 100 ? parsed : DEFAULT_PRE_VERIFY_SHARE_PERCENT;
}
