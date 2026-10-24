/**
 * forge-pr-merge-seam.ts — the `prMerge` arm of the forge text seam (#1788,
 * round 2), extracted from `test-public-hygiene-guard.ts` for the §12 size cap.
 *
 * A squash merge publishes the subject it is handed as the commit message on
 * main, so it is a public text surface exactly like a PR title or body — and
 * the merge is the one forge write a cycle cannot undo. The three assertions
 * here are the three ways that seam can be wrong: it refuses everything (so
 * the merge never happens), it refuses nothing (so the subject ships with the
 * private term), or it checks AFTER the command (so the merge lands and the
 * refusal arrives too late). The `execed` counter is what separates them: the
 * dirty case must exec nothing and the clean cases must exec the merge.
 */

import type { createForge } from "../src/forge.ts";
import { assert } from "./merge-guard-helpers.ts";

const DETECTION = {
  forge: "github",
  host: "github.com",
  url: "https://github.com/example-owner/example-repo.git",
  source: "remote",
} as const;

/** Drive the forge adapter's `prMerge` with a recording fake executor. */
export async function forgePrMergeSeam(
  term: string,
  cwd: string,
  build: typeof createForge,
): Promise<void> {
  const execed: string[] = [];
  const forge = build(DETECTION as never, {
    execFn: (async (cmd: string, _opts?: unknown) => {
      execed.push(cmd);
      return { stdout: "Merged", exitCode: 0 };
    }) as never,
    cwd,
  });
  let thrown: unknown;
  try {
    await forge.prMerge(7, "squash", `feat(x): wire ${term} into the build`);
  } catch (err) {
    thrown = err;
  }
  assert(thrown !== undefined, "a dirty squash subject is refused at the forge seam");
  assert(
    (thrown as Error)?.name === "PublicHygieneError",
    "as the hygiene error the driver's error paths already recognise",
  );
  assert(
    !String((thrown as Error)?.message ?? "").includes(term),
    "and its refusal carries no term",
  );
  assert(execed.length === 0, "nothing was execed: the merge did not happen");
  // A clean subject reaches the exec, and no subject at all (gh composes one
  // from the PR) is nobody's business to refuse.
  execed.length = 0;
  await forge.prMerge(7, "squash", "feat(x): wire the build");
  assert(
    execed.length === 1 && execed[0]?.includes("gh pr merge 7"),
    "a clean subject reaches the merge command",
  );
  execed.length = 0;
  await forge.prMerge(7);
  assert(execed.length === 1, "no subject at all is not refused — gh composes one");
}
