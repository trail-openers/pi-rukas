#!/usr/bin/env bun
/**
 * The reset the review fix round runs asks git to populate the submodules its clean emptied.
 *
 * The fix round is the third caller outside `specify` (the others are `build`'s
 * fold and `challenge`). `integrate()` brings the run's own branch to the fixer's
 * head with `resetWorktreeToBase` — the primitive that owns the submodule
 * initialisation — and then re-provisions. So this is a reset in a place a reader
 * of `specify-reset.ts` cannot see being reached.
 *
 *   (a) the retired `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` is ignored: the round still
 *       issues the submodule call and pushes the fixer's commit;
 *   (b) over a base whose submodule source is GONE the round issues the call, and the
 *       call puts nothing back.
 *
 * Every case runs the identical round — one blocking finding, one fixer that commits.
 * `runStep` is the step's own entry, so the reset reached here is the one the step
 * makes, not one this file calls.
 *
 * Real temp repos, real git, stubbed models; no child spawned.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  type DispatchSpec,
  FIXER_ROLE,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  lensRoundFor,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";
import {
  INSIDE,
  SUB,
  attachSubmodule,
  makeSubmoduleUnfetchable,
  remoteRepo,
  submoduleCalls,
} from "./lib/lean-submodule-off-fixture.ts";

const { assert, failures } = makeAssert();

/**
 * One review round whose integration reset has to recover a submodule that cannot
 * be recovered, on a base carrying a gitlink at `vendor/lib`.
 *
 * The gitlink goes on the run's branch, at the head the gates read: the
 * integration resets the run's tree to the FIXER's head, a descendant of it, so
 * the submodule is in every commit the reset can land on and the step's `clean
 * -fdx` is what empties it.
 */
async function drive(tag: string, preflight?: "0") {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // The submodule's source is deleted before ANY checkout of it exists — the run's
  // worktree is created first, the gitlink is committed onto the run's branch
  // inside it, and origin is fast-forwarded to that commit. So the superrepo never
  // held `.git/modules/…` for this module: there is no cache for `submodule update
  // --init` to recover from, and the step's own call is the only thing that could
  // put the file back.
  const runWt = path.join(repoRoot, ".worktrees", "lean-7");
  const remote = remoteRepo(`review-off-${tag}`);
  attachSubmodule(runWt, remote, "chore: vendor the submodule");
  // Origin must hold what the gates read, submodule and all: the step resolves the
  // head it reviews from origin, and the integration pushes to it.
  git(runWt, "push", "-q", "origin", `refs/heads/${BRANCH}`);
  makeSubmoduleUnfetchable(remote, runWt);

  const argvs: string[][] = [];
  // The submodule is gone BEFORE the step starts and the tree's checkout is
  // emptied by the fixture, so the integration's reset is the first thing that
  // could put it back — which is exactly the call the switch decides.
  const inner = depsWith({
    adversarial: rejectsThenClears("1. silent catch on the retry path"),
    lens: async (a) => lensRoundFor(a, "APPROVED", []),
    dispatch: async (spec: DispatchSpec) => {
      const wt = spec.cwd as string;
      // The FIXER's tree, which the step created from the head that carries the
      // gitlink. What it holds at this instant separates nothing — the dispatch is
      // before the integration's reset, so it is the same on both arms — and the
      // observation that does is `insideAfter`, read after the step returned.
      put(wt, `fix-${tag}.ts`, `export const fix_${tag} = 1;\n`);
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", `fix(${tag}): the wave's fix`);
      return result({ role: FIXER_ROLE });
    },
  });
  let outcome: Awaited<ReturnType<typeof run>>["outcome"] | undefined;
  let threw: Awaited<ReturnType<typeof run>>["threw"];
  const round = async (): Promise<void> => {
    ({ outcome, threw } = await run(ctxFor(repoRoot, baseSha, BRANCH), {
      ...inner,
      exec: (cmd, o) => {
        if (cmd === "git" && o?.argv !== undefined) argvs.push([...o.argv]);
        return inner.exec(cmd, o);
      },
    }));
  };
  // `preflight` is the retired switch, which must read as unset.
  await (
    preflight === undefined
      ? round()
      : withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: preflight }, round)
  );
  return {
    outcome,
    threw,
    submoduleArgv: submoduleCalls(argvs),
    origin: git(repoRoot, "rev-parse", `origin/${BRANCH}`),
    baseSha,
    // The run's own tree as the step left it: `inside` says whether the
    // integration's reset put the submodule back — read after the step returned, so it is the
    // OUTCOME of the call, not a promise about it.
    insideAfter: existsSync(path.join(runWt, INSIDE)),
  };
}

// ── (a) the retired switch at "0" is ignored
{
  const zero = await drive("zero", "0");
  assert(
    zero.submoduleArgv.length > 0 && zero.threw === undefined && zero.origin !== zero.baseSha,
    `(a) "0" still issues the submodule call and pushes (got ${JSON.stringify(zero.submoduleArgv.map((a) => a.slice(-3)))}, ${zero.threw?.message?.split("\n")[0] ?? "clean"})`,
  );
}

// ── (b) the round's reset asks git
{
  // A sabotaged submodule with no local copy is a disclosure rather than a failure, so what is
  // pinned is the CALL the reset issued and what it proved, not whether the round survived.
  const on = await drive("on");
  assert(
    on.submoduleArgv.length > 0,
    `(b) the round issued the submodule call (got ${JSON.stringify(on.submoduleArgv.map((a) => a.slice(-3)))})`,
  );
  assert(
    on.insideAfter === false,
    "(b) and the call it made put nothing back — the tree the step handed on still held no submodule, which is what (c)'s disclosure says",
  );
}

// ── (c) #2319 Resolution 4: the fix round says the disclosure in the step's OWN reason
{
  // A pass ran and had something to report. A fix
  // integrated from a tree whose submodule was never populated is a fix nobody can re-run, and
  // the reason the caller composes is what lands on the run record, the PR and the handoff — the
  // surfaces an operator who never opens the log sees. Deleting the `submodules` field from
  // `fixRound`'s return in `review-git.ts`, or the `fixDisclosure` fold in `review.ts`, turns
  // this red.
  const folded = await drive("fold");
  assert(
    folded.threw === undefined && folded.origin !== folded.baseSha,
    `(c) the round integrated and pushed over the sabotaged submodule (${folded.threw?.message?.split("\n")[0] ?? `origin ${folded.origin.slice(0, 12)}`})`,
  );
  assert(
    (folded.outcome as { reason?: string } | undefined)?.reason?.includes(SUB) === true &&
      /seeded nothing there/.test(
        (folded.outcome as { reason?: string } | undefined)?.reason ?? "",
      ),
    `(c) and the step's own reason carries the submodule disclosure, not just the trace (reason ${JSON.stringify((folded.outcome as { reason?: string } | undefined)?.reason)})`,
  );
}

// The review harness's own temp trees (its origin clones and checkouts); the
// submodule fixture's are removed by git-test-env's process-end hook.
cleanupRoots();
process.exit(failures());
