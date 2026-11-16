#!/usr/bin/env bun
/**
 * lean — the submodule transport licence rides on ONE call, and no call recurses (#2319).
 *
 * `protocol.file.allow=always` used to sit on the production
 * `git submodule update --init --recursive` for every submodule in the tree. That was a real
 * exposure and not a convenience: at any depth, a `file` URL in a SUBMODULE's own
 * `.gitmodules` — content fetched from wherever the first remote points, not content this
 * project reviewed — could clone any repository already on the host into the tree the run
 * then tests and commits.
 *
 * So the rule is not "the licence may never exist": the seeding arm needs it to read the
 * operator's OWN module store. It is three things at once — the licence appears on exactly
 * one call per population of a tree; that call populates ONE submodule, addressed with `--`;
 * and `--recursive` appears nowhere, so no level below the one the step named is ever
 * fetched and a hostile deeper `.gitmodules` has nothing to authorise.
 *
 * The fixture needs the allowance too, for its LOCAL-PATH remotes, and gets it through its
 * own git environment (`GIT_CONFIG_COUNT`/`KEY`/`VALUE`) — env, not argv, so it cannot be
 * mistaken for a licence the step granted itself. That distinction is why the last assertion
 * checks the submodule really was populated: with no allowance anywhere the run would be
 * about a handback rather than about the argv.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { configWith, makeRepo, runSpecify, submit } from "./lib/lean-specify-fixture.ts";
import {
  INSIDE,
  SUB,
  repoWithSubmodule,
  writeSubmoduleTest,
} from "./lib/lean-specify-submodule-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The runner template the cases configure: `sh {file}`, the shape the fixture's tests are. */
const RUNNER = "sh {file}";

{
  const remote = makeRepo({ lib: "the submodule's own content\n" });
  const { repoRoot, baseSha } = repoWithSubmodule(undefined, remote.repoRoot);
  const gitArgvs: string[][] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 57,
    config: configWith({ fast: "true", test: RUNNER }),
    gitArgvs,
    writes: (wt) => writeSubmoduleTest(wt),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `the run populates its submodule under git's own policy (${r.threw?.message ?? r.outcome?.kind})`,
  );
  const submoduleCalls = gitArgvs.filter((argv) => argv.includes("submodule"));
  assert(
    submoduleCalls.length > 0,
    `the step did issue its submodule command (got ${String(submoduleCalls.length)})`,
  );
  // Counted PER RESET, because the same command legitimately recurs across a run: the step's
  // preparation resets the tree, and `verify`/the freeze check reset it again, each with its
  // own populating call. A blanket "exactly one argv anywhere" would refuse the step for doing
  // its job twice, so the rule is stated where it belongs — one licensed call per population
  // of one tree — and the licence is what the assertion cares about: which single command of
  // that reset carries it.
  const licensed = submoduleCalls.filter((argv) =>
    argv.some((a) => a.includes("protocol.file.allow") || a.includes("protocol.allow")),
  );
  const resets = gitArgvs.filter((argv) => argv.includes("clean") && argv.includes("-fdx")).length;
  assert(
    licensed.length > 0 &&
      licensed.length === resets &&
      licensed.every(
        (a) =>
          a.includes("submodule") &&
          a.includes("update") &&
          a.includes("--") &&
          a.includes(SUB) &&
          !a.includes("--recursive"),
      ),
    `exactly one submodule command per tree reset carries a transport allowance, and every one of them is the per-path populating call (got ${JSON.stringify(licensed)} over ${String(resets)} reset(s))`,
  );
  assert(
    gitArgvs.every((argv) => !argv.includes("--recursive")) === true,
    `and NO command of the step's recurses, so nothing below the named level is ever fetched (got ${JSON.stringify(gitArgvs.filter((a) => a.includes("--recursive")))})`,
  );
  assert(
    existsSync(path.join(r.worktree, INSIDE)) === true,
    "the submodule really was populated, so the fixture's env is what allowed it",
  );
}

if (exit !== 0) {
  console.error("FAILED");
  process.exit(1);
}
console.log("All submodule-licence checks passed.");
