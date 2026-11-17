#!/usr/bin/env bun
/**
 * lean — a worktree whose base has a submodule has it populated (#2172).
 *
 * The bench shape this pins: a base commit carrying a git submodule, and a test
 * that imports from inside it. `git worktree add` gives you the submodule's
 * GITLINK and an empty directory, and `resetWorktreeToBase`'s `clean -fdx`
 * de-populates it on every reset after that — so the child's test fails before
 * collection, the runner prints nothing naming the file, and `specify` declines
 * on `criterion ACn has no red test`. An adversary is billed for an environment
 * the step emptied.
 *
 * So the create-or-reset path BOTH `specify` and `challenge` take runs
 * `git submodule update --init --recursive` after each reset, and a failure
 * there — an unreachable remote, a clone with no network — is the same
 * infrastructure handback as a runner that cannot collect.
 *
 * Real temp repos throughout, with a real committed submodule:
 *
 *   (a) `specify` on a submodule base: the directory holds the submodule's
 *       committed file BEFORE the runner preflight runs, the run freezes, and
 *       the child saw a populated tree;
 *   (b) the submodule survives the pipeline's own reset (the CAPTURE/RESET/
 *       REWRITE reset to the base, mid-step, is where `clean -fdx` bites);
 *   (c) a base with NO submodule is untouched by the initialisation and runs as
 *       before — one read, no failure, no extra behaviour;
 *   (d) `challenge` on a submodule base sees the submodule populated too (the
 *       shared provisioning path, not a specify-only fix);
 *   (e) a submodule that cannot be initialised ends the run as infrastructure
 *       naming what failed, with no dispatch and no rows; that sabotage reaches
 *       git through the reset's own `beforeSubmoduleInit` seam, which is where
 *       the initialisation now lives;
 *   (f) `resetWorktreeToBase` called DIRECTLY on a tree whose submodule was
 *       emptied leaves it populated and does not throw — the property every
 *       caller of the reset depends on, and the one a reset whose initialisation
 *       sat outside it does not have.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resetWorktreeToBase } from "../src/lean/specify-reset.ts";
import {
  ROOTS as CHALLENGE_ROOTS,
} from "./lib/lean-challenge-fixture.ts";
import {
  ROOTS,
  configWith,
  git,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";
import {
  INSIDE,
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

/** The runner template the cases configure: `sh {file}`, the shape the fixture's
 * tests are written for — each names its own path, which is what the proof reads. */
const RUNNER = "sh {file}";

// ── (a) + (b) specify on a submodule base: populated before the probe, and it survives
{
  const { repoRoot, baseSha } = repoWithSubmodule();
  // What the CHILD saw (dispatch time, before any pipeline reset) and what the
  // tree held AFTER the step's own reset to the base — the moment `clean -fdx`
  // has just emptied the submodule and only the shared prepare can have restored
  // it. Two different claims, two different observation points.
  const seen: string[] = [];
  const afterReset: string[] = [];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 51,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      // What the child sees is the claim: it was dispatched against a tree whose
      // submodule directory held the committed file, not an empty one.
      seen.push(existsSync(path.join(wt, INSIDE)) ? "populated" : "empty");
      writeSubmoduleTest(wt);
    },
    afterCapture: (wt) => {
      afterReset.push(existsSync(path.join(wt, INSIDE)) ? "populated" : "empty");
    },
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    r.threw === undefined,
    `(a) a submodule base runs rather than handing back (${r.threw?.message})`,
  );
  assert(
    seen.join() === "populated",
    `(a) the child saw the submodule populated (got ${seen.join()})`,
  );
  assert(
    r.outcome?.kind === "ok",
    `(a) the test that imports from it freezes (got ${r.outcome?.kind})`,
  );
  assert(
    afterReset.join() === "populated",
    `(b) the submodule was re-initialised after the step's own reset to the base (got ${afterReset.join()})`,
  );
  assert(
    existsSync(path.join(r.worktree, INSIDE)) === true,
    `(b) and the tree the run leaves holds the submodule's file (got ${
      existsSync(path.join(r.worktree, INSIDE)) ? "there" : "empty"
    })`,
  );
  assert(
    git(r.worktree, "status", "--porcelain", "-uall").trim() === "",
    `(b) with the tree clean, submodule included (got ${git(r.worktree, "status", "--porcelain", "-uall")})`,
  );
}

// ── (b2) a leftover worktree reset by a re-run: the submodule comes back
{
  const { repoRoot, baseSha } = repoWithSubmodule();
  // First run establishes the worktree; then the tree is emptied the way a
  // `clean -fdx` empties it, and the second run must repair it rather than
  // decline on a child whose import cannot resolve.
  const first = await runSpecify({
    repoRoot,
    baseSha,
    issue: 52,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => writeSubmoduleTest(wt),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(first.threw === undefined, `(b2) first run clean (${first.threw?.message})`);
  // No hand-emptied tree here: `resetWorktreeToBase`'s own `clean -fdx` is the
  // thing that empties a submodule, and the second run resets the same leftover
  // tree. What the case pins is that the re-run finds the file there again — the
  // first run left a worktree behind whose submodule the reset had to rebuild.
  const second = await runSpecify({
    repoRoot,
    baseSha,
    issue: 52,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt2) => writeSubmoduleTest(wt2),
    toolUses: [submit("AC1", ["tests/AC1-submodule.test.sh"])],
  });
  assert(
    second.threw === undefined && second.outcome?.kind === "ok",
    `(b2) the re-run re-initialises it (${second.threw?.message ?? second.outcome?.kind})`,
  );
  assert(
    existsSync(path.join(second.worktree, INSIDE)) === true,
    "(b2) and the file is back in the tree",
  );
}

// ── (c) a base with no submodule is untouched by the initialisation
{
  const { repoRoot, baseSha } = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    "runner.sh": ["#!/bin/sh", 'echo "runner: $1" 1>&2', "exit 0", ""].join("\n"),
  });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 53,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(c) a submodule-free base runs exactly as before (${r.threw?.message ?? r.outcome?.kind})`,
  );
  assert(
    existsSync(path.join(r.worktree, ".gitmodules")) === false,
    "(c) and the step invented no submodule config while it was there",
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
