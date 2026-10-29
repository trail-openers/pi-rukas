#!/usr/bin/env bun
/**
 * lean/specify, part 3 of 3 — the RUNTIME hazards around the step: a runner
 * that hangs, and a repository whose hooks would rewrite the freeze. Both are
 * cases where the step used to be able to report something it had not proved.
 *
 *   (t) a test that sleeps past the injected timeout -> THROW. The proof only
 *       counts when a process ran it, and a hang is not a verdict: `runTestFile`
 *       runs the runner in its own process group (`killGroup`), so the timeout
 *       SIGKILLs the whole group and stamps the rejection `killed` +
 *       `timedOutKill`, which classifies as infra. A classifier that missed the
 *       kill would read the non-zero exit plus the file name in the output as a
 *       legitimate RED and freeze a test nobody proved.
 *   (u) a pre-commit hook that rewrites the index -> no effect. `commitTestFiles`
 *       runs `git add` and `git commit` with `core.hooksPath=/dev/null` and
 *       `core.fsmonitor=false`, so the commit holds exactly the captured bytes
 *       and the hash describes them.
 *   (v) a frozen test whose NAME is not ASCII -> freezes and commits. git
 *       C-quotes such a name in a plain `diff --name-only`, so the commit check
 *       must read the raw paths (`-z`) or it refuses a commit it made correctly.
 *
 * The fixture is lib/lean-specify-fixture.ts; the verdict cases (a)-(g) are in
 * test-lean-specify.ts and the child-tamper cases (h)-(s) in
 * test-lean-specify-tamper.ts.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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

// ------------------ (t) a runner that hangs is infra, and the step throws
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 19,
    config: configWith({ test: "sh {file}" }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      // A `sleep 30` outlives the injected timeout and holds stdout open; only
      // a GROUP kill takes it down, which is what stamps the rejection `killed`
      // + `timedOutKill` and makes the classification infra rather than red.
      // The path also echoes the file's own name, so a classifier that missed
      // the kill would read the non-zero exit as a legitimate red.
      writeFileSync(
        path.join(wt, "tests/AC1-sleep.test.sh"),
        ["#!/bin/sh", 'echo "not ok - tests/AC1-sleep.test.sh" 1>&2', "sleep 30", ""].join("\n"),
        { mode: 0o755 },
      );
    },
    toolUses: [submit("AC1", ["tests/AC1-sleep.test.sh"])],
    testLimits: { timeoutMs: 400 },
  });
  // The point of the case: a hang is never a verdict. If the kill were missed,
  // the non-zero exit plus the file name in the output would read as a red and
  // the step would freeze a test nobody proved.
  assert(r.outcome === undefined || r.outcome.kind !== "ok", "(t) the hung run is not ok");
  assert(
    r.threw instanceof SpecifyInfraError,
    `(t) a test that sleeps past the timeout THROWS — got ${
      r.threw === undefined ? `outcome ${r.outcome?.kind}` : r.threw.constructor.name
    }`,
  );
  assert(
    r.threw === undefined || /killed or timed out/.test(r.threw.message),
    `(t) the throw says the runner timed out (got ${r.threw?.message})`,
  );
}

// ------------------- (u) a pre-commit hook cannot rewrite the freeze
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  // A hook that would quietly rewrite the index: it stages a file the step
  // never captured and rewrites the test's content. `commitTestFiles` runs add
  // and commit with core.hooksPath=/dev/null, so the commit holds exactly the
  // captured bytes and the hook's work never reaches the branch.
  const hooks = path.join(repoRoot, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(
    path.join(hooks, "pre-commit"),
    [
      "#!/bin/sh",
      "echo 'INJECTED BY THE HOOK' >> \"$PWD/tests/AC1-hook.test.sh\"",
      "echo 'hook noise' > \"$PWD/HOOK-ADDED.md\"",
      "git add -A",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const submitted = redScript();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 20,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-hook.test.sh"), submitted, { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["tests/AC1-hook.test.sh"])],
  });
  assert(r.threw === undefined, `(u) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(u) ok, got ${r.outcome?.kind}`);
  assert(
    git(r.worktree, "show", "--name-only", "--format=", "HEAD") === "tests/AC1-hook.test.sh",
    `(u) the commit holds exactly the captured test (got ${git(r.worktree, "show", "--name-only", "--format=", "HEAD")})`,
  );
  assert(
    `${git(r.worktree, "show", "HEAD:tests/AC1-hook.test.sh")}\n` === submitted,
    "(u) the committed bytes are the captured bytes, not the hook's edit",
  );
  assert(
    r.outcome?.frozen?.["tests/AC1-hook.test.sh"] === sha(submitted),
    "(u) and so is the hash",
  );
  assert(
    !existsSync(path.join(r.worktree, "HOOK-ADDED.md")),
    "(u) the file the hook staged is not in the tree or the commit",
  );
}
// ------------------- (v) a frozen test with a non-ASCII name still commits
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  // é is two bytes, the CJK character three, the emoji four: every class of
  // byte git would quote if the commit check did not read the raw paths.
  const name = "tests/AC1-café-測試-🚀.test.sh";
  const body = redScript();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 21,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, name), body, { mode: 0o755 });
    },
    toolUses: [submit("AC1", [name])],
  });
  assert(r.threw === undefined, `(v) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(v) ok, got ${r.outcome?.kind}`);
  assert(
    r.outcome?.frozen?.[name] === sha(body),
    `(v) the frozen record names the non-ASCII file with its hash (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    git(r.worktree, "-c", "core.quotePath=off", "show", "--name-only", "--format=", "HEAD") ===
      name,
    "(v) the commit holds exactly that file, under its raw name",
  );
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
