/**
 * public-hygiene-push-probe — the ONE question a push scan asks git before it
 * can read a commit: is the directory it is about to read actually a repository,
 * and did the command name that repository in a way this guard resolves? (#2168)
 *
 * Split out of `public-hygiene-push.ts` along the seam AGENTS.md §12 asks for:
 * that file owns the scan (the refspec range and the two `git log`s), this one
 * owns the directory gate the scan passes through first. The two questions sit
 * together because both are answered before a single commit is read, and both
 * end the scan with a sentence rather than with data.
 *
 * ## The refused flag is read off the words, never inferred from a failed read
 *
 * A `--git-dir`/`--work-tree` push names a repository this guard does not
 * resolve, and it is refused for that. The refusal is decided BEFORE the probe,
 * because the probe cannot tell you the flag: a `--git-dir` push whose cwd is not
 * a repository fails the probe too, and the sentence the agent then reads talks
 * about a directory it never named while the flag it typed goes unmentioned. That
 * is not a cosmetic wrongness — the agent goes and fixes the directory and is
 * refused again. The segment and the words are asked ONCE by the scan and carried
 * in, so
 * the flag test, the directory the refusal names, and the directory the reads run
 * in are the same reading of the same words.
 *
 * ## An expansion makes the directory unknowable
 *
 * The scan reads the command's TEXT; bash expands it only when it runs. A
 * `-C "${WT}/wt"` is no more readable than an `--repo $(remote)` that later
 * resolves to a github.com URL the trigger never saw, so the test is the whole
 * command and not just the `-C` operand — the conservative side, and the same
 * rule `containsShellExpansion` applies to publish text. Using that predicate
 * rather than a bare `includes("$")` is what keeps a literal `$` — a single-quoted
 * `$`, a price, a prompt character — from refusing a push whose directory was
 * perfectly literal.
 *
 * ## The probe carries its own wall clock
 *
 * `exec` is a seam the caller supplies and is not obliged to answer. Every other
 * read in this scan is bounded; this one runs FIRST, so an executor that ignores
 * the `timeout` it was handed could hold the `tool_call` hook open before the
 * scan had read a single commit. The bound is the same `bounded()` every other
 * read here uses, and the sentinel it resolves to maps to the same directory
 * sentence as a probe that failed outright — a probe nobody could hear is a
 * directory nobody read, never a repository.
 *
 * `git rev-parse --show-toplevel` is the probe rather than a `<dir>/.git` path
 * test because a linked worktree's `.git` is a FILE (`gitdir: …`), not a
 * directory, and a bare-repo checkout has none where the agent stands. `git
 * rev-parse` also answers outside a repository (`--show-prefix`), so the answer is
 * required to be an absolute path; a scan whose directory sits under someone
 * else's repository is a scan of the wrong clone, and is refused rather than
 * quietly run where git happens to find a `.git` above the target.
 */

import { execGit } from "./git-range.ts";
import type { DenylistRead } from "./public-denylist.ts";
import { gitDirRefusal } from "./public-hygiene-cwd.ts";
import { codeOf } from "./public-hygiene-files.ts";
import type { PushSegment } from "./public-hygiene-push-dir.ts";
import { describeDir, refusedGlobalFlag } from "./public-hygiene-push-dir.ts";
import { bounded } from "./public-hygiene-push-reads.ts";
import type { PushScanDeps } from "./public-hygiene-push.ts";
import { containsShellExpansion } from "./public-hygiene-substitution.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * Why this scan's directory cannot be read as a repository, or `undefined` when
 * it can.
 *
 * `segment` is the caller's ONE segment answer and `words` its one segmenter call,
 * both passed in rather than recomputed: the scan needs the same answers for its
 * own reads, and two readings of the same words is how a command gets refused for
 * one thing and scanned in a directory chosen by the other.
 */
export async function scanDirectoryProblem(
  deps: PushScanDeps,
  exec: ExecFn,
  timeoutMs: number,
  maxBuffer: number,
  segment: PushSegment,
  words: readonly (readonly string[])[],
): Promise<string | undefined> {
  const deny: DenylistRead = deps.denylist ?? { state: "absent" };
  const command = deps.command ?? "";
  const dir = segment === "self" || segment === "refused" ? deps.cwd : segment;
  const refusedFlag = refusedGlobalFlag(words);
  if (segment === "refused" || refusedFlag !== undefined) {
    // The flag itself is what disqualifies the command, so it is read off the
    // words rather than inferred from a failed read: a `--git-dir` push can be
    // perfectly readable in the session directory, and that readability is the
    // lie this refuses. A push that gets here was recognised as a publish, so the
    // sentence carries its own subject.
    return `the push ${gitDirRefusal(refusedFlag ?? "--git-dir")}`;
  }
  if (containsShellExpansion(command)) {
    return (
      "the command contains a shell expansion, so the repository the push runs in could not be " +
      "read; run the push with literal paths (a `-C <dir>` with no expansion) rather than text the " +
      "shell builds"
    );
  }
  // The directory the refusal names: the one this scan reads, which for
  // `git -C <dir> push` IS the operand the agent typed — `pushGitCwd` resolved it
  // from the command's own `-C`. Naming it is what makes the sentence actionable
  // for the field shape (a wrong `-C` target), and it is safe only because
  // `describeDir` drops the path, checks the basename against the operator's
  // entries, and falls back to a phrase on a match: the operand is agent-authored
  // text, and the command the agent wrote already carries the path back to it.
  const located = describeDir(dir, deny);
  type Probe = { failed: true; code: string } | { failed: false; top: string };
  const asked = await bounded<Probe>(
    timeoutMs,
    { failed: true, code: "timed out" },
    execGit(exec, dir, ["rev-parse", "--show-toplevel"], { timeout: timeoutMs, maxBuffer })
      .then((out): Probe => ({ failed: false, top: out.trim() }))
      .catch((err: unknown): Probe => ({ failed: true, code: codeOf(err) })),
  );
  if (asked.failed) {
    return `the repository at ${located} could not be read (${asked.code})`;
  }
  if (!asked.top.startsWith("/")) {
    return `the directory the push runs in (${located}) is not inside a git repository`;
  }
  return undefined;
}
