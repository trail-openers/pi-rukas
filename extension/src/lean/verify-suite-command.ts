/**
 * lean/verify-suite-command — is a project's `verify.full` tier the suite the roster already ran? The
 * roster's argv is the project's own runner plus two words of the roster's own — its report flag and the
 * tree to scan — so take those back and demand word-for-word equality, quotes and all: a tier that quotes
 * the runner's path names a differently spelled command and runs. Anything unequal runs, as today.
 */

/** A word of the roster's argv that belongs to the roster, not to the project's command. */
const REPORT_WORD = /^--junit-?xml=/;

/** Did this roster's accepted head run cover the project's `verify.full` tier? */
export function fullTierSatisfiedBy(
  fullTier: string | undefined,
  rendered: { bin: string; args: string[] },
  head: { failed: string[] },
): boolean {
  if (head.failed.length > 0) return false;
  if (fullTier === undefined || fullTier.trim() === "") return false;
  const suite = [...rendered.args];
  if (suite.length >= 2 && REPORT_WORD.test(suite[suite.length - 2] as string)) suite.length -= 2;
  const tier = fullTier.split(/\s+/).filter((word) => word !== "");
  return (
    tier.length === suite.length + 1 &&
    tier[0] === rendered.bin &&
    tier.every((word, i) => i === 0 || word === suite[i - 1])
  );
}
