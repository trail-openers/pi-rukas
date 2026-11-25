/**
 * lean/verify-suite-command — is a project's `verify.full` tier the suite the roster already ran? The
 * roster's command is the project's own runner plus two words of the roster's own — its report flag and the
 * tree to scan — and the head run of THAT command is the verdict a duplicate tier would repeat. So the tier
 * may only be that command with its own two words taken back, compared word for word: quotes included, no
 * case fold, no path normalisation, no reordering — anything unequal is a different command and runs.
 */
/** A word of the roster's argv that belongs to the roster, not to the project's command. */
const REPORT_WORD = /^--junit-?xml=/;

/** Did this roster's accepted head run cover the project's `verify.full` tier? */
export function fullTierSatisfiedBy(
  fullTier: string | undefined,
  rendered: { bin: string; args: string[] },
  head: { failed: string[] },
): boolean {
  if (head.failed.length > 0 || fullTier === undefined) return false;
  const command = [rendered.bin, ...rendered.args];
  // The roster's own pair sits at the tail — report flag, then tree — and only its own words come back;
  // elsewhere the flag is the project's own, nothing is stripped, and only the command as the head ran it can
  // match. Outer blanks are the author's typing; blanks BETWEEN words belong to a word, so `pytest  -q` is
  // not the command `pytest -q` is.
  if (command.length >= 3 && REPORT_WORD.test(command[command.length - 2] as string))
    command.length -= 2;
  const tier = fullTier
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  return tier.length === command.length && tier.every((word, i) => word === command[i]);
}
