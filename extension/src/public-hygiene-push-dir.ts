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
import { isGitProgramWord, walkGitGlobals } from "./public-hygiene-target.ts";

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
    if (!isGitProgramWord(argv[0])) continue;
    const walk = walkGitGlobals(argv);
    if (walk.refused) refused = true;
    // The segment represents this scan only if git would take the push verb as its
    // verb there (or carries a refused global, whose verb position is unknowable
    // and is refused on the flag anyway).
    const isPush = walk.refused || argv.some((word, at) => at >= walk.end && word === pushVerb);
    if (!isPush) continue;
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
 * The verb is sought from the END of git's globals, not anywhere in the argv: a
 * branch or remote named `push` is not the verb. A refused global (`--git-dir`,
 * `--work-tree`) consumes an operand this walker cannot resolve, so its verb
 * position is unknowable — such a segment counts once, and the existing flag
 * refusal owns the command. A quoted run is not a program word (bash runs no
 * program from a word with a space in it), so prose that merely mentions the verb
 * never counts.
 */
export function pushSegmentCount(command: string, pushVerb: string): number {
  if (pushVerb === "") return 0;
  let count = 0;
  for (const argv of publishCommandLines(command)) {
    const prog = argv[0] ?? "";
    if (prog.includes(" ") || !isGitProgramWord(prog)) continue;
    const walk = walkGitGlobals(argv);
    if (walk.refused) {
      count++;
      continue;
    }
    if (argv[walk.end] === pushVerb) count++;
  }
  return count;
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
