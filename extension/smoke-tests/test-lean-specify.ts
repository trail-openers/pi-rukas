#!/usr/bin/env bun
/**
 * lean/specify, part 1 of 2 — the step's VERDICTS, against a real temp git
 * repository (the fixture is lib/lean-specify-fixture.ts; cases (h)-(o), the
 * worktree-ownership and tamper cases, are in test-lean-specify-tamper.ts).
 *
 * The cases here are the decisions a run can be refused for:
 *   (a) a red test plus a stray non-test edit -> ok, edit discarded, hashes and
 *       commit contents correct;
 *   (b) a test green on base -> no-red-test naming its criterion;
 *   (c) a runner that cannot be STARTED -> THROW (infra, never a verdict);
 *   (d) a submit for an unknown criterion -> dropped, criterion uncovered;
 *   (e) no `verify.test` configured -> no-red-test with the runner rule, and
 *       the adversary never dispatched;
 *   (f) a dirty leftover worktree -> reset to base before the child is asked;
 *   (g) a dispatch that did not succeed -> THROW.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SUBMIT_TESTS_REPORTER_PATH } from "../src/lean/submit-tests-reporter.ts";
import {
  ROOTS,
  RUNNER,
  SpecifyInfraError,
  configWith,
  git,
  makeRepo,
  redScript,
  runSpecify,
  sha,
  submit,
} from "./lib/lean-specify-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------------------------------------- (a) the ok path
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const toolUses = [submit("AC1", ["tests/AC1-retry.test.sh"])];
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 1,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
      // The stray edit the step must discard, and the stray file it must delete.
      writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => { fix(); };\n");
      writeFileSync(path.join(wt, "NOTES.md"), "I also wrote this\n");
    },
    toolUses,
  });
  const wt = r.worktree;
  assert(r.threw === undefined, `(a) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(a) ok, got ${r.outcome?.kind}`);
  assert(r.sawBaseHealthy, "(a) the fast verify tier ran before any red was trusted");
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === "tests/AC1-retry.test.sh",
    `(a) frozen holds exactly the kept test (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    r.outcome?.frozen?.["tests/AC1-retry.test.sh"] === sha(redScript()),
    `(a) frozen carries the file's sha256 (got ${r.outcome?.frozen?.["tests/AC1-retry.test.sh"]})`,
  );
  assert(
    JSON.stringify(r.outcome?.tests) === JSON.stringify({ AC1: ["tests/AC1-retry.test.sh"] }),
    `(a) tests maps the criterion to its file (got ${JSON.stringify(r.outcome?.tests)})`,
  );
  assert(
    git(wt, "status", "--porcelain", "-uall") === "",
    "(a) the stray edit and stray file are gone: the worktree is clean",
  );
  assert(
    git(wt, "show", "HEAD:src/retry.ts") === "export const retry = () => {};",
    "(a) the non-test edit did not survive into the commit",
  );
  assert(
    !existsSync(path.join(wt, "NOTES.md")),
    "(a) the stray untracked file the child wrote is gone",
  );
  assert(
    git(wt, "log", "--format=%s")
      .split("\n")
      .filter((s) => s !== "base").length === 1,
    `(a) exactly one commit above the base (got ${git(wt, "log", "--format=%s").replace(/\n/g, ", ")})`,
  );
  assert(
    git(wt, "show", "--name-only", "--format=", "HEAD") === "tests/AC1-retry.test.sh",
    `(a) the commit contains exactly the test file (got ${git(wt, "show", "--name-only", "--format=", "HEAD").replace(/\n/g, ", ")})`,
  );
  assert(
    git(wt, "log", "--format=%s", "-1").startsWith("test: acceptance tests for #1"),
    `(a) commit subject names the issue (got ${git(wt, "log", "--format=%s", "-1")})`,
  );
  assert(
    git(wt, "rev-parse", "HEAD^") === baseSha,
    "(a) the acceptance-test commit sits directly on the base",
  );
}

// --------------------------------------------- (b) green on base is refused
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 2,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-green.test.sh"), "#!/bin/sh\necho ok\nexit 0\n", {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["tests/AC1-green.test.sh"])],
  });
  assert(r.threw === undefined, "(b) no throw for an unred test — it is a verdict, not infra");
  assert(r.outcome?.kind === "no-red-test", `(b) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.failedRules ?? []).some((x) => x.includes("AC1")),
    `(b) the rule names the uncovered criterion (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("exited 0"),
    `(b) the reason records the green file it dropped (got ${r.outcome?.reason})`,
  );
  assert(
    !existsSync(path.join(r.worktree, "tests", "AC1-green.test.sh")),
    "(b) the green file is deleted from the worktree, not left behind",
  );
}

// ------------------------------------------- (c) a runner that cannot start throws
{
  // The toolchain, not the test: the template names an executable that is not
  // there, so the process never starts — a rejection with a non-numeric `code`
  // and no exit status. That is the ONLY thing per-file proving still throws.
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 3,
    config: configWith({ test: "definitely-not-a-real-runner-binary {file}" }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(c) a runner that could not be started THROWS (infra), not a verdict — got ${
      r.threw === undefined ? `outcome ${r.outcome?.kind}` : r.threw.constructor.name
    }`,
  );
  assert(
    r.threw === undefined || /could not be started/.test(r.threw.message),
    `(c) the throw names the runner, not the test (got ${r.threw?.message})`,
  );
}

// ---------------------------------------------- (d) an unknown criterion is dropped
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 4,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      // A red file — for a criterion the spec does not have.
      writeFileSync(path.join(wt, "tests/AC99-other.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC99", ["tests/AC99-other.test.sh"])],
  });
  assert(r.threw === undefined, "(d) no throw");
  assert(r.outcome?.kind === "no-red-test", `(d) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.failedRules ?? []).some((x) => x.includes("AC1")),
    `(d) AC1 is reported uncovered (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("not a test criterion") ||
      (r.outcome?.reason ?? "").includes("unknown criterion"),
    `(d) the reason says why AC99 was dropped (got ${r.outcome?.reason})`,
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).length === 0,
    "(d) nothing is frozen for an unknown criterion",
  );
}

// ----------------------------- (e) no runner configured: verdict, and no adversary
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 5,
    config: configWith({}),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(r.threw === undefined, "(e) no throw");
  assert(r.outcome?.kind === "no-red-test", `(e) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.failedRules ?? []).some((x) => x.includes("no test runner configured")),
    `(e) the runner rule is named (got ${JSON.stringify(r.outcome?.failedRules)})`,
  );
  assert(r.dispatched === 0, `(e) the adversary was never dispatched (got ${r.dispatched})`);
}

// -------------------------------------------- (f) a dirty leftover worktree is reset
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "tracked\n" });
  const wt = path.join(repoRoot, ".worktrees", "lean-6");
  git(repoRoot, "worktree", "add", "-q", "--detach", wt, baseSha);
  writeFileSync(path.join(wt, "src/a.ts"), "TRAMPLED BY A DEAD CHILD\n");
  mkdirSync(path.join(wt, "junk"), { recursive: true });
  writeFileSync(path.join(wt, "junk/leftover.ts"), "from the crashed run\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 6,
    config: configWith({ test: RUNNER }),
    writes: (wt2) => {
      // The step must have reset the tree BEFORE this child was asked.
      assert(
        git(wt2, "show", "HEAD:src/a.ts") === "tracked",
        "(f) on entry the worktree is back at the base",
      );
      assert(
        !existsSync(path.join(wt2, "junk/leftover.ts")),
        "(f) on entry the dead child's untracked file is gone",
      );
      assert(
        git(wt2, "status", "--porcelain", "-uall") === "",
        "(f) on entry the worktree is clean",
      );
      mkdirSync(path.join(wt2, "tests"), { recursive: true });
      writeFileSync(path.join(wt2, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(r.threw === undefined, `(f) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(f) ok after the reset, got ${r.outcome?.kind}`);
}

// ------------------------------------------------------- (g) a dead dispatch throws
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 7,
    config: configWith({ test: RUNNER }),
    writes: () => {},
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
    dispatchOk: false,
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(g) a dispatch that did not succeed THROWS — got ${
      r.threw === undefined ? `outcome ${r.outcome?.kind}` : r.threw.constructor.name
    }`,
  );
}

// -------------------------------------------------- the reporter path is a real file
assert(existsSync(SUBMIT_TESTS_REPORTER_PATH), "the submit_tests reporter exists on disk");

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
