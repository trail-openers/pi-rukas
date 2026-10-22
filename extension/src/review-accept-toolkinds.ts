/**
 * review-accept-toolkinds — the FIVE kinds of read tool clause (5) recognises, and the two
 * derived sets the exemption and the arms ask (#1764 criterion 1).
 *
 * This is the taxonomy half of `review-accept-readtools`, split out so each module holds
 * one thing: this file says WHICH KIND of read a word is, that module says whether the
 * file it was handed is one the guard can read. The kinds and their doc comments are the
 * authoritative record of why each tool sits where it does — including the two moves
 * #1764 made: `ls`/`wc`/`file`/`stat` left the print class because they read the file
 * they are handed, and `which` left it too because it walks `PATH` looking for its operand.
 *
 * The pattern tools (`ag`, `sed`, `awk`) are in CHECKED_TOOLS and NOT in READ_TOOLS: the
 * question "can this program read the file it was handed?" is not the question "does an arm
 * admit it?".
 */

/** Tools that print the CONTENT of the file they are handed. */
const CONTENT_TOOLS: ReadonlySet<string> = new Set(["cat", "head", "tail"]);
/** Tools that search a file: the pattern is prose, the rest are files — until a pattern
 * flag makes every positional a file. */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["grep", "rg"]);
/** Pattern-argument tools no arm admits: `ag` is a grep peer the allowlist never named,
 * and `sed` / `awk` were REMOVED from the allowlist because each can run a shell or write
 * a file. They are still asked the operand question — all three print the bytes of the
 * file they are handed — so an unresolved operand on any of them is in scope, where no arm
 * will then admit the segment (#1764 fix round, criterion 1's pattern-tool list). */
const PATTERN_TOOLS_ONLY: ReadonlySet<string> = new Set(["ag", "sed", "awk"]);
/** Tools that read the file they are handed to describe it, not to print it: `wc` counts
 * its bytes, `file` its magic, `stat` its inode, `ls` its directory entry, `which` walks
 * every directory on `PATH` looking for its operand. An unreadable operand is an
 * unreadable read (#1764 fix round: they left PRINT_TOOLS for this; round 5 moved `which`
 * here for the same reason — its argument is not text it echoes, it is a probe the shell
 * resolves against PATH, so `which $F` asks the guard to bless a lookup it cannot name).
 * It stays an A8-admissible tool: `which bats` is a read of the filesystem the guard has
 * no reason to refuse, and only an UNREADABLE operand is. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["ls", "wc", "file", "stat", "which"]);
/** Tools that print their own arguments or move the shell along: they read no file the
 * guard could be protecting, so an expansion among their arguments is ordinary shell
 * text and brings nothing into scope (#1764 criterion 1's never-a-trigger list). `which`
 * left this class in round 5 — see `FILE_TOOLS`. */
const PRINT_TOOLS: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "pwd",
  "true",
  "basename",
  "dirname",
]);
/** A navigate tool: admitted by A8, reads no file, prints no file. Separated from the
 * print class so "PRINT_TOOLS is exactly the six argument-printers" stays a checkable
 * claim (#1764 fix round, criterion 3; `which` left the class in round 5). */
const NAVIGATE_TOOLS: ReadonlySet<string> = new Set(["cd"]);

/** The read tools arm A8 admits. Defined HERE, as the union of the kinds the scope test
 * distinguishes, so the arm's list and the clause's classification cannot drift into each
 * other — a tool added to one and not the other is the bug this shape prevents. The
 * pattern tools no arm admits are deliberately NOT in this union. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  ...CONTENT_TOOLS,
  ...SEARCH_TOOLS,
  ...FILE_TOOLS,
  ...PRINT_TOOLS,
  ...NAVIGATE_TOOLS,
]);

/** The tools whose FILE operands the scope test asks: everything that opens a file it was
 * handed, admissible or not. A SEARCH-class tool's first positional is its pattern; the
 * two sets share that arithmetic because the pattern prose is the same fact for `grep` and
 * for `awk` alike. Exported for the exemption module (#1764 round 4), whose per-segment
 * understanding test asks the SAME "is there a checked tool in this segment" question —
 * two lists would be one drift away from an under-refusal. */
export const CHECKED_TOOLS: ReadonlySet<string> = new Set([
  ...CONTENT_TOOLS,
  ...FILE_TOOLS,
  ...SEARCH_TOOLS,
  ...PATTERN_TOOLS_ONLY,
]);
/** Among the checked tools, the ones whose FIRST positional is a pattern / program rather
 * than a file. Exported for the exemption module (same reason as `CHECKED_TOOLS`). */
export const PATTERN_FIRST_TOOLS: ReadonlySet<string> = new Set([
  ...SEARCH_TOOLS,
  ...PATTERN_TOOLS_ONLY,
]);
/** The print class, exported for the exemption module: an argument of one of these is
 * text the tool ECHOES, never a path it opens, so the understanding test does not price
 * them as operands (#1764 criterion 1's never-a-trigger list).
 *
 * The NAVIGATE class has no export of its own on purpose: `cd` is admissible (it is in
 * `READ_TOOLS`) but is not a class the understanding test exempts — `cd $WT` is a directory
 * the guard cannot name, and the unknown-program branch already asks it that way. */
export const PRINT_TOOLS_ONLY: ReadonlySet<string> = PRINT_TOOLS;
