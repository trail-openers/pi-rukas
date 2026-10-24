/**
 * public-hygiene-operands — the flag grammar the publish scan reads operands
 * through (#1788), split out of `public-hygiene-scan.ts` along the seam AGENTS.md
 * §12 asks for (the scan decides WHAT a command publishes; this decides whether a
 * word USES a flag, and what its value is).
 *
 * ## Why these rules are not one rule
 *
 * gh and git accept a flag's value in three shapes, and each has its own failure
 * mode if the matcher gets it wrong:
 *
 * - separate (`--body text`, `-F key=value`) — the next word is the value;
 * - glued LONG (`--body=text`) — delimited by `=`, so `--bodyfile` is a DIFFERENT
 *   flag and must not be read as `--body` with a value (an early version
 *   prefix-matched, collected the file PATH as inline body text, and never read
 *   the file at all);
 * - glued SHORT (`-btext`, `-Fbody=x`, `-mtext`) — getopt accepts it, so anything
 *   after the two-character flag is the value, and treating only the bare flag as
 *   a flag is how `-Fbody=@notes.md` stopped counting as a publish.
 */

/** What `--flag value` / `--flag=value` / a glued short form resolve to. */
export function valueAfter(
  words: string[],
  i: number,
): { value: string; used: number } | undefined {
  const w = words[i] ?? "";
  const eq = w.indexOf("=");
  if (eq > 0) return { value: w.slice(eq + 1), used: 0 };
  const next = words[i + 1];
  if (next === undefined) return undefined;
  return { value: next, used: 1 };
}

/**
 * Does the word `w` use text flag `flag`, with the flag ENDED by a delimiter?
 * Accepts `--body`, `--body=…` and a glued short form (`-b…`), and refuses a
 * long flag that merely prefixes a longer one (`--body` vs `--body-file`).
 *
 * A glued SHORT form has no delimiter after the two characters, so the rule for
 * it is "the flag is the whole prefix": `-btext` uses `--body` with value
 * `text`, and the word must NOT fall through to the next-word reader —
 * `valueAfter` on `-btext` returns the FOLLOWING word, which is how a single
 * word carrying the text (`gh pr comment 3 -bsecret`) was scanned as a body of
 * nothing while the real value sat unexamined in the flag word.
 */
export function flagEndsAt(w: string, flag: string): boolean {
  if (w === flag) return true;
  if (!w.startsWith(flag)) return false;
  if (flag.length > 2) return w[flag.length] === "=";
  return w.length > flag.length;
}

/**
 * The text a word carries for a text flag, and how many words it consumed.
 *
 * Three shapes, one reader: the separate form (`--body text`, `-b text`) takes
 * the next word; the glued LONG form (`--body=text`) and the glued SHORT form
 * (`-btext`, `-mtext`, `-ttext`) carry the value in the SAME word and consume
 * nothing after it. `flagEndsAt` alone does not distinguish the last two, so the
 * value is read here rather than by trusting a second call to `valueAfter`.
 *
 * Returns undefined when the word does not use the flag at all.
 */
export function textFlagValue(
  words: string[],
  i: number,
  flag: string,
): { value: string; used: number } | undefined {
  const w = words[i] ?? "";
  if (!flagEndsAt(w, flag)) return undefined;
  if (w !== flag) {
    // Glued: everything after the flag characters is the value — never the next
    // word, which is a separate argument and belongs to whatever follows. A LONG
    // flag got here only because the character right after it is `=` (that is
    // `flagEndsAt`'s rule), so the `=` itself is dropped. A SHORT flag glues with
    // no delimiter, so everything after the two characters is the value — and
    // getopt lets the same argument separator be written there, so `-m=x` means
    // what `-m x` means and its `=` is dropped too. Leaving it would report
    // `-m=-` as the message `=-`, a string git never commits, and miss the stdin
    // operand the word actually names.
    const glued = w.slice(flag.length).replace(/^=/, "");
    return { value: glued, used: 0 };
  }
  return valueAfter(words, i);
}

/**
 * The reason a text flag whose resolved value is exactly `-` contributes to the
 * scan instead of the literal `-`.
 *
 * `gh pr comment 3 --body -` (in any of its three shapes — `--body -`,
 * `--body=-`, `-b -`) does not publish the character `-`: gh reads the operand
 * from standard input. Scanning the literal is a PASS for a body the guard never
 * saw, which is the same defect the FILE flags already refuse (`-F -`,
 * `STDIN_MESSAGE_REASON`) on the other side of the same command. The refusal
 * lives here so every text reader — gh's flags, `gh api`'s fields and git's
 * message flags — refuses it with one rule rather than each inventing its own.
 */
export const STDIN_TEXT_REASON = "is read from standard input, so its text is not in this command";

/** A `KEY=value` word, as bash accepts before a command name. */
export { isAssignment } from "./public-hygiene-prefix.ts";
