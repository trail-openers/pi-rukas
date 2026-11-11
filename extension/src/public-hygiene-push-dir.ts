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
