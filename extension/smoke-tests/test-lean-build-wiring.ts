#!/usr/bin/env bun
/**
 * lean/build — the wiring the step runs under, and the config it refuses to
 * guess at. The step's own behaviour is test-lean-build.ts.
 *
 *   (n) phase1Handlers.build is the real step: a missing worktree throws the
 *       infrastructure error, where the notBuilt stub would answer "done"
 *   (o) a project config that cannot load is infrastructure, thrown before the
 *       developer is dispatched
 */

import { BuildInfraError } from "../src/lean/build-errors.ts";
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
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
