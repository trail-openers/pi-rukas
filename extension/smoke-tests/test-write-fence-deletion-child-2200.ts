/**
 * #2200, part 2 of the hook's own rows: the paths where the rule reaches a CHILD.
 *
 * Split from `test-write-fence-deletion-2200.ts` at the seam between the rule's
 * verdicts and the registration that delivers them — G4 asks that the companion
 * (`child-guards.ts`, the argv every child loads) carries the ops carve-out through
 * its own registration path, and section F pins that the hook sits above the
 * subagent-mode no-op so a strict/headless child is judged too. Neither row is
 * about which root a command touches; both are about whether the rule is installed
 * where a child actually runs.
 *
 * Run: cd extension && bun smoke-tests/test-write-fence-deletion-child-2200.ts
 */

import { readFileSync } from "node:fs";
import {
  CHILD_TMP_ENV,
  deletionRootsFrom,
  firstDeletionOutside,
  GIT_CLEAN_LOG_TOKEN,
  registerDeletionGuard,
} from "../src/write-fence-deletion.ts";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childGuards from "../src/child-guards.ts";
import { withEnv } from "./lib/env-scope.ts";
import { buildDeletionFixture } from "./lib/write-fence-deletion-fixture.ts";
import {
  assert,
  exit,
  fakePi,
  registerDeletionGuardWith,
  toolCall,
} from "./lib/write-fence-deletion-harness.ts";

const { base, wt, scratch, childTmp, sharedTmp, foreignRun } = buildDeletionFixture("child");

/** The roots a fenced develop child's dispatch gives it; the child works in the worktree. */
const FENCED_ENV = {
  PI_ENSEMBLE_WRITE_ROOT: wt,
  PI_ENSEMBLE_WRITE_REPO: base,
  PI_ENSEMBLE_WRITE_SCRATCH: scratch,
  [CHILD_TMP_ENV]: childTmp,
};
const fenced = deletionRootsFrom(FENCED_ENV, wt);

/** The refusal reason the rule gives this command, or undefined when it runs. */
function refused(command: string, roots = fenced): string | undefined {
  return firstDeletionOutside(command, roots)?.reason;
}

{
  // G4 — the companion is where the rule is registered for a child, so the ops
  // carve-out has to survive the companion's own registration path: an ops child
  // loaded through `childGuards` (the argv every child gets) runs its in-cwd clean.
  // The companion reads its roots from `process.env`, so this row pins the two
  // variables that decide the verdict: the role, and a `TMPDIR` that does not make
  // the fixture's own scratch tree look like a temp root it may not delete in.
  await withEnv(
    { PI_ENSEMBLE_ROLE: "ops", PI_ENSEMBLE_SUBAGENT_MODE: "1", TMPDIR: "/tmp" },
    async () => {
      const fake = fakePi();
      childGuards(fake as unknown as ExtensionAPI);
      const results = await Promise.all(
        (fake.handlers.tool_call ?? []).map((h) =>
          h({ toolName: "bash", input: { command: "rm -rf dist" } }, {}),
        ),
      );
      assert(
        results.every((x) => x === undefined),
        `G: the companion leaves an ops child's in-cwd \`rm -rf dist\` alone (got ${JSON.stringify(results)})`,
      );
    },
  );
}

// ============================================================
// F. Registration canary: above the subagent-mode no-op, beside the fence.
// ============================================================
{
  const src = readFileSync(path.join(import.meta.dirname, "..", "src", "child-guards.ts"), "utf8");
  const deletion = src.indexOf("registerDeletionGuard(failClosedPi(pi))");
  const fence = src.indexOf("registerWriteFence(failClosedPi(pi))");
  const noOp = src.indexOf('if (process.env.PI_ENSEMBLE_SUBAGENT_MODE === "1")');
  assert(deletion !== -1, "F: registerDeletionGuard(failClosedPi(pi)) is called in child-guards");
  assert(fence !== -1 && noOp !== -1, "F: the fence call and the no-op are both present");
  assert(
    deletion !== -1 && deletion < noOp,
    "F: the deletion rule registers ABOVE the PI_ENSEMBLE_SUBAGENT_MODE no-op",
  );
  assert(
    deletion !== -1 && fence !== -1 && Math.abs(deletion - fence) < 600,
    "F: the deletion rule registers beside the write fence",
  );
}
{
  // The behavioural half: under the subagent-mode no-op the companion still
  // carries the hook, so a strict/headless child is judged too.
  await withEnv(
    {
      PI_ENSEMBLE_SUBAGENT_MODE: "1",
      PI_ENSEMBLE_WRITE_ROOT: undefined,
      PI_ENSEMBLE_ROLE: undefined,
    },
    async () => {
      const companion = registerDeletionGuardWith({}, wt);
      const r = await toolCall(companion, `rm -rf ${foreignRun}`);
      assert(
        r?.block === true,
        "F: a strict/headless child's companion still refuses a shared-root delete",
      );
    },
  );
}

// ============================================================
// E. `git clean` (D1): refused outside the roots whatever the git-guard opt-out says.
// ============================================================
{
  assert(
    refused(`git -C ${sharedTmp} clean -fdx`) !== undefined,
    "E: a forcing clean aimed at the shared temp root is refused",
  );
  assert(
    refused(`cd ${sharedTmp} && git clean -fdx`) !== undefined,
    "E: a forcing clean after `cd` into the shared root is refused",
  );
  assert(refused("git clean -n") === undefined, "E: `git clean -n` is a dry run and runs");
  assert(
    refused("git clean --dry-run -f") === undefined,
    "E: `git clean --dry-run -f` is still a dry run",
  );
  assert(refused(`git -C ${wt} clean -fdx`) === undefined, "E: inside the worktree it runs");
  // The git guard's own opt-out is about the child's working tree, so it cannot
  // open the shared root: the refusal stands whatever that switch says.
  const pi = fakePi();
  registerDeletionGuard(pi, {
    env: { ...FENCED_ENV, PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT: "1" },
    cwd: wt,
  });
  const r = await toolCall(pi, `git -C ${sharedTmp} clean -fdx`);
  assert(r?.block === true, "E: PI_ENSEMBLE_ALLOW_DESTRUCTIVE_GIT does not open the shared root");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
