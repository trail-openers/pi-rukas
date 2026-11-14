/**
 * headless/prefix — the `PI_ENSEMBLE_` prefix every host input name carries.
 *
 * Its own leaf module because the two modules holding the input inventory
 * (`inputs.ts`, `inputs-b.ts`) both build their rows through `entry.ts`, so a
 * prefix defined in either of them would be read by the builders before its
 * module finished evaluating. It is a plain string in a module with no
 * imports, which is also what keeps the `entry.ts` builders cycle-free.
 */
export const ENV_PREFIX = "PI_ENSEMBLE_";
