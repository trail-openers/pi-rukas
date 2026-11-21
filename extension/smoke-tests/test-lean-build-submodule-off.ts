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
 * Both arms run the identical round, because the property under test is the switch
 * and nothing else: a child that commits a real new file, so the fold has something
 * to keep (a fold with nothing to commit never reaches the commit the assertion
 * reads) and the reset is the last claim it makes before it reports — a reset that
 * fails there cannot be forgiven, which is what makes (b) a control rather than a
 * restatement of (a).
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { emptyRunningState } from "../src/progress.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { withEnv } from "./lib/env-scope.ts";
import { buildFixture, runBuild } from "./lib/lean-build-fixture.ts";
import { configWithRunner } from "./lib/lean-build-asserts.ts";
import {
  INSIDE,
  SUB,
  attachSubmodule,
  makeSubmoduleUnfetchable,
  moduleStores,
  putIn,
  remoteRepo,
  submoduleCalls,
} from "./lib/lean-submodule-off-fixture.ts";

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
 */
async function drive(
  issue: number,
  // The OUTER gate. `"0"` makes the step ask git to populate nothing at all — which is (a)'s
  // claim, and also why the disclosure cannot be asserted there: with no pass there is nothing
  // to disclose, and the switch's whole contract is that the run looks as if it never had one.
  preflight?: "0",
): Promise<{
  threw?: Error;
  outcome?: { kind?: string; reason?: string };
  submoduleArgv: readonly (readonly string[])[];
  committed: string;
  /** Whether the submodule's file exists in the run's tree AFTER the step returned. */
  insideAfter: boolean;
}> {
  const built = buildFixture(issue);
  const remote = remoteRepo("build-off");
  attachSubmodule(built.worktree, remote, "add the vendored submodule");
  // The commit the fold resets to is the gitlink's own commit — read BEFORE anything is
  // taken away, because `makeSubmoduleUnfetchable` removes the bytes that make the
  // gitlink's tree checkable, and a head read after it would be a head the fixture could
  // not verify. Nothing else here commits, so the branch tip stays this commit and the
  // reset rebuilds a tree that carries the submodule entry.
  const headBefore = gitHead(built.worktree);
  if (headBefore === built.headBefore)
    throw new Error(
      `the build submodule fixture's gitlink commit is not the branch tip the fold resets to (${headBefore})`,
    );
  if (git(built.worktree, "ls-tree", headBefore, SUB).split(" ")[0] !== "160000")
    throw new Error(
      `the build submodule fixture's base holds no gitlink at ${SUB} in ${headBefore} — both arms would test nothing`,
    );
  if (git(built.worktree, "rev-parse", "HEAD") !== headBefore)
    throw new Error(
      `the build submodule fixture read its head from a tree the run does not work in (${headBefore})`,
    );
  // The sabotage, and it has to be complete before the switch's control arm runs: the
  // source deleted, the checkout emptied, and the SUPERPROJECT's own copy of the objects
  // gone too. Any local copy left behind and the seeding arm of #2319 restores the
  // submodule, the fold does not throw, and the control below reads "no throw" as though
  // the step had recovered — the opposite of what this file exists to pin.
  makeSubmoduleUnfetchable(remote, built.worktree);
  // The seeding arm of #2319 looks in the SUPERPROJECT, not the run's worktree: a linked
  // tree's `rev-parse` answers name its own gitdir, and the operator's copy of the
  // objects lives under the superproject's shared store. Deleting only what the worktree
  // names therefore leaves a control that silently seeds, does not throw, and reports "no
  // throw" as though the step had recovered — the precise opposite of what (b) pins. So
  // both trees are swept, and the check is asked of both.
  const swept = new Set([...moduleStores(built.worktree), ...moduleStores(built.repoRoot)]);
  for (const dir of swept) rmSync(path.join(dir, "modules"), { recursive: true, force: true });
  if ([...swept].some((dir) => existsSync(path.join(dir, "modules", "vendor"))))
    throw new Error(
      `the build submodule fixture left a module store behind in ${built.repoRoot} — the control would seed instead of failing`,
    );

  let r: Awaited<ReturnType<typeof runBuild>> | undefined;
  const run = async (): Promise<void> => {
    r = await runBuild({
      issue,
      built: { ...built, headBefore },
      // The child commits its work itself, so `classify` finds a change and the fold
      // reaches its reset. The fold forgives a great deal: a child that produced
      // nothing ends in `exhausted`, a child that broke the contract ends in `blocked`,
      // and neither route reaches a throw — so the control arm cannot be "a child that
      // changed nothing", it has to be a round that WOULD have committed.
      child: (wt) => {
        write(wt, "src/feature.ts", "export const f = 1;\n");
        commit(wt, "build: the child's work");
      },
    });
  };
  await (
    preflight === undefined
      ? run()
      : withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: preflight }, run)
  );
  return {
    threw: r?.threw,
    outcome: r?.outcome,
    submoduleArgv: submoduleCalls(r?.gitArgvs ?? []),
    committed: r?.headAfter ?? "",
    // Read after the step returned, so it is the OUTCOME of the reset rather than
    // a claim about it: the switch-on arm's call ran and did not put the file back.
    insideAfter: existsSync(path.join(built.worktree, INSIDE)),
  };
}

// The fixture's own git wrapper: the same isolated env and identity its commits
// used, so a head read here agrees with the history the fixture built.
import { git } from "./lib/lean-build-fixture.ts";
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
}

// ── (a) off: the fold commits its file and never asked git about submodules
{
  let ran: Awaited<ReturnType<typeof drive>> | undefined;
  let boom: Error | undefined;
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    try {
      ran = await drive(911);
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

// ── (b) the control: the same fold whose reset really did ask git
{
  // (a) is the OUTER switch at `0` — the claim being that the step then issues nothing about
  // submodules. The control has to be the same fold on the arm that DOES ask git, and under the
  // seeding rule an absent submodule is a DISCLOSURE rather than a hand-back, so what separates
  // the two arms is the CALL: the reset asked git about the submodule here and asked it nothing
  // in (a).
  const on = await drive(912);
  assert(
    on.submoduleArgv.length > 0,
    `(b) the same fold DID issue the submodule call the off arm never made (got ${JSON.stringify(on.submoduleArgv.map((a) => a.slice(-3)))})`,
  );
  assert(
    on.insideAfter === false,
    `(b) and the call it issued put nothing back — the tree the fold left still held no submodule (found ${String(on.insideAfter)}), which is what (c)'s disclosure says`,
  );
}

// ── (c) #2319 Resolution 4: the fold says the disclosure in its OWN reason
{
  // The arm that owes it: preflight ON, so a pass actually ran and had something to report, and
  // a missing submodule is a disclosure rather than a hand-back. The
  // fold commits bytes built against a tree with nothing at that path, and the reason line is the
  // only surface a reader judging the commit has — the log is not it. Deleting the
  // `report.submodules ?? ""` entry from the fold's `joinNotes` in `build.ts` turns this red.
  const folded = await drive(913);
  assert(
    folded.threw === undefined && folded.outcome?.kind === "ok",
    `(c) the fold ran over the sabotaged submodule and committed (${folded.threw?.message?.split("\n")[0] ?? `kind ${String(folded.outcome?.kind)}`})`,
  );
  assert(
    folded.outcome?.reason?.includes(SUB) === true &&
      /seeded nothing there/.test(folded.outcome?.reason ?? ""),
    `(c) and the fold's own reason carries the submodule disclosure, not just the trace (reason ${JSON.stringify(folded.outcome?.reason)})`,
  );
}

// ── (d) #2319 Resolution 4: the BUDGET-stopped fold carries it too
{
  // The fold a ceiling stops is a DIFFERENT call site from (c)'s: `foldStoppedBuild` builds its
  // verdict's reason itself rather than through the `ok` arm's `joinNotes`, so a disclosure
  // folded into one can be missing from the other. Same shape as the field bug — the run hands
  // back a budget verdict, and the tree its commit was built on held nothing at that path.
  const BUILD_TURNS = 3;
  const built = buildFixture(914);
  const remote = remoteRepo("build-stopped");
  attachSubmodule(built.worktree, remote, "add the vendored submodule");
  const headBefore = gitHead(built.worktree);
  makeSubmoduleUnfetchable(remote, built.worktree);
  const swept = new Set([...moduleStores(built.worktree), ...moduleStores(built.repoRoot)]);
  for (const dir of swept) rmSync(path.join(dir, "modules"), { recursive: true, force: true });
  let r: Awaited<ReturnType<typeof runBuild>> | undefined;
  r = await runBuild({
    issue: 914,
    built: { ...built, headBefore },
    config: {
      ...configWithRunner(),
      budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
    },
    child: (wt) => {
      write(wt, "src/feature.ts", "export const f = 1;\n");
      commit(wt, "build: the child's work");
    },
    onProgressTick: (onProgress) =>
      onProgress?.({ ...emptyRunningState("developer"), turns: BUILD_TURNS + 1 }),
  });
  const outcome = r?.outcome as { kind?: string; reason?: string } | undefined;
  assert(
    outcome?.kind === "budget",
    `(d) the round stopped at its own ceiling and gave a budget verdict (got ${JSON.stringify(outcome?.kind)}, threw ${r?.threw?.message?.split("\n")[0] ?? "no"})`,
  );
  assert(
    outcome?.reason?.includes(SUB) === true && /seeded nothing there/.test(outcome?.reason ?? ""),
    `(d) and the budget verdict's reason carries the submodule disclosure too (reason ${JSON.stringify(outcome?.reason)})`,
  );
}

process.exit(exit);
