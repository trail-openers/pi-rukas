#!/usr/bin/env bun
/**
 * lean/build — the wiring the step runs under, and the config it refuses to
 * guess at. The step's own behaviour is test-lean-build.ts.
 *
 *   (n) phase1Handlers.build is the real step: a missing worktree throws the
 *       infrastructure error, where the notBuilt stub would answer "done"
 *   (o) a project config that cannot load is infrastructure, thrown before the
 *       developer is dispatched, and the builder's scope contract reaches the
 *       child verbatim (the "smallest change / no impossible guards / never the
 *       full suite" paragraph the first lean trial showed was missing)
 *   (i2) the third build round, the one a red verify earned, is labelled attempt
 *       3 and carries that red's reason and the challenge's new frozen test
 */

import { BuildInfraError } from "../src/lean/build-errors.ts";
import { BUILD_SCOPE_CONTRACT } from "../src/lean/build-prompt.ts";
import { phase1Handlers } from "../src/lean/command.ts";
import { ROOTS, buildFixture, git, put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------- (n) the phase handlers wire the real build, not the stub
//
// The stub answers `done` with "not built yet"; the real step refuses a missing
// worktree before it does anything else, so the two cannot be confused.
{
  const built = buildFixture(114);
  git(built.repoRoot, "worktree", "remove", "--force", built.worktree);
  const build = phase1Handlers(built.repoRoot, 114).build;
  const settled = build
    ? await build(built.ctx).then(
        (o) => o,
        (err: unknown) => err,
      )
    : "no build handler";
  assert(
    settled instanceof BuildInfraError && settled.message.includes("does not exist"),
    `(n) phase1Handlers.build is the real step (got ${settled instanceof Error ? settled.message : JSON.stringify(settled)})`,
  );
}

// --------------------- (o) a project config that cannot load is infrastructure
{
  const r = await runBuild({
    issue: 115,
    loadConfigError: "config refused: .pi/work.json is not valid JSON",
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 8;\n"),
  });
  assert(
    r.threw instanceof BuildInfraError,
    `(o) the throw is infrastructure (got ${r.threw?.message})`,
  );
  assert(
    (r.threw?.message ?? "").includes("could not load the project config"),
    "(o) the throw names the config",
  );
  assert(r.dispatched === 0, `(o) the developer was never dispatched (got ${r.dispatched})`);

  // The builder's scope contract reaches the child verbatim. The first lean
  // trial's PR was correct but not minimal — a guard for a caller that does
  // not exist, a history-narrating comment, and a full-suite run the verify
  // step pays for again — and the contract is the only thing that tells the
  // child those are out of scope.
  const scoped = await runBuild({
    issue: 116,
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 5;\n"),
  });
  const prompt = scoped.prompts[0] ?? "";
  assert(
    prompt.includes(BUILD_SCOPE_CONTRACT),
    "(o) the prompt carries the shared BUILD_SCOPE_CONTRACT paragraph verbatim",
  );
  assert(
    prompt.includes("smallest change that makes the frozen tests pass"),
    "(o) the prompt tells the builder to make the smallest change that passes",
  );
  assert(
    prompt.includes("callers, inputs or states that cannot occur"),
    "(o) the prompt forbids guards for states that cannot occur",
  );
  assert(
    prompt.includes("Do not run the project's full test suite"),
    "(o) the prompt forbids the full suite because verify runs it",
  );
  assert(
    prompt.includes("never the history of the change"),
    "(o) the prompt forbids history-narrating comments",
  );
}

// ------------- (i2) the third round, earned by the red itself, carries that red
//
// The field case: a challenge added tests, so the round it earned was spent and
// the red that followed found no round left to answer it. `build.ts` derives the
// attempt label and the re-entry reason from the step log, so this pins both
// surviving the third round — the one the cap used to refuse, which ended such a
// run handed back with a two-line fix outstanding.
{
  const reason = "AC1 tests/AC1-retry.test.sh: exited 1 — meta-test: not in the always-run list";
  const r = await runBuild({
    issue: 130,
    extraFrozen: { "tests/AC2-adversary.test.sh": "#!/bin/sh\nexit 1\n" },
    extraSteps: [
      { key: "130:build:0", state: "build", startedAt: 3, outcome: { kind: "ok" } },
      { key: "130:challenge:0", state: "challenge", startedAt: 4, outcome: { kind: "none" } },
      { key: "130:build:1", state: "build", startedAt: 5, outcome: { kind: "ok" } },
      { key: "130:verify:0", state: "verify", startedAt: 6, outcome: { kind: "red", reason } },
      { key: "130:build:2", state: "build", startedAt: 7 },
    ],
    child: (wt) => put(wt, "src/retry.ts", "export const retry = () => 6;\n"),
  });
  const prompt = r.prompts[0] ?? "";
  assert(
    r.threw === undefined && r.outcome?.kind === "ok",
    `(i2) the third round ran: ${r.threw?.message ?? r.outcome?.kind}`,
  );
  assert(
    prompt.includes(reason) && prompt.includes("Why this round exists"),
    "(i2) the third round's prompt carries the red verify's reason verbatim",
  );
  assert(
    prompt.includes("This is attempt 3."),
    `(i2) the prompt labels the round attempt 3 (got ${prompt.match(/This is attempt \d+/)?.[0] ?? "none"})`,
  );
  assert(
    prompt.includes("tests/AC2-adversary.test.sh"),
    "(i2) the challenge's new frozen test is in the third round's contract",
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
