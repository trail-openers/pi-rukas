/**
 * test-hygiene-push-segment.ts — which segment a push scan represents, and what
 * its directory probe is worth when git will not answer (#2168, fix wave).
 *
 * Two behaviours, both answered from the command's WORDS rather than from git,
 * and both defects the six-lens review found in the scan that reads them:
 *
 * 1. `ownPushSegment` is asked ONCE per scan and carried through. The `refused`
 *    answer must reach the caller BEFORE the repository probe runs, because a
 *    `--git-dir`/`--work-tree` push whose cwd is not a repository produced the
 *    directory sentence — a sentence about a directory the guard could not read —
 *    where the truth is the flag the agent typed. A refusal that names the wrong
 *    thing sends the agent to fix the wrong thing.
 * 2. The `git rev-parse --show-toplevel` probe carries a wall clock of its own.
 *    Every other read in this scan is bounded, and the probe is the one that runs
 *    FIRST: an executor that ignores the `timeout` it was handed hung the whole
 *    scan there, which is the hung guard an operator switches off.
 *
 * Both are driven through `scanDirectoryProblem` with a scripted executor, so no repository exists and no git runs — the answer is
 * supposed to come from the words and from the clock, and the test proves it does.
 *
 * Run: bun run smoke-tests/test-hygiene-push-segment.ts
 */

import { ownPushSegment, pushCommandWords } from "../src/public-hygiene-push-dir.ts";
import { scanDirectoryProblem } from "../src/public-hygiene-push-probe.ts";
import type { PushScanDeps } from "../src/public-hygiene-push.ts";
import type { ExecFn } from "../src/worktree.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const PUSH = ["pu", "sh"].join("");

/** Ask the directory gate with ONE segment/words pair, as the scan does. */
const ask = (
  deps: PushScanDeps,
  exec: ExecFn,
  timeoutMs = 5_000,
): Promise<string | undefined> =>
  scanDirectoryProblem(deps, exec, timeoutMs, 1024, ownPushSegment(deps), pushCommandWords(deps));
const GIT_DIR = ["--", "git-dir"].join("");
const WORK_TREE = ["--", "work-tree"].join("");

/** Deps for a push command whose scan directory is `cwd` (no `-C` to resolve). */
const depsOf = (command: string, cwd = "/not-a-repo"): PushScanDeps => ({
  exec: () => Promise.reject(Object.assign(new Error("no git"), { code: 128 })),
  cwd,
  // The TOOL call's directory, which the scan's cwd is not: `ownPushSegment`
  // resolves a relative `-C` against this, exactly as the scan reads a worktree
  // operand from the command rather than from the tree it was handed.
  toolCwd: "/session",
  command,
  pushVerb: PUSH,
});

// ── 1. The refused flag is decided from the words, before any git read.
//
// The cwd is deliberately NOT a repository. A scan that probed first would report
// the directory, and the directory sentence is what hid the flag (H1).
for (const spelling of [
  `${GIT_DIR} /w/.git`,
  `${GIT_DIR}=/w/.git`,
  `${WORK_TREE} /w`,
  `${WORK_TREE}=/w`,
]) {
  const command = `git ${spelling} ${PUSH} origin main`;
  const asked: string[][] = [];
  const recording: ExecFn = (_cmd, opts) => {
    asked.push(opts?.argv ?? []);
    return Promise.reject(Object.assign(new Error("would-be-a-repo"), { code: 128 }));
  };
  const problem = await ask(depsOf(command), recording);
  assert(
    problem !== undefined && problem.includes(spelling.split(/[ =]/)[0] ?? ""),
    `a \`${spelling}\` push from a non-repository cwd is refused with a sentence naming the flag (H1)`,
  );
  assert(
    asked.length === 0,
    `and the refusal came BEFORE the probe: no git call was made for \`${spelling}\` (H1)`,
  );
}

// A command with the refused flag AND a real repository still refuses on the
// flag — the flag is the disqualifier, not the readability of the session clone.
{
  const command = `git ${GIT_DIR} /w/.git ${PUSH} origin main`;
  const problem = await ask(depsOf(command),
    () => Promise.resolve({ stdout: "/w\n" } as never));
  assert(
    problem !== undefined && problem.includes(GIT_DIR),
    "a readable session repository does not excuse the refused flag",
  );
}

// ── 2. One segment per scan, carried through (H1's second half).
//
// `ownPushSegment` is the single answer the scan reuses: the refused check, the
// directory a refusal names, and the directory the reads run in must all come
// from ONE call, or a `--git-dir` push can be refused on the words and then have
// its reads pointed at a directory the second call computed differently.
{
  const command = `echo done && git -C /first ${PUSH} origin a && git -C /second ${PUSH} origin b`;
  const first = ownPushSegment(depsOf(command, "/session"));
  assert(
    first === "/first",
    "the segment is the FIRST push of the chain, not the last (H1 carry-through)",
  );
  const second = ownPushSegment(depsOf(command, "/session"));
  assert(second === first, "and asking twice cannot disagree — the scan reuses one answer");
  // A refused segment with no `-C` answers `"refused"`; one WITH a `-C` answers the
  // directory, because the segment reader's job is the directory and the flag is a
  // separate question the caller asks of the words. Both must refuse the push, which
  // is why `ask` consults the words and not only this answer.
  // `refused` is the answer only when NO segment claimed a directory — a refused
  // global alone, with no `-C` to move the git. The moment a `-C` names the tree,
  // the segment reader answers the directory (its job) and the flag is the separate
  // question the gate asks of the words; both paths refuse the push.
  // The `refused` arm of the answer is reached by a command whose git is not the
  // scan's own push — a non-git command carrying the flag, which leaves every
  // push-segment test unsatisfied and falls through. A refused PUSH, by contrast,
  // answers a directory (`deps.cwd`, or the `-C` operand): the segment reader's job
  // is the directory, and the flag is the separate question the gate asks of the
  // words. Both paths refuse the push, which is what the two `ask` assertions below
  // pin — reading the flag off the words is what makes the push arm refuse too.
  // The `refused` arm is documented as "a segment names its repository with a
  // refused spelling", but a refused PUSH never reaches it: the loop returns
  // `deps.cwd` for that segment before the fall-through can answer `refused`. So
  // the arm is only reachable by a command whose git is never asked (no git argv at
  // all), and the pin below says so rather than pretending a push takes it. What a
  // refused PUSH gets is the directory plus the flag in the words — and the gate
  // refuses on the words, which is the assertion that actually matters.
  const refused = ownPushSegment(depsOf("true && true", "/session"));
  assert(refused === "self", "a command with no git segment claims nothing — `self`");
  const refusedPush = ownPushSegment(depsOf(`git ${WORK_TREE} /w ${PUSH} origin main`, "/session"));
  assert(
    refusedPush === "/session",
    "a refused push answers the scan's own directory, so the gate cannot rely on `refused` alone",
  );
  const refusedByWords = await ask(
    depsOf(`git ${WORK_TREE} /w ${PUSH} origin main`, "/session"),
    () => Promise.resolve({ stdout: "/session\n" } as never),
  );
  assert(
    refusedByWords !== undefined && refusedByWords.includes(WORK_TREE),
    "…and the gate still refuses it for the flag, read off the words (#2168 H1)",
  );
  const refusedWithC = ownPushSegment(
    depsOf(`git -C /wt ${WORK_TREE} /w ${PUSH} origin main`, "/session"),
  );
  assert(
    refusedWithC === "/wt",
    "a refused segment that also carries `-C` answers the directory, and is still refused on the flag",
  );
  const stillRefused = await ask(
    depsOf(`git -C /wt ${WORK_TREE} /w ${PUSH} origin main`, "/session"),
    () => Promise.resolve({ stdout: "/wt\n" } as never),
  );
  assert(
    stillRefused !== undefined && stillRefused.includes(WORK_TREE),
    "and the gate refuses it for the flag rather than scanning the `-C` tree (H1)",
  );
  const self = ownPushSegment(depsOf(`git ${PUSH} origin main`, "/session"));
  assert(self === "/session", "a push with no `-C` runs where the scan was pointed");
}

// ── 3. The probe has its own wall clock (MEDIUM).
//
// An executor that never settles is the production shape: `exec` is a
// caller-supplied seam, and the guard's outer clock sits over the WHOLE scan, so
// a probe that ignores its own bound can spend the scan's entire budget before
// the first commit read is even attempted. The probe ending in a refusal inside
// the bound is the whole assertion.
{
  const never: ExecFn = () => new Promise(() => {});
  const started = Date.now();
  const problem = await ask(depsOf(`git ${PUSH} origin main`), never, 200);
  const elapsed = Date.now() - started;
  assert(
    problem !== undefined,
    "a hung repository probe ends as a refusal, never a pass (MEDIUM)",
  );
  assert(
    elapsed < 5_000,
    `and it ends inside its own bound rather than hanging the scan (took ${elapsed}ms)`,
  );
  assert(
    (problem ?? "").includes("could not be read"),
    "and the sentence is the directory-problem sentence, which is what the caller maps a sentinel to",
  );
}

// The probe still answers normally when git answers: an absolute toplevel is a
// repository (no problem), a relative one is a scan under someone else's `.git`
// and is refused.
{
  const ok = await ask(depsOf(`git ${PUSH} origin main`),
    () => Promise.resolve({ stdout: "/w\n" } as never));
  assert(ok === undefined, "an absolute toplevel is a repository, so there is no directory problem");
  const relative = await ask(depsOf(`git ${PUSH} origin main`),
    () => Promise.resolve({ stdout: "sub/dir\n" } as never));
  assert(
    relative !== undefined && relative.includes("not inside a git repository"),
    "a non-absolute answer is still refused as outside a repository",
  );
}

// ── 4. A literal `$` is not an expansion (MEDIUM).
//
// The rule is `containsShellExpansion`, the same predicate the publish scan
// applies to publish text — so a single-quoted `$`, which bash never expands,
// does not refuse the push, while `$VAR` (which bash DOES expand inside double
// quotes and unquoted) still makes the directory unknowable.
{
  const literal = await ask(depsOf(`git ${PUSH} origin main && echo 'the cost was 100$'`),
    () => Promise.resolve({ stdout: "/w\n" } as never));
  assert(
    literal === undefined,
    "a literal single-quoted `$` in the command does not refuse the push as an expansion (MEDIUM)",
  );
  const expanded = await ask(depsOf(`git ${PUSH} origin $BRANCH`),
    () => Promise.resolve({ stdout: "/w\n" } as never));
  assert(
    expanded !== undefined && expanded.includes("shell expansion"),
    "while `$VAR` still makes the repository unknowable and is refused",
  );
}

process.exit(exit);
