/**
 * public-hygiene-push-dir — WHICH directory a push scan reads, and what a refusal
 * may say about it (#2168).
 *
 * Split out of `public-hygiene-push.ts` along the seam AGENTS.md §12 asks for:
 * that file owns the scan (the refspec range and the two `git log`s); this one
 * owns the two questions the scan has to answer BEFORE it can read a commit —
 * which segment of the command this scan is the scan of, and how a directory may
 * be named in a refusal. They sit together because both are answered from the
 * command's words rather than from git.
 *
 * ## Which segment: the FIRST push, not the last
 *
 * `pushGitCwd` answers the LAST segment of a chain, which is right for the
 * directory a shell leaves behind and wrong for a scan. `a && b` never reaches
 * `b` once `a` is refused, so a scan that read the last segment's tree would judge
 * commits that were never going out while the tree that WAS pushed stayed unread —
 * a chain whose first push is dirty and whose second is clean would be scanned in
 * the clean tree and passed. So the scan locates the first segment whose git takes
 * the push verb as its verb.
 *
 * The segment is located by its `-C` operand, not by replaying the chain walk:
 * `segmentCwds` carries a `cd` forward, so a replay from a reconstructed start
 * would disagree with `pushGitCwd`'s answer in a `cd`-prefixed chain and send the
 * scan's reads to a tree the push never ran in. A push segment with no `-C` runs
 * where the scan was already pointed, which is the conservative answer.
 *
 * ## What a refusal may say about a directory
 *
 * Only a basename, and only one that cleared the operator's denylist. A `-C`
 * operand is agent-authored text, and a private project name is exactly what a
 * directory name carries — the same reason the source-resolution refusal never
 * quotes a refspec and the body-file refusal never names a path. The command the
 * agent wrote already carries the path back to it, so the sentence loses nothing
 * an agent needs by printing the kind of problem and at most one word of place.
 */

import path from "node:path";
import { type DenylistRead, matchDenylist } from "./public-denylist.ts";
import { publishCommandLines } from "./public-hygiene-command.ts";
import type { PushScanDeps } from "./public-hygiene-push.ts";
import { commandPushes } from "./public-hygiene-scan.ts";
import { isGitProgramWord, walkGitGlobals } from "./public-hygiene-target.ts";

/**
 * Does this stripped argv name a git whose VERB is `pushVerb`?
 *
 * The ONE predicate for the locatable push segment, shared by the three readers that
 * have to agree about it: `ownPushSegment` (which directory this scan is the scan
 * of), `splitPushWords` (which words carry the refspecs) and {@link pushSegmentCount}
 * (how many pushes one command runs). They must be the same question asked the same
 * way, because a non-git push shape — `busybox git push`, `eval "git push"` — is a
 * push the COUNT sees and the LOCATOR cannot: when the count alone widened, such a
 * command stopped counting zero, the parse refusal went unasked, and the scan
 * resolved HEAD — the confident wrong answer this module exists to refuse.
 *
 * The verb is sought from the END of git's globals, not anywhere in the argv: a
 * branch or remote named `push` is not the verb. A refused global (`--git-dir`,
 * `--work-tree`) consumes an operand this walker cannot resolve, so its verb
 * position is unknowable and the segment counts as a push on the flag; the flag
 * refusal owns the command. A quoted run is not a program word (bash runs no program
 * from a word with a space in it), so prose that merely mentions the verb is never a
 * push segment.
 */
export function gitPushArgv(argv: readonly string[], pushVerb: string): boolean {
  if (pushVerb === "") return false;
  const prog = argv[0] ?? "";
  if (prog.includes(" ") || !isGitProgramWord(prog)) return false;
  const walk = walkGitGlobals(argv);
  return walk.refused || argv[walk.end] === pushVerb;
}

/** The segment a scan represents: a directory, the command's own, or a refused flag. */
export type PushSegment = string | "self" | "refused";

/**
 * Which segment of `deps.command` this scan is the scan of (see the module
 * header). `"refused"` means a segment names its repository with a
 * `--git-dir`/`--work-tree` spelling this guard does not resolve; `"self"` means
 * no segment claims the scan and `deps.cwd` is the answer.
 */
export function ownPushSegment(deps: PushScanDeps): PushSegment {
  const command = deps.command ?? "";
  const pushVerb = deps.pushVerb ?? "";
  const base = deps.toolCwd ?? deps.cwd;
  let refused = false;
  for (const argv of publishCommandLines(command)) {
    if (!isGitProgramWord(argv[0] ?? "")) continue;
    const walk = walkGitGlobals(argv);
    if (walk.refused) refused = true;
    // The segment represents this scan only if git would take the push verb as its
    // verb there (or carries a refused global, whose verb position is unknowable
    // and is refused on the flag anyway) — the one predicate in {@link gitPushArgv}.
    if (!gitPushArgv(argv, pushVerb)) continue;
    if (walk.dir !== undefined && walk.dir !== "") return path.resolve(base, walk.dir);
    return deps.cwd;
  }
  return refused ? "refused" : "self";
}

/**
 * The push command's own git words, segmenter-stripped — the lists the readers of
 * the verb and of git's pre-verb globals walk.
 *
 * The segmenter is called ONCE for a scan and its answer handed to every reader
 * (`scanDirectoryProblem` and the refspec/remote readers all take these words),
 * because two readings of one command is how a push gets refused for the flag one
 * reading saw and scanned in the directory the other resolved (#2168). Each argv
 * is wrapper- and prefix-stripped, so `argv[0]` is the PROGRAM word and
 * {@link walkGitGlobals} can be asked of it directly.
 */
export function pushCommandWords(deps: PushScanDeps): string[][] {
  return publishCommandLines(deps.command ?? "");
}

/**
 * How many `git` segments of the command take the push verb as their VERB.
 *
 * Asked of the SAME stripped lines the segment is located from, so the count
 * cannot disagree with the segment the scan reads: a command the segmenter reduces
 * to no git argv counts zero, which is the fact that makes a range unlocatable.
 *
 * The count, rather than a boolean, is what the scan needs. `commandPushes` is
 * deliberately an over-approximation (a regex over the raw text, a shell body, a
 * runner payload), so "the trigger called this a push" and "a git segment takes
 * the verb" are different facts: the first is the reason to scan, the second is
 * the only thing that makes a range locatable. Two of the second in one command is
 * the shape that fails open — the scan answers for ONE segment, so the second push
 * goes out unread, and `a && b` DOES reach `b` once `a` succeeds.
 *
 * ## A second push whose program word is not git
 *
 * Counting only the segments whose stripped program word is git counted ONE for
 * `git push origin a && flock /tmp/l git push origin b`: the second segment runs
 * `flock`, `bash -c`, `docker run`, `busybox` or `eval`, and the trigger fires on
 * its payload, so git's own words never reach the verb reader. One scan ran, the
 * chain reached the second push, and it published unread — the same fail-open as two
 * plain pushes, with a program word in front of it. So a segment counts when the
 * trigger fires on ITS OWN words too. The words of one segment, never of the joined
 * command: joined, the regex fires once for any chain that pushes anywhere and
 * every `git push && git log` — one push, one read — would be refused for two.
 *
 * The trigger is an over-approximation, so `echo "git push" && git push origin b`
 * would ride the same reading into a refusal of a routine push. The over-match is
 * the trigger's own documented cost — a publish scan that reads prose is a scan of
 * a little extra text — and a one-push refusal is not: so the trigger's answer is
 * accepted only where its payload is executable text, {@link executablePayload}
 * below, and the two refusals that come of the count stay the two sentences this
 * module owns.
 *
 * The verb is sought from the END of git's globals, not anywhere in the argv: a
 * branch or remote named `push` is not the verb. A refused global (`--git-dir`,
 * `--work-tree`) consumes an operand this walker cannot resolve, so its verb
 * position is unknowable — such a segment counts once, and the existing flag
 * refusal owns the command. A quoted run is not a program word (bash runs no
 * program from a word with a space in it), so prose that merely mentions the verb
 * never counts through the verb reading.
 *
 * A non-git segment counts only WHERE THE COMMAND ALSO CARRIES A PUSH THE SCAN CAN
 * READ (`git push origin a && busybox git push origin b`). A command of non-git
 * segments alone counts zero whatever the trigger reads in it — `busybox git push`,
 * `eval "git push"`, `docker run img git push` — because a scan that locates no
 * git verb has no range to answer for, and it is the ZERO that raises the parse
 * refusal. Letting such a segment count on its own removed the parse refusal and
 * sent the scan back to resolving HEAD, the confident wrong answer this module
 * exists to refuse. The one-push rule is about the pushes a scan cannot cover; a
 * command that is nothing but uncoverable pushes is the parse case, not the count
 * case.
 */
export function pushSegmentCount(command: string, pushVerb: string): number {
  if (pushVerb === "") return 0;
  const lines = publishCommandLines(command);
  // Locatable first: a command with no readable push has NO range to scan, whatever
  // else its words say, and the zero is the fact the parse refusal is built on.
  let locatable = 0;
  for (const argv of lines) if (gitPushArgv(argv, pushVerb)) locatable++;
  if (locatable === 0) return 0;
  let count = locatable;
  for (const argv of lines) {
    if (argv.length === 0 || gitPushArgv(argv, pushVerb)) continue;
    // The non-git half: a program whose words the shell will RUN, whose own text the
    // trigger calls a push. Asked of this segment's words ALONE — see the header for
    // what asking the whole chain does.
    if (executablePayload(argv) !== undefined && commandPushes(argv.join(" "))) count++;
  }
  return count;
}

/**
 * The text this segment's program hands to a shell to RUN, or `undefined`.
 *
 * `git push` reached through a program the wrapper table does not know is written
 * in an operand bash will execute, not in an operand it treats as data. Three
 * shapes: `eval`'s and `script -c`/`--command`'s payload, a shell's `-c` BODY, and
 * the argv of any other program, which carries git's own words as its arguments
 * (`busybox git push`, `docker run img git push`, `flock /tmp/l git push`).
 *
 * A `cat`/`grep`/`sed`-style operand whose text is DATA — the trigger's own
 * documented over-match — is excluded by what the program does with its words, not
 * by which program was named. `runnerPayloads` in `public-hygiene-scan.ts` is the
 * narrower sibling of this question: it answers only for the three runners it
 * names, and only when its content test fires. This one answers for every shape the
 * count has to see, and answers by what the words ARE — the executable tail of a
 * command — rather than by a content match that prose satisfies too.
 */
export function executablePayload(argv: readonly string[]): string | undefined {
  const prog = argv[0] ?? "";
  if (prog === "" || prog.includes(" ")) return undefined;
  const base = path.basename(prog);
  if (SCRIPT_RUNNERS.has(base)) {
    // `eval` was already handed its payload as words by the segmenter, which also
    // UNQUOTED it (`eval "git push"` arrives as `eval git push`); `script -c` keeps
    // its payload as one operand. Either way the words after the runner are the
    // text the shell runs, and joining them is the shape the trigger reads — the
    // same reading `commandPushes` gives an `eval` segment, whose payload test
    // joins these words rather than asking them of an empty string.
    const body = base === "script" ? (scriptBody(argv) ?? "") : argv.slice(1).join(" ");
    return body === "" ? undefined : body;
  }
  if (SHELL_RUNNERS.has(base)) {
    const body = shellDashCBody(argv) ?? "";
    return body === "" ? undefined : body;
  }
  if (DATA_PROGRAMS.has(base)) return undefined;
  const tail = argv.slice(1).join(" ");
  return tail === "" ? undefined : tail;
}

/** Programs whose only operand is a script the shell will run (`eval`, `script -c`). */
const SCRIPT_RUNNERS = new Set(["eval", "script"]);
/** Programs whose `-c` operand is a script the shell will run. */
const SHELL_RUNNERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
/**
 * Programs whose operands are DATA: printed, matched, or copied, never executed.
 * A command that runs none of these and no runner takes its git words as argv, and
 * argv is what the shell execs.
 */
const DATA_PROGRAMS = new Set([
  "echo",
  "printf",
  "cat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "sed",
  "awk",
  "perl",
  "python",
  "python3",
  "ruby",
  "node",
  "less",
  "more",
  "tail",
  "head",
  "tee",
  "sort",
  "uniq",
  "cut",
]);

/** The payload `script` is told to run (`-c BODY`, `--command BODY`, `--command=BODY`). */
function scriptBody(argv: readonly string[]): string | undefined {
  const flagAt = argv.findIndex(
    (w, i) =>
      i > 0 &&
      (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w) || w === "--command" || w.startsWith("--command=")),
  );
  if (flagAt < 0) return undefined;
  const flag = argv[flagAt] ?? "";
  return flag.startsWith("--command=") ? flag.slice("--command=".length) : (argv[flagAt + 1] ?? "");
}

/** The body a shell's `-c` flag carries (`bash -c BODY`); no `-c`, no body. */
function shellDashCBody(argv: readonly string[]): string | undefined {
  const flagAt = argv.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  return flagAt < 0 ? undefined : (argv[flagAt + 1] ?? "");
}

/**
 * The two refusals a push scan raises from the command's WORDS, before a single git
 * read, because both are statements about what the scan could LOCATE rather than
 * about what git would print.
 *
 * Every other refusal of this scan is produced by a read below it. These two are
 * not: they refuse a scan that CANNOT be built, and a scan that cannot be built
 * answers for a range nobody located — HEAD, in a directory somebody else resolved
 * — which is the confident wrong answer this module exists to refuse. Both read the
 * one segmenter answer the segment itself comes from, never the raw segmenter: two
 * readings of one command is what let `xargs git push` be answered for HEAD while
 * the same family with a refspec was refused (#2168).
 */

/**
 * The trigger called this command a push, but no `git` segment of it takes the verb
 * where git reads its verb.
 *
 * `eval "git push"`, `bash -c '…'`, `busybox git push`, `docker run … git push`, a
 * heredoc fed to a shell: each reaches the trigger through a body or payload the
 * segmenter never reduces to a git argv, so the refspec reader has no verb word and
 * no refspecs, falls into its no-refspec branch, and resolves HEAD — the clone's
 * checked-out branch, which is not what the command publishes. Refusing is the same
 * rule `unseenPublishReason` applies to a publish the scan could not see, and the
 * sentence names the fix rather than the mystery.
 */
export const UNPARSABLE_PUSH_REASON =
  "the push command could not be parsed: run git push directly, not through a wrapper " +
  "or an interpreter";

/**
 * More than one push in one command.
 *
 * The scan is the scan of ONE segment (the first push's tree), so every push after
 * it is published unread — and `a && b` reaches `b` once `a` succeeds, which is what
 * makes the unread half a fail-OPEN rather than a hypothetical: a chain whose first
 * tree is clean and whose second carries the term was scanned clean and published
 * dirty. One scan per push is the rule, so the second push gets refused instead of
 * inheriting the first one's verdict.
 */
export const ONE_PUSH_REASON =
  "the push command pushes more than once, so run each push on its own: one push per command";

/**
 * The `--git-dir`/`--work-tree` the scan's own command types, or `undefined`.
 *
 * This is the question "does this push name its repository in a way this guard
 * refuses to resolve", asked of the SAME words the segment reader walked — so the
 * refusal and the directory can never disagree about which command they are
 * talking about. It is deliberately asked of the WORDS rather than read off the
 * segment answer: `ownPushSegment` returns a directory as soon as a segment
 * carries a `-C`, so a chain like `git --git-dir X push && git -C Y push` answers
 * with a directory and the flag would go unreported, which is the confident wrong
 * answer this refuses. The flag is the disqualifier whether or not some segment
 * also moved the git.
 *
 * A quoted run is not a program word (`echo "git push"` arrives as one word
 * containing a space), so a word with a space is skipped: bash runs no program
 * from it, and prose must not be refused for a flag it merely mentions.
 */
export function refusedGlobalFlag(words: readonly (readonly string[])[]): string | undefined {
  for (const argv of words) {
    const prog = argv[0] ?? "";
    if (!isGitProgramWord(prog) || prog.includes(" ")) continue;
    const flag = walkGitGlobals(argv).refusedFlag;
    if (flag !== undefined) return flag;
  }
  return undefined;
}

/**
 * A directory in a refusal: the basename, or nothing at all.
 *
 * Only a basename, and only one whose every component cleared the operator's
 * entries. A `-C` operand is agent-authored text, and a private project name is
 * exactly what a directory name carries — the same reason the source-resolution
 * refusal never quotes a refspec and the body-file refusal never names a path.
 * Checking the LEAF alone was the first reading and it is not enough: `-C
 * /srv/private-project/wt` prints `wt` while the private word sat in the segment
 * above it, and the sentence would then be a leak chosen by the checker. Every
 * component is judged because a path's privacy does not live only in its last
 * segment. What an agent acts on is the KIND of problem, and the command it just
 * wrote already carries the whole path back to it, so a refusal that gives the
 * kind and no place at all loses nothing.
 */
export function describeDir(dir: string, deny: DenylistRead): string {
  const hidden = "a directory named in the command";
  if (deny.state !== "ok") return hidden;
  const trimmed = dir.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (base === "") return hidden;
  for (const segment of trimmed.split("/").filter((s) => s !== "")) {
    // A single-character segment (`/srv/x`) is a path separator's noise, not a
    // name a denylist carries, and refusing on it would hide the ordinary case.
    if (segment.length < 2) continue;
    if (matchDenylist(deny.entries, segment)) return hidden;
  }
  return base;
}
