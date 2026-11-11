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

/** The directory every git read of this scan runs in (see {@link ownPushSegment}). */
export function scanCwd(deps: PushScanDeps): string {
  const own = ownPushSegment(deps);
  return own === "self" || own === "refused" ? deps.cwd : own;
}

/**
 * A directory in a refusal: the basename, or nothing at all.
 *
 * The basename is checked against the operator's own entries first, and a basename
 * that matches one is replaced by "a directory named in the command": the refusal
 * still says which KIND of problem stopped the scan, which is what an agent acts
 * on, and no private name reaches the transcript.
 */
export function describeDir(dir: string, deny: DenylistRead): string {
  const trimmed = dir.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (base === "") return "a directory named in the command";
  if (deny.state === "ok" && matchDenylist(deny.entries, base)) {
    return "a directory named in the command";
  }
  return base;
}
