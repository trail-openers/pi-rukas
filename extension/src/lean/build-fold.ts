/**
 * lean/build-fold — the account a budget-stopped builder leaves: fold its work into the attempt's commit, then
 * say which frozen files are still red on the tree that commit made. The sweep reads each file out of HEAD,
 * because the tree is whatever the killed child left.
 */
import { blobAt } from "./build-git.ts";
import { normaliseBuild } from "./build-normalise.ts";
import type { BuildExec, NormaliseReport } from "./build-types.ts";
import { CaptureBudget } from "./specify-capture.ts";
import { TEST_TIMEOUT_MS, sha256 } from "./specify-proof.ts";
import { LoopBudget, runFrozen } from "./build-blocked.ts";

export async function foldStoppedBuild(opts: {
  exec: BuildExec;
  wt: string;
  repoRoot: string;
  branch: string;
  headBefore: string;
  frozen: Record<string, string>;
  attempt: number;
  issue: number;
  template: string | undefined;
  ceiling?: number;
  /** The project's configured protected globs, from the run's base-commit config — the
   *  same list `build`'s own fold gets, so one arm of this step cannot keep what the other
   *  reverts. */
  protected?: readonly string[];
  /** Bounds the whole sweep of frozen tests; a test shortens it to watch a hang. */
  timeoutMs?: number;
}): Promise<{ kept: NormaliseReport; failing: string[] }> {
  const { exec, wt, frozen, template } = opts;
  // `protected` rides the spread into `normaliseBuild` untouched.
  const kept = await normaliseBuild({ ...opts, budget: new CaptureBudget(opts.ceiling) });
  // Only a runner that ANSWERED counts, and only bytes the freeze hashed — the tree is whatever the killed
  // child left, so each file comes out of HEAD.
  const failing: string[] = [];
  if (!template?.trim()) return { kept, failing };
  const budget = new LoopBudget(opts.timeoutMs ?? TEST_TIMEOUT_MS);
  try {
    for (const file of Object.keys(frozen)) {
      // ONE budget for the sweep: once spent, no later file starts at all.
      if (budget.over()) break;
      const bytes = await blobAt(exec, wt, "HEAD", file);
      if (bytes === undefined || bytes.length === 0 || sha256(bytes) !== frozen[file]) continue;
      if ((await runFrozen(exec, { wt, template, file }, budget)).kind === "red")
        failing.push(file);
    }
  } finally {
    budget.dispose();
  }
  return { kept, failing };
}

