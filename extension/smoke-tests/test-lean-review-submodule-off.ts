#!/usr/bin/env bun
/**
 * #2212 / R1 — the reset the review fix round runs issues no submodule call with the switch at `0`.
 *
 * The fix round is the third caller outside `specify` (the others are `build`'s
 * fold and `challenge`). `integrate()` brings the run's own branch to the fixer's
 * head with `resetWorktreeToBase` — the primitive that owns the submodule
 * initialisation and therefore the one that honours
 * `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` — and then re-provisions. So this is a
 * reset in a place a reader of `specify-reset.ts` cannot see being reached, and a
 * per-caller gate (the shape #2212 replaces) would look identical from here if it
 * were moved back out.
 *
 *   (a) with the switch at `0`, a fix round over a base whose submodule source is
 *       GONE integrates: no submodule call in the git argv the step issued, the
 *       fixer's commit reaches origin, and the gitlink stays empty;
 *   (b) the control, outside the `withEnv`: the same round throws, naming the
 *       submodule step, and issues the call the off arm never made.
 *
 * Both arms run the identical round — one blocking finding, one fixer that commits
 * — because the property under test is the switch and nothing else. `runStep` is
 * the step's own entry, so the reset reached here is the one the step makes, not
 * one this file calls.
 *
 * Real temp repos, real git, stubbed models; no child spawned.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import {
  INSIDE,
  attachSubmodule,
  makeSubmoduleUnfetchable,
  remoteRepo,
  submoduleCalls,
} from "./lib/lean-submodule-off-fixture.ts";
import { put } from "./lib/lean-build-fixture.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  FIXER_ROLE,
  type DispatchSpec,
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
async function drive(tag: string) {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  // The submodule's source is deleted before ANY checkout of it exists — the run's
  // worktree is created first, the gitlink is committed onto the run's branch
  // inside it, and origin is fast-forwarded to that commit. So the superrepo never
  // held `.git/modules/…` for this module: there is no cache for `submodule update
  // --init` to recover from, and the step's own call is the only thing that could
  // put the file back. That is what makes (b) a control rather than a restatement.
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
  const { outcome, threw } = await run(
    ctxFor(repoRoot, baseSha, BRANCH),
    {
      ...inner,
      exec: (cmd, o) => {
        if (cmd === "git" && o?.argv !== undefined) argvs.push([...o.argv]);
        return inner.exec(cmd, o);
      },
    },
  );
  return {
    outcome,
    threw,
    submoduleArgv: submoduleCalls(argvs),
    origin: git(repoRoot, "rev-parse", `origin/${BRANCH}`),
    baseSha,
    // The run's own tree as the step left it: `inside` says whether the
    // integration's reset put the submodule back, which is the half only the
    // on-arm can answer — and it is read after the step returned, so it is the
    // OUTCOME of the call, not a promise about it.
    insideAfter: existsSync(path.join(runWt, INSIDE)),
  };
}

// ── (a) off: the round integrates, pushes, and never asked git about submodules
{
  let ran: Awaited<ReturnType<typeof drive>> | undefined;
  let boom: Error | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    try {
      ran = await drive("off");
    } catch (err) {
      boom = err as Error;
    }
  });
  assert(boom === undefined, `(a) the off arm ran to completion (${boom?.message ?? "clean"})`);
  assert(
    ran?.threw === undefined,
    `(a) the fix round integrated over a submodule it was never asked to fetch (${ran?.threw?.message?.split("\n")[0] ?? "clean"})`,
  );
  assert(
    (ran?.submoduleArgv.length ?? -1) === 0,
    `(a) and the round issued no submodule call of any kind (got ${JSON.stringify(ran?.submoduleArgv)})`,
  );
  assert(
    ran !== undefined && ran.origin !== ran.baseSha,
    `(a) and the fixer's commit still reached origin — the round did its job (origin at ${ran?.origin.slice(0, 12)})`,
  );
  assert(
    ran?.insideAfter === false,
    `(a) and the submodule the integration's clean emptied stayed empty afterwards (found ${String(ran?.insideAfter)})`,
  );
}

// ── (b) the control: the same round throws, naming the submodule step
{
  const on = await drive("on");
  assert(
    on.threw !== undefined && /submodule/i.test(on.threw.message),
    `(b) the same round DOES throw with the switch on (${on.threw?.constructor.name}: ${on.threw?.message.split("\n")[0] ?? "no throw"})`,
  );
  assert(
    on.submoduleArgv.length > 0,
    `(b) and it issued the submodule call the off arm never made (got ${JSON.stringify(on.submoduleArgv.map((a) => a.slice(-3)))})`,
  );
  assert(
    on.insideAfter === false,
    "(b) and its recovery FAILED — the tree the step handed on still held no submodule, which is what the throw says",
  );
}

// The review harness's own temp trees (its origin clones and checkouts); the
// submodule fixture's are removed by git-test-env's process-end hook.
cleanupRoots();
process.exit(failures());
