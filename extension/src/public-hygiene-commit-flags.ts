/**
 * public-hygiene-commit-flags — the git commit message grammar the publish scan
 * reads (#1792 follow-up), split out of `public-hygiene-verbs.ts` along the seam
 * AGENTS.md §12 asks for (the verbs module decides what a command publishes; this
 * decides whether a word is a git commit message flag and what its value is).
 *
 * ## The three shapes git's own parser gives a commit message
 *
 * - separate — `-m <msg>`, `-F <file>`, `--message <msg>`;
 * - glued LONG — `--message=<msg>`, `--file=<file>` (the `=` is the delimiter, so
 *   `--filex` is not `--file`);
 * - **bundled SHORT** — `-am<msg>`, `-qm<msg>`, `-aF<file>`. getopt consumes the
 *   rest of the cluster as the value of its LAST value option, so `git commit
 *   -amq SECRET` commits `q SECRET` and `git commit -aF notes.md` reads a FILE.
 *   This is the shape #1792's reader and the raw-shape backstop both missed: the
 *   reader matched only a word that STARTS with `-m`, and the backstop demanded a
 *   delimiter after it, so `-am<term>` published unchecked while `-a -m <term>`
 *   was blocked.
 *
 * ## Why an unrecognised cluster is fail-closed
 *
 * A letter that is no git commit short option makes the WHOLE word unrecognised
 * (`-ao`, `-F=x`). The reader then claims nothing, the scan's fail-closed
 * invariant or the raw-shape backstop refuses the command, and an unreadable
 * publish is never a pass. Guessing "the tail is probably the message" for a word
 * git would have rejected is the confident-wrong-answer shape this guard has
 * repeatedly been asked not to take.
 *
 * ## Where the reuse rule lives
 *
 * A commit whose message comes from ANOTHER commit is not a message shape at all
 * — there is no text in the command to read — so `--squash` / `--fixup` /
 * `--reuse-message` / `--reedit-message` and the `-c`/`-C` clusters are decided in
 * `public-hygiene-commit-reuse.ts`, which owns that refusal. The cluster grammar
 * below still has to *recognise* `c`/`C` as switches (they are, to git), and
 * reports the answer through {@link CommitCluster.reuses} for that module to ask.
 */

import { GIT_COMMIT_MESSAGE_SHAPE } from "./public-hygiene-publish-shapes.ts";

/**
 * A bundled short cluster whose letters are all switches, i.e. take NO value of
 * their own. Deliberately the narrow set: an unlisted letter unrecognises the
 * whole word (see the module header).
 *
 * `c` and `C` are in this set for ONE reason and their set membership is the
 * only place they appear: to `git commit` they are `--reuse-message`/
 * `--reedit-message`, switches whose VALUE is a commit, not a message. That
 * makes them switches as far as the cluster grammar goes, and reuse as far as
 * this guard is concerned — a cluster carrying one is reported through
 * {@link CommitCluster.reuses}, which is what `commitMessageReuse` asks.
 */
const CLUSTER_VALUELESS = new Set("aebinvqmyFEcC".split(""));

/** The letters that make a cluster a message-reuse form. */
const REUSE_LETTERS = new Set(["c", "C"]);

/** What a bundled cluster contributes: which reader owns it, and its glued tail. */
export interface CommitCluster {
  /** "commit message" for an `m` cluster, "commit message file" for an `F` one. */
  kind: "commit message" | "commit message file";
  /** Everything after the last `m`/`F` — the value, or "" when it is the next word. */
  tail: string;
  /**
   * True when a `c`/`C` sits in the cluster: the commit message then comes from
   * ANOTHER commit (git takes the reuse option's operand from the next word), so
   * no text this guard can read is in the command at all. `git commit -ac HEAD`
   * is this shape, and it is why the letters are in the valueless set — a reader
   * that declined them as unknown options published the reused message unchecked.
   */
  reuses?: boolean;
}

/**
 * Is `w` a bundled git commit short-flag cluster (`-am`, `-qmx`, `-aFsecret`,
 * `-F=x.md`)?
 *
 * A word `-<chars>` whose letters up to the last `m`/`F` are all switches.
 * Letters AFTER that option belong to the value, exactly as getopt parses them
 * — which is why `q` inside `-amq` is prose and `o` inside `-Fnotes.md` is a
 * path character, not a missing option.
 *
 * An `=` is not a delimiter here: git's short-option parser accepts the argument
 * separator on a SHORT option too, so `-F=x.md` opens `x.md` and `-m=x` commits
 * `x` (one separator is consumed, a second is part of the value). The old rule
 * declined any word containing `=`, which meant both forms claimed nothing and
 * published unscanned text — or, for `-F=`, a file the scan never opened.
 */
export function commitCluster(w: string): CommitCluster | undefined {
  if (w.length < 3 || w[0] !== "-") return undefined;
  const letters = w.slice(1);
  let valueAt = -1;
  for (let i = 0; i < letters.length; i++) {
    const ch = letters[i] ?? "";
    if (ch === "m" || ch === "F") {
      valueAt = i;
      continue;
    }
    // After the value option every character is part of the message, so an
    // option-shaped letter there is no longer a switch — stop checking. Before
    // it, an `=` is part of the value too (getopt), so `=x.md` after `F` is a
    // path and never an unrecognised letter.
    if (valueAt >= 0) break;
    if (!CLUSTER_VALUELESS.has(ch)) return undefined;
  }
  // A reuse letter BEFORE the value option makes the cluster a reuse form (the
  // option's operand is a commit named in the NEXT word). After the value option
  // there is no letter left — getopt hangs everything on the value — so a
  // trailing `c`/`C` (`-amc`, `-aFc`) is a MESSAGE or a PATH that happens to start
  // with that letter, and refusing it would be a confident wrong answer about a
  // command git never treats as reuse.
  const reuses = [...letters.slice(0, valueAt >= 0 ? valueAt + 1 : letters.length)].some((ch) =>
    REUSE_LETTERS.has(ch),
  );
  if (valueAt < 0) return reuses ? { kind: "commit message", tail: "", reuses: true } : undefined;
  // The tail is the value, and getopt consumes a leading `=` as the argument
  // separator of a short option: `git commit -m=x` commits `x`, and
  // `-F=notes.md` opens `notes.md`. `=` never ENDS a short cluster (that is what
  // the old rule got wrong) but one of them separates the letter from its value,
  // so it is dropped here rather than kept in the value.
  const tail = letters.slice(valueAt + 1).replace(/^=/, "");
  return {
    kind: letters[valueAt] === "m" ? "commit message" : "commit message file",
    ...(reuses ? { reuses: true } : {}),
    tail,
  };
}

/** The reason for a commit whose message comes from a commit the guard will not read. */
export const REUSED_MESSAGE_REASON =
  "comes from another commit (-c/-C/--reuse-message/--reedit-message/--squash/--fixup), so its text is not in this command";

/** The reason for `-F -`: the message arrives on stdin, which this guard cannot see. */
export const STDIN_MESSAGE_REASON =
  "is read from stdin (-F -), so its text is not in this command; pass a message file instead";

/**
 * Does this argv name a flag that carries a commit message or names a message
 * file? The scan's fail-closed invariant reads the answer: a `git commit` that
 * names none (`--amend --no-edit`, a bare `git commit`) takes its message from
 * the editor or the amended commit, so the guard never had a surface and the
 * command stays ordinary.
 */
export function namesCommitMessageFlag(argv: readonly string[]): boolean {
  // The shape test is the BACKSTOP, not a copy of the list below: it is the same
  // regex the raw-shape gate reads, so a word that shape calls a message flag
  // always names one here too. Without it a cluster the reader declined (a
  // letter outside the valueless set, an `=`-glued form) left the scan with a
  // publish, no text and no named surface, and the fail-closed invariant — which
  // only fires on a named surface — passed it.
  if (argv.some((w) => GIT_COMMIT_MESSAGE_SHAPE.test(w))) return true;
  return argv.some(
    (w) =>
      w === "-m" ||
      w === "-F" ||
      w.startsWith("--message") ||
      w.startsWith("--file") ||
      commitCluster(w) !== undefined,
  );
}
