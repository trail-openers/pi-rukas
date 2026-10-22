/**
 * review-accept-names — the one question the guard asks of a word the tokeniser cannot
 * see: does an option value GLUED to its flag name the findings store?
 *
 * Split out of `review-accept-command.ts` (#1764, §12's file-size limit) because it is a
 * different question from the tokeniser's. Every other protected-name route hands
 * `isProtectedToken` a token; these shapes never do, because the option prefix fuses the
 * name to the flag:
 *
 *   git log -Greview-findings-store   a pickaxe regex
 *   git log -Sreview-findings-store   the other pickaxe
 *   git log --grep=review-findings.json
 *   git show HEAD:x -oreview-findings.json   an output path
 *
 * No tokeniser hands out the bare name for any of them, and no arm's operand test reads
 * them either — `-o<name>` is ONE word, not the `-o <name>` pair `armGitRead` walks. So
 * this is the second half of the name test, and scope test (2) is its only caller.
 */
import { isAcceptScriptToken, isProtectedToken, tokensOf } from "./review-accept-command.ts";

/** An option value ATTACHED to its flag, with the flag removed: `-G<name>`, `-S<name>`,
 * `--grep=<name>`, `-o<name>`, `--output=<name>`, `-f<name>`, `-t<name>` (git's
 * `--template`), `-e<code>` (a runtime's inline program). Returns the value, or `null`
 * for a word that is not an attached value. */
function attachedValue(word: string): string | null {
  const bare = word.replace(/^["']+|["']+$/g, "");
  for (const flag of ["--grep", "--output", "-grep", "--pickaxe", "--template"] as const) {
    if (bare.startsWith(`${flag}=`)) return bare.slice(flag.length + 1);
  }
  // `t` is git's `--template` (a FILE whose contents become the commit message) and `e` a
  // runtime's inline-program flag, so `-treview-findings.json` and `-ereview-accept.ts`
  // are exactly the attached spellings no tokeniser hands out bare.
  if (/^-[gsotfe]/i.test(bare) && bare.length > 2) return bare.slice(2);
  return null;
}

/**
 * Clause (a), part (vi): does an ATTACHED option value name the store? The shapes are
 * `git log -Greview-findings-store` (a pickaxe regex), `git log -S<name>` / `--grep=<name>`
 * and `git show HEAD:x -oreview-findings.json` (an output path). None of them ever hands
 * a tokeniser the bare name — the option prefix glues it to the flag — so the token match
 * in `namesStore` cannot see them, and the arms cannot either (`-o<name>` is one word,
 * not the `-o <name>` pair their operand test reads). They are asked case-insensitively:
 * the guard evaluates this over its LOWERCASED view while git matches such a value
 * exactly, so a folded name still counts as naming it.
 */
export function namesAttachedValue(text: string): boolean {
  return tokensOf(text).some((token) => {
    const value = attachedValue(token);
    if (value === null) return false;
    return tokensOf(value).some(
      (t) => isProtectedToken(t.toLowerCase()) || isAcceptScriptToken(t.toLowerCase()),
    );
  });
}
