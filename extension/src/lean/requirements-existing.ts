/**
 * lean/requirements-existing — the two reads the coverage rule judges a
 * `preserved` requirement against, and the record it produces.
 *
 * A `preserved` item names a test file the repository ALREADY has and that must
 * already PASS at the step's head. Neither fact is something the child's word
 * establishes, and neither is something the frozen-test pipeline can answer: it
 * deletes every file that is not red, and it refuses any path that already
 * exists at the base. So the lever asks the two questions itself, next door,
 * against the same commits the step is judged on — never through the pipeline.
 *
 *   - {@link listBaseTestFiles} is the set a preserved item may name at all.
 *     Read from the run's BASE with `git ls-tree`, not from the worktree: the
 *     child has been writing in the worktree, and a file it created is exactly
 *     what this rule must not accept.
 *   - {@link proveExistingTestsGreen} runs each candidate file the way the red
 *     proof runs a submitted one (`runTestFile`, the project's `verify.test`
 *     template) and keeps the ones that exited 0. The run happens in the
 *     worktree at the step's head, which is the tree the change will be made
 *     against.
 *
 * Both reads fail CLOSED to "nothing": an unreadable base tree or a runner that
 * could not start yields an empty set rather than a guessed colour, so the item
 * is recorded uncovered with a reason. A preserved gap is never a refusal, so a
 * failed read costs disclosure and cannot block a run.
 */

import type { ExecFn } from "../worktree.ts";
import type { TestRunLimits } from "./specify-proof.ts";
import { runTestFile } from "./specify-proof.ts";
import { NO_HOOKS } from "./specify-reset.ts";

/** The wall clock on the base-tree listing; a repository read, not a test run. */
const LS_TREE_MS = 30_000;

/** Is this a full 40-hex commit sha? The form `git ls-tree` takes. */
const COMMIT_ID = /^[0-9a-f]{40}$/;

/** How many base files one step will execute. A whole monorepo's suite is not a bound. */
const MAX_PROVED_FILES = 20;

/**
 * Every test file present at `base` — the set a `preserved` requirement may
 * point at, and the only set that answers "did this test exist before the
 * change?". `git ls-tree -r` of the base commit, so the child's writes in the
 * worktree cannot enter it.
 *
 * `undefined` when git would not answer: the caller treats that as "the lever
 * could not see the repository" and records its preserved items uncovered,
 * rather than refusing the run over a git failure.
 */
export async function listBaseTestFiles(
  exec: ExecFn,
  repoRoot: string,
  base: string,
): Promise<ReadonlySet<string> | undefined> {
  if (!COMMIT_ID.test(base)) return undefined;
  try {
    const r = await exec("git", {
      argv: [...NO_HOOKS, "--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", base],
      cwd: repoRoot,
      timeout: LS_TREE_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const files = (r.stdout ?? "")
      .split("\0")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    return new Set(files);
  } catch {
    return undefined;
  }
}

/**
 * Which of `paths` the project's runner reports as passing at the worktree's
 * current head. Only paths in `allowed` are run — the base file set — so a
 * child cannot put a file of its own in front of the runner and have it graded
 * as a pre-existing regression test.
 *
 * A file that was not in the tree when it was reached, and a file the runner
 * could not be started for, are both simply absent from the result: neither is
 * evidence of green, and neither is a verdict about the child's work.
 */
export async function proveExistingTestsGreen(
  exec: Parameters<typeof runTestFile>[0],
  opts: {
    wt: string;
    template: string;
    paths: readonly string[];
    allowed: ReadonlySet<string>;
    limits?: TestRunLimits;
  },
): Promise<ReadonlySet<string>> {
  const green = new Set<string>();
  const runnable = [...new Set(opts.paths)].filter((p) => opts.allowed.has(p));
  for (const file of runnable.slice(0, MAX_PROVED_FILES)) {
    const proof = await runTestFile(exec, {
      wt: opts.wt,
      template: opts.template,
      file,
      ...(opts.limits === undefined ? {} : { limits: opts.limits }),
    });
    if (proof.kind === "green") green.add(file);
  }
  return green;
}
