#!/usr/bin/env bun
/**
 * #2212 / R1 — the reset `build`'s fold runs issues no submodule call with the switch at `0`.
 *
 * `build` reaches `resetWorktreeToBase` through `normaliseBuild`, the fold that
 * discards the developer's commits, untracks what it should not have touched, and
 * rewrites only the files it keeps. That reset is where the submodule
 * initialisation lives, so it is where `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` is
 * honoured — and this file is what says the fold still goes through it.
 *
 *   (a) with the switch at `0`, the fold resets the tree over a base whose
 *       submodule source is GONE: no submodule call appears in the git argv the
 *       step issued, the fold still commits the child's file, and the submodule
 *       directory the clean emptied stays empty;
 *   (b) the control, outside the `withEnv`: the same fold throws, naming the
 *       submodule step, and issues the call the off arm never made.
 *
 * The two arms take different routes through the fold on purpose. (a) is the
 * ordinary fold — it has to commit something for the assertion about the commit to
 * mean anything. (b) is a fold whose child committed but whose kept set is empty,
 * so the reset is the LAST thing the step does before it reports; a reset that
 * fails there cannot be forgiven, which is what makes (b) a control and not a
 * restatement of (a).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import {
  INSIDE,
  attachSubmodule,
  makeSubmoduleUnfetchable,
  putIn,
  remoteRepo,
  submoduleCalls,
} from "./lib/lean-submodule-off-fixture.ts";
import { buildFixture, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/**
 * One build round over a base whose submodule has no source left.
 *
 * `keepFile` decides whether the child leaves a file the fold keeps: the off arm
 * needs one (a fold with nothing to commit never reaches the commit the assertion
 * reads), the control arm needs the fold to end AT the reset.
 */
async function drive(
  issue: number,
  opts: { keepFile: boolean },
  onReset: (insideAtDispatch: boolean) => void,
): Promise<{
  threw?: Error;
  outcome?: { kind?: string };
  submoduleArgv: readonly (readonly string[])[];
  committed: string;
  /** Whether the submodule's file exists in the run's tree AFTER the step returned. */
  insideAfter: boolean;
}> {
  const built = buildFixture(issue);
  const remote = remoteRepo("build-off");
  // The gitlink joins the run's BRANCH at `headBefore` — the commit the fold
  // resets to and the commit it commits its kept files on top of — so the reset is
  // the thing that has to put the submodule back, and it is committed where the
  // fold's `reset --hard headBefore` will find it.
  attachSubmodule(built.worktree, remote, "add the vendored submodule");
  const headWithSub = gitHead(built.worktree);
  makeSubmoduleUnfetchable(remote, built.worktree);

  const r = await runBuild({
    issue,
    built: { ...built, headBefore: headWithSub },
    // The child commits its work itself, so `classify` finds a change and the fold
    // reaches its reset.
    // The reset under test is the fold's, and the fold is a step that forgives a
    // great deal: a child that produced nothing ends in `exhausted`, a child that
    // broke the contract ends in `blocked`, and neither route reaches a throw. So
    // the control arm cannot be "a child that changed nothing" — it has to be a
    // round that WOULD have committed, in which the reset is the last claim the
    // step makes before it writes. That is the off arm's own shape: a child that
    // commits a real new file. Both arms run the identical round; the only thing
    // that differs is the switch, which is the property under test.
    child: (wt) => {
      onReset(existsSync(path.join(wt, INSIDE)));
      write(wt, "src/feature.ts", "export const f = 1;\n");
      commit(wt, "build: the child's work");
    },
  });
  return {
    threw: r.threw,
    outcome: r.outcome,
    submoduleArgv: submoduleCalls(r.gitArgvs),
    committed: r.headAfter,
    // Read after the step returned, so it is the OUTCOME of the reset rather than
    // a claim about it: the switch-on arm's call ran and did not put the file back.
    insideAfter: existsSync(path.join(built.worktree, INSIDE)),
  };
}

// The fixture's own git wrapper: the same isolated env and identity its commits
// used, so a head read here agrees with the history the fixture built.
import { git, gitEnvFor } from "./lib/lean-build-fixture.ts";
import { execFileSync } from "node:child_process";
const gitHead = (tree: string): string => git(tree, "rev-parse", "HEAD");
function write(wt: string, rel: string, text: string): void {
  putIn(wt, rel, text);
}
function commit(wt: string, message: string): void {
  // The step treats `git status` against `headBefore` as the child's diff, so the
  // child's file has to be committed the way a real child commits: `add` then
  // `commit`, with the fixture's identity rather than the host's.
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", message);
  void execFileSync;
}

// ── (a) off: the fold commits its file and never asked git about submodules
{
  let ran: Awaited<ReturnType<typeof drive>> | undefined;
  let boom: Error | undefined;
  let sawInside = true;
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    try {
      ran = await drive(911, { keepFile: true }, (inside) => {
        sawInside = inside;
      });
    } catch (err) {
      boom = err as Error;
    }
  });
  assert(boom === undefined, `(a) the off arm ran to completion (${boom?.message ?? "clean"})`);
  assert(
    ran?.threw === undefined,
    `(a) the fold did not throw over a submodule it was never asked to fetch (${ran?.threw?.message?.split("\n")[0] ?? "clean"})`,
  );
  assert(
    (ran?.submoduleArgv.length ?? -1) === 0,
    `(a) and the fold issued no submodule call of any kind (got ${JSON.stringify(ran?.submoduleArgv)})`,
  );
  assert(
    ran?.outcome?.kind === "ok",
    `(a) and the fold still did its job — the child's file was kept and committed (got ${JSON.stringify(ran?.outcome?.kind)})`,
  );
  assert(
    ran !== undefined && ran.committed !== "",
    `(a) and the run's branch moved to a commit the step made (${ran?.committed ?? "no head"})`,
  );
  assert(
    ran?.insideAfter === false,
    `(a) and the submodule the fold's clean emptied stayed empty afterwards (found ${String(ran?.insideAfter)})`,
  );
}

// ── (b) the control: the same fold throws, naming the submodule step
{
  let sawInside = true;
  const on = await drive(912, { keepFile: true }, (inside) => {
    sawInside = inside;
  });
  assert(
    on.threw !== undefined && /submodule/i.test(on.threw.message),
    `(b) the same fold DOES throw with the switch on (${on.threw?.constructor.name}: ${on.threw?.message.split("\n")[0] ?? "no throw"})`,
  );
  assert(
    on.submoduleArgv.length > 0,
    `(b) and it issued the submodule call the off arm never made (got ${JSON.stringify(on.submoduleArgv.map((a) => a.slice(-3)))})`,
  );
  assert(
    on.insideAfter === false,
    `(b) and its recovery FAILED — the tree the fold left still held no submodule (found ${String(on.insideAfter)}), which is what the throw says`,
  );
}

process.exit(exit);
