/**
 * lens-skill-path — the filesystem-facing half of the skill-load proof.
 *
 * `skillLoadProof` (lens-skill-load-proof.ts) decides whether a lens child's
 * `Skill Load Status: SUCCESS` is corroborated by its recorded tool calls. That
 * decision is a path comparison, and path comparison against a real skills tree
 * is where every false refutation in this check's history came from — so the
 * filesystem lives here, one seam away from the rule.
 *
 * The asymmetry this module exists to enforce:
 *
 *   - `realpathSync` runs on paths the DRIVER built and nowhere else. The skills
 *     dir `install.sh` populates is a symlink tree (`ln -sfn`, one link per
 *     `skill/*`), so the path the driver built and the path the child opened are
 *     two strings for one file; on macOS `$TMPDIR` lives under `/var` →
 *     `/private/var`, so even a tree with no symlink in it disagrees with itself.
 *   - a CHILD-reported path is only ever compared lexically. Following a symlink
 *     whose target an LLM named is a filesystem lookup on input nobody vetted,
 *     and a mismatch there refutes the honest child.
 *
 * Both sides are best-effort and total: an unresolvable path is "no candidate",
 * never a throw. The caller blocks lens reviews on the answer, so a module that
 * can throw can block a review that had nothing wrong with it.
 */

import fs from "node:fs";
import path from "node:path";

/** The one file inside a skill directory that holds the skill. Exported because
 * the proof's pre-filter tests for this name, and the two must not disagree. */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * The skill DIRECTORY the proof is about, canonicalised — or "" when the driver
 * handed us nothing to match, in which case no tool call can prove anything and
 * the caller must abstain rather than refute.
 */
export function resolveSkillDir(skillPath: string): string {
  return lexical(skillPath ?? "");
}

/**
 * Every spelling of THIS lens's skill file the proof will accept — all built by
 * this process, none from a child.
 *
 * THREE spellings, because the real tree has two symlink levels and an honest
 * child may have resolved either one, or neither:
 *   1. as-built — what a child echoes back verbatim after reading the path the
 *      prompt printed (always in the set, even when nothing resolves);
 *   2. fully canonical — what a child has open after following every link, i.e.
 *      what `fs.realpathSync(skillPath)` itself reports;
 *   3. parent canonical, leaf as-built — the leaf is a link over a directory
 *      holding a real `SKILL.md`, and an ANCESTOR may be a link too.
 * Resolving only the whole path, or only the leaf, misses the others and refutes
 * a child that resolved just one. That is the false-downgrade class that made the
 * whole check shadow-only.
 */
export function skillFileCandidates(dir: string): string[] {
  const out: string[] = [];
  const add = (d: string): void => {
    if (!d) return;
    // Normalise against the PARENT, not the dir itself: `path.posix.join` only
    // collapses `..` that sits to the right of its own component, so
    // `<skills>/code-review-security/../code-review-security` joined with
    // `SKILL.md` would otherwise keep the detour and fail to match the honest
    // spelling of the same file.
    const candidate = path.posix.normalize(
      path.posix.join(path.posix.dirname(d), path.posix.basename(d), SKILL_FILE_NAME),
    );
    if (candidate && !out.includes(candidate)) out.push(candidate);
  };
  add(dir);
  add(realpathOr(dir));
  const parentReal = realpathOr(path.posix.dirname(dir));
  const leaf = path.posix.basename(dir);
  if (parentReal && leaf) add(path.posix.join(parentReal, leaf));
  return out;
}

/**
 * The directory form of each accepted file spelling. Used to reject a command
 * that named the DIRECTORY — `cat <dir>` is an error, not a load — which matters
 * because the prompt hands the child a directory and crediting it (the
 * pre-round-3 rule) accepted a read that opened nothing.
 */
export function candidateDirs(wants: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of wants) {
    const d = path.posix.dirname(w);
    if (d && d !== "." && d !== "/" && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * Does a child-reported path name one of the driver's own skill files, by
 * INODE rather than by string?
 *
 * The last resort when the lexical comparison misses, built so that being wrong
 * here costs a missed `proven` rather than manufacturing a false one:
 *
 *   - it is reached only after every lexical spelling failed, so it can only
 *     ever turn an `unproven` into a `proven` — never the reverse, which is the
 *     direction that blocks a lens;
 *   - the comparison target is always a path this process built
 *     (`skillFileCandidates`), never a child string, so a child cannot point the
 *     comparison at a file of its choosing — it can name a candidate path, and
 *     that path still has to resolve to one of ours;
 *   - the pre-filter is free and load-bearing: a token not even named `SKILL.md`
 *     cannot be the skill file, so the overwhelming majority of tool calls (every
 *     `src/foo.ts` a lens reads) never reach the filesystem at all. A child
 *     therefore cannot drive this into a syscall per token; only paths that
 *     already look like the answer do;
 *   - total on failure: an unresolvable path is "not a match", not a throw.
 */
export function sameFileAsAny(candidate: string, wants: readonly string[]): boolean {
  if (path.posix.basename(candidate) !== SKILL_FILE_NAME) return false;
  const gotReal = realpathOr(candidate);
  if (!gotReal) return false;
  return wants.some((w) => w === gotReal || realpathOr(w) === gotReal);
}

/**
 * Canonical form of a CHILD-reported path, WITHOUT a syscall on it.
 *
 * `path.posix.normalize` collapses `.` / `..` / duplicate separators, so a `..`
 * detour that lands back on the skill file is recognised as that file. That is
 * the whole transformation, and deliberately the only one: total, deterministic,
 * and not steerable by a child into a filesystem lookup.
 *
 * A purely-lexical child side still matches a driver side that went through
 * `realpathSync` because `skillFileCandidates` enumerates EVERY spelling of the
 * driver's own directory, so a child that quoted the prompt's path or opened the
 * symlink target both land on a member of that list. A child that invents a
 * prefix matches nothing.
 */
export function lexical(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  return path.posix.normalize(trimmed.replace(/\\/g, "/").replace(/\/+$/, ""));
}

/** `realpathSync`, best-effort: "" when the path does not resolve, so every
 * caller treats "could not resolve" as "no candidate" rather than a throw. */
function realpathOr(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return "";
  }
}
