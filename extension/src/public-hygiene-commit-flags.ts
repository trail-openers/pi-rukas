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
 */

/**
 * A bundled short cluster whose letters are all switches, i.e. take NO value of
 * their own. Deliberately the narrow set: an unlisted letter unrecognises the
 * whole word (see the module header).
 */
const CLUSTER_VALUELESS = new Set("aebinvqmyFE".split(""));

/** What a bundled cluster contributes: which reader owns it, and its glued tail. */
export interface CommitCluster {
  /** "commit message" for an `m` cluster, "commit message file" for an `F` one. */
  kind: "commit message" | "commit message file";
  /** Everything after the last `m`/`F` — the value, or "" when it is the next word. */
  tail: string;
}

/**
 * Is `w` a bundled git commit short-flag cluster (`-am`, `-qmx`, `-aFsecret`)?
 *
 * A word `-<letters>` with no `=`, whose letters up to the last `m`/`F` are all
 * switches. Letters AFTER that option belong to the value, exactly as getopt
 * parses them — which is why `q` inside `-amq` is prose and `o` inside
 * `-Fnotes.md` is a path character, not a missing option.
 */
export function commitCluster(w: string): CommitCluster | undefined {
  if (w.length < 3 || w[0] !== "-" || w.includes("=")) return undefined;
  const letters = w.slice(1);
  let valueAt = -1;
  for (let i = 0; i < letters.length; i++) {
    const ch = letters[i] ?? "";
    if (ch === "m" || ch === "F") {
      valueAt = i;
      continue;
    }
    // After the value option every character is part of the message, so an
    // option-shaped letter there is no longer a switch — stop checking.
    if (valueAt >= 0) break;
    if (!CLUSTER_VALUELESS.has(ch)) return undefined;
  }
  if (valueAt < 0) return undefined;
  return {
    kind: letters[valueAt] === "m" ? "commit message" : "commit message file",
    tail: letters.slice(valueAt + 1),
  };
}

/** The reason for a commit whose message comes from a commit the guard will not read. */
export const REUSED_MESSAGE_REASON =
  "comes from another commit (-c/-C/--reuse-message/--reedit-message), so its text is not in this command";

/** The reason for `-F -`: the message arrives on stdin, which this guard cannot see. */
export const STDIN_MESSAGE_REASON =
  "is read from stdin (-F -), so its text is not in this command; pass a message file instead";

/**
 * A `git commit` message-reuse form: `-c`/`-C`/`--reuse-message`/
 * `--reedit-message` (and their glued long forms) take a commit whose message
 * the guard does not read, so the text that gets published exists only in that
 * other commit. `git commit -c HEAD~1 --amend` is the shape this names.
 */
export function commitMessageReuse(argv: readonly string[]): boolean {
  for (const w of argv) {
    // `--reuse-message=<ref>` / `--reedit-message=<ref>` are reuse; `--no-edit`
    // and every other `--no-*` switch are not, and are excluded by NAME — an
    // ordinary `git commit --amend --no-edit` reuses the CURRENT message the
    // guard has no reason to refuse, and a substring test would refuse it.
    if (/^--(?:no-)?(?:reuse|reedit)-message(?:=|$)/.test(w) && !w.startsWith("--no-")) return true;
    if (w === "-c" || w === "-C") return true;
    if (w.length > 2 && (w.startsWith("-c") || w.startsWith("-C"))) {
      // `-c<ref>` glued. A cluster may still bundle valueless switches around it
      // (`-am` is not one of these — `m` takes a value), so every letter but the
      // reuse one has to be a switch that takes nothing.
      const letters = w.slice(1);
      if (![...letters].every((ch) => ch === "c" || ch === "C" || CLUSTER_VALUELESS.has(ch)))
        continue;
      return true;
    }
  }
  return false;
}

/**
 * Does this argv name a flag that carries a commit message or names a message
 * file? The scan's fail-closed invariant reads the answer: a `git commit` that
 * names none (`--amend --no-edit`, a bare `git commit`) takes its message from
 * the editor or the amended commit, so the guard never had a surface and the
 * command stays ordinary.
 */
export function namesCommitMessageFlag(argv: readonly string[]): boolean {
  return argv.some(
    (w) =>
      w === "-m" ||
      w === "-F" ||
      w.startsWith("--message") ||
      w.startsWith("--file") ||
      commitCluster(w) !== undefined,
  );
}
