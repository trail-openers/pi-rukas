#!/usr/bin/env bun
/**
 * lean — the two submodule cases that drive a whole step, split out of
 * `test-lean-specify-submodule.ts` when that file passed the size gate. Same harness, same
 * fixtures, same assertions; the seam is that it drives a full step (challenge's round) rather
 * than the reset.
 *
 *   (d) a submodule the run's OWN worktree added is refused rather than seeded from itself.
 */

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  ROOTS as CHALLENGE_ROOTS,
  challengeFixture,
  put,
  redEdge,
  runChallenge,
} from "./lib/lean-challenge-fixture.ts";
import {
  ROOTS,
  SpecifyInfraError,
  git,
  submit,
} from "./lib/lean-specify-fixture.ts";
import {
  INSIDE,
  SUB,
  addSubmodule,
  submoduleRemote,
} from "./lib/lean-specify-submodule-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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

for (const dir of [...ROOTS, ...CHALLENGE_ROOTS]) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
