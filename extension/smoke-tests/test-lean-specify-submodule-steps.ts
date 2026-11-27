#!/usr/bin/env bun
/**
 * lean — the two submodule cases that drive a whole step, split out of
 * `test-lean-specify-submodule.ts` when that file passed the size gate. Same harness, same
 * fixtures, same assertions; the seam is that both drive a full step (challenge's round, and
 * the runner-prelight switch read off the argv a specify run issued) rather than the reset.
 *
 *   (d) a submodule the run's OWN worktree added is refused rather than seeded from itself;
 *   (g) with `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` the step issues no submodule call at all.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { withEnv } from "./lib/env-scope.ts";
import {
  ROOTS as CHALLENGE_ROOTS,
  challengeFixture,
  put,
  redEdge,
  runChallenge,
} from "./lib/lean-challenge-fixture.ts";
import {
  ROOTS,
  configWith,
  git,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";
import {
  INSIDE,
  SUB,
  addSubmodule,
  repoWithSubmodule,
  submoduleRemote,
  writeSubmoduleTest,
} from "./lib/lean-specify-submodule-fixture.ts";
import { submoduleCalls } from "./lib/lean-submodule-off-fixture.ts";
import { SpecifyInfraError } from "../src/lean/specify-reset.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The runner template the cases configure: `sh {file}`, the shape the fixture's
 * tests are written for — each names its own path, which is what the proof reads. */
const RUNNER = "sh {file}";

// ── (d) a submodule the run's OWN worktree added is refused, not seeded from itself
{
  const issue = 54;
  const built = challengeFixture(issue);
  const remote = submoduleRemote();
  // The submodule joins the run's BRANCH, which is the commit `challenge` resets to and proves
  // red against. `submodule add` was run INSIDE the run's worktree, so git filed its store at
  // `.git/worktrees/lean-54/modules/vendor/lib` and the superproject holds neither a `.gitmodules`
  // section, nor a shared store, nor a checkout (each confirmed by `probe-d2.ts`).
  //
  // Resolution 2 is what decides the outcome: "First-level submodules are seeded from the
  // SUPERPROJECT's own module store or its populated checkout path." None of the three exists
  // here, so there is nothing to seed from, and Resolution 3's "otherwise it is absent and
  // disclosed by path" governs the shape of the answer. Absent-and-disclosed is not available
  // either, because `clean -fdx` does not recurse into a submodule git has no shared record of:
  // the run's own files stand at the path, and calling that "the base's verify ran without it"
  // would be the lie the disclosure exists to prevent. So the step refuses, naming the path and
  // the two repairs — the whole claim being that bytes whose only source is the tree under test
  // cannot carry a verdict.
  addSubmodule(built.worktree, remote.repoRoot, SUB);
  git(built.worktree, "commit", "-q", "-m", "add the vendored submodule");
  const r = await runChallenge({
    issue,
    built,
    child: (tree) => {
      put(tree, "tests/AC1-submodule.test.sh", redEdge("tests/AC1-submodule.test.sh"), 0o755);
      // The tree the adversary is handed is still the one it would attack, so this is not a
      // claim that the round was skipped — it is the record that the tree the child saw was
      // NOT made whole, which is what the handback below exists to say out loud.
      assert(
        existsSync(path.join(tree, INSIDE)),
        `(d) the child's tree was left holding the run's own submodule bytes (nothing seeded it) in ${tree}`,
      );
    },
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(d) the round hands back rather than judging a tree whose submodule came from itself (got ${r.threw?.name ?? `no throw: ${r.outcome?.kind}`})`,
  );
  assert(
    r.threw?.message.includes(SUB) === true,
    `(d) and the handback names the path it could not source (got ${r.threw?.message?.slice(0, 160)})`,
  );
  assert(
    r.threw?.message.includes("this run's own worktree") === true,
    `(d) and says where the submodule came from, which is the only repair an operator can act on (got ${r.threw?.message?.slice(0, 200)})`,
  );
  assert(
    r.outcome === undefined,
    `(d) and no verdict is reported for a tree nobody could source (got ${r.outcome?.kind})`,
  );
}

// ── (g) with `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` the step issues NO submodule call
{
  // R1's per-path half for `specify` itself. The switch is honoured inside
  // `resetWorktreeToBase`, so what is asserted is the absence of the call from the
  // argv the STEP issued — not a directory being empty, which a base with no
  // submodule would show too. Every case that drives this same shape with the switch
  // unset asserts the submodule IS populated, so the argv is the only thing moved.
  const { repoRoot, baseSha } = repoWithSubmodule();
  const gitArgvs: string[][] = [];
  const seen: string[] = [];
  let threw: Error | undefined;
  let outcomeKind: string | undefined;
  let worktree = "";
  await withEnv({ PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT: "0" }, async () => {
    try {
      const r = await runSpecify({
        repoRoot,
        baseSha,
        issue: 61,
        config: configWith({ fast: "true", test: RUNNER }),
        gitArgvs,
        writes: (wt) => {
          seen.push(existsSync(path.join(wt, INSIDE)) ? "populated" : "empty");
          writeSubmoduleTest(wt);
        },
        toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
      });
      outcomeKind = r.outcome?.kind;
      worktree = r.worktree;
    } catch (err) {
      threw = err as Error;
    }
  });
  assert(
    threw === undefined,
    `(g) the switch-off run does not hand back on the submodule (${threw ? `${threw.name}: ${threw.message.split("\n")[0]}` : "clean"})`,
  );
  // The argv this case reads for the switch-off arm is argv from which the release
  // issued NOTHING about submodules. The local arm's silent read of the tree
  // (`submodule status`) is not that: it asks git what the tree holds, fetches nothing,
  // and exists to disclose what the step could not supply. Excluding it is the
  // difference between "the step did not ask git to populate anything" — the claim —
  // and "the step never mentioned submodules", which the disclosure now deliberately
  // breaks. The other assertions in this case are what pin the claim: `seen` is the
  // child's own look at the tree and must read `empty`, and the run must still reach a
  // verdict, so a status call that silently populated the tree could not pass them.
  const fetchShaped = submoduleCalls(gitArgvs).filter((argv) => !argv.includes("status"));
  assert(
    fetchShaped.length === 0,
    `(g) the step issued no submodule call of any kind (got ${JSON.stringify(
      fetchShaped.map((a) => a.slice(-3)),
    )})`,
  );
  assert(
    seen.join() === "empty",
    `(g) and the child worked in the tree v0.14.71 left it — the gitlink stayed empty (got ${seen.join()})`,
  );
  assert(
    existsSync(path.join(worktree, INSIDE)) === false,
    `(g) and the tree the run left holds no submodule file (got ${
      existsSync(path.join(worktree, INSIDE)) ? "there" : "empty"
    })`,
  );
  assert(
    outcomeKind !== undefined,
    `(g) and the step still reached a verdict rather than infrastructure (got ${String(outcomeKind)})`,
  );
}

for (const dir of [...ROOTS, ...CHALLENGE_ROOTS]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
