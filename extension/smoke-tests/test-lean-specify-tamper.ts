#!/usr/bin/env bun
/**
 * lean/specify, part 2 — what a hostile or careless CHILD cannot get away
 * with, against a real temp git repository (fixture:
 * lib/lean-specify-fixture.ts; the verdict cases (a)-(g) are in
 * test-lean-specify.ts; the capture-window cases (p)-(q) are in
 * test-lean-specify-capture.ts; the runtime hazards (t)-(u) are in
 * test-lean-specify-runtime.ts; the rewrite-without-links case is in
 * test-lean-specify-rewrite.ts; the reset/re-provision case is in
 * test-lean-specify-provision.ts).
 *
 * Every case here is a way the step used to be fooled, reproduced:
 *   (h) a HARD LINK to a file outside the worktree -> dropped, never committed;
 *   (i) a symlink -> dropped;
 *   (j) a child that commits its own test plus a stray edit -> one driver
 *       commit on base carrying exactly the test;
 *   (k) a child that adds a .gitignore hiding a stray file -> both gone;
 *   (l) a TDD red that says `Cannot find module` -> red, not infra;
 *   (m) a child that rewrites a test after declaring it -> the captured bytes
 *       are what got committed and hashed;
 *   (n) a foreign directory at the lean worktree path -> THROW, content intact;
 *   (o) shell-shaped or placeholder-less runner templates -> refused by config;
 *   (p) a hard link swapped in AFTER validation -> dropped, never committed;
 *   (q) a symlink swapped in after validation -> dropped, never committed;
 *   (r) a parent link that would carry a test's bytes outside the tree -> the
 *       row is refused and nothing outside the worktree is written by the step;
 */

import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { TEST_RUNNER_PLACEHOLDER, validateTestRunner } from "../src/lean/config.ts";
import { captureTestBytes } from "../src/lean/specify-capture.ts";
import { renderTestCommand } from "../src/lean/specify-proof.ts";
import {
  ROOTS,
  RUNNER,
  SpecifyInfraError,
  configWith,
  git,
  makeRepo,
  outsideDir,
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

// ------------------------------------- (h) a hard link outside the worktree is dropped
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  // A file OUTSIDE the worktree, whose bytes the step must never capture, hash
  // or commit. A hard link is invisible to the path checks: `lstat` sees an
  // ordinary file and `realpath` stays inside the tree, because a hard link is
  // not a link — it is the same inode under another name.
  const outside = outsideDir();
  const secret = path.join(outside, "somebody-elses.ts");
  writeFileSync(secret, "SECRET OUTSIDE BYTES\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 8,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      linkSync(secret, path.join(wt, "tests/AC1-hardlink.test.sh"));
    },
    toolUses: [submit("AC1", ["tests/AC1-hardlink.test.sh"])],
  });
  assert(r.threw === undefined, `(h) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "no-red-test", `(h) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.reason ?? "").includes("hard link"),
    `(h) the reason says why: a hard link (got ${r.outcome?.reason})`,
  );
  assert(
    r.outcome?.frozen === undefined || Object.keys(r.outcome.frozen).length === 0,
    "(h) nothing is frozen from a hard link",
  );
  assert(
    git(r.worktree, "rev-parse", "HEAD") === baseSha,
    "(h) nothing was committed on top of the base",
  );
  assert(existsSync(secret), "(h) the outside file is untouched");
}

// ------------------------------------------------------- (i) a symlink is dropped
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const outside = outsideDir();
  const target = path.join(outside, "elsewhere.ts");
  writeFileSync(target, "#!/bin/sh\nexit 1\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 9,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      symlinkSync(target, path.join(wt, "tests/AC1-symlink.test.sh"));
    },
    toolUses: [submit("AC1", ["tests/AC1-symlink.test.sh"])],
  });
  assert(r.threw === undefined, `(i) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "no-red-test", `(i) no-red-test, got ${r.outcome?.kind}`);
  assert(
    (r.outcome?.reason ?? "").includes("symlink"),
    `(i) the reason says why: a symlink (got ${r.outcome?.reason})`,
  );
  assert(
    git(r.worktree, "rev-parse", "HEAD") === baseSha,
    "(i) nothing was committed on top of the base",
  );
}

// ------------------------ (j) a child that commits its own work cannot hide its edit
{
  const { repoRoot, baseSha } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 10,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
      writeFileSync(path.join(wt, "src/retry.ts"), "export const retry = () => { fix(); };\n");
      // The child commits BOTH — the bug this case pins: the old per-path
      // revert restored from HEAD, which is now the child's own commit, so the
      // stray fix survived and the step still reported ok.
      git(wt, "add", "-A");
      git(wt, "commit", "-q", "-m", "child: my own commit");
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(r.threw === undefined, `(j) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(j) ok, got ${r.outcome?.kind}`);
  const subjects = git(r.worktree, "log", "--format=%s").split("\n");
  assert(
    subjects.length === 2 && (subjects[0] ?? "").startsWith("test: acceptance tests for #10"),
    `(j) one driver commit on top of base, the child's commit gone (got ${subjects.join(" | ")})`,
  );
  assert(
    git(r.worktree, "rev-parse", "HEAD^") === baseSha,
    "(j) the driver commit sits directly on the base — no child commit underneath",
  );
  assert(
    git(r.worktree, "show", "--name-only", "--format=", "HEAD") === "tests/AC1-retry.test.sh",
    `(j) the commit holds exactly the test (got ${git(r.worktree, "show", "--name-only", "--format=", "HEAD")})`,
  );
  assert(
    git(r.worktree, "show", "HEAD:src/retry.ts") === "export const retry = () => {};",
    "(j) the stray source edit is gone from the committed tree",
  );
}

// ------------------------ (k) a .gitignore cannot hide a stray file through the reset
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 11,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), redScript(), { mode: 0o755 });
      // An ignore rule the child adds so `git status` never mentions its stray
      // file — the reason the reset cleans with `-x`, not just `-fd`.
      writeFileSync(path.join(wt, ".gitignore"), "hidden-from-status.ts\n*.log\n");
      writeFileSync(path.join(wt, "hidden-from-status.ts"), "sneaky\n");
      writeFileSync(path.join(wt, "build.log"), "noise\n");
    },
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(r.threw === undefined, `(k) no throw: ${r.threw?.message ?? "clean"}`);
  assert(r.outcome?.kind === "ok", `(k) ok, got ${r.outcome?.kind}`);
  assert(
    !existsSync(path.join(r.worktree, "hidden-from-status.ts")),
    "(k) the ignored stray file is gone after the reset",
  );
  assert(!existsSync(path.join(r.worktree, ".gitignore")), "(k) the child's .gitignore is gone");
  assert(!existsSync(path.join(r.worktree, "build.log")), "(k) the other ignored file is gone");
  assert(
    git(r.worktree, "status", "--porcelain", "-uall") === "",
    "(k) and the worktree is clean afterwards",
  );
}

// ------------------------ (l) the canonical TDD red is a red, not an infra fault
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  // The shape the old per-test classifier destroyed: a test that imports a
  // module the implementation has not written yet prints `Cannot find module`,
  // which used to throw the WHOLE run on an env-fault reading. Base health is
  // what proves the toolchain; this output is the test's own failure.
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 12,
    config: configWith({ fast: "true", test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      writeFileSync(
        path.join(wt, "tests/AC1-tdd.test.sh"),
        [
          "#!/bin/sh",
          "echo \"Error: Cannot find module './not-yet' from 'tests/AC1-tdd.test.sh'\" 1>&2",
          'echo "  at node_modules/internal/loader.js" 1>&2',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    },
    toolUses: [submit("AC1", ["tests/AC1-tdd.test.sh"])],
  });
  assert(
    r.threw === undefined,
    `(l) a TDD red that names node_modules and a missing module is NOT infra — got ${r.threw?.message}`,
  );
  assert(r.outcome?.kind === "ok", `(l) ok, the red was kept (got ${r.outcome?.kind})`);
  assert(r.outcome?.frozen?.["tests/AC1-tdd.test.sh"] !== undefined, "(l) the red file is frozen");
}

// ------------------------ (m) rewriting a test after declaring it changes nothing
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  // The child's first version fails for the behaviour the criterion states and
  // names its own file; the rewrite makes it green. Proving the FIRST version
  // red is the whole case: the bytes the step runs, commits and hashes are the
  // ones it captured, not the ones the child left on disk.
  const submitted = [
    "#!/bin/sh",
    'echo "not ok - tests/AC1-rewrite.test.sh" 1>&2',
    "exit 1",
    "",
  ].join("\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 13,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      mkdirSync(path.join(wt, "tests"), { recursive: true });
      const file = path.join(wt, "tests/AC1-rewrite.test.sh");
      writeFileSync(file, submitted, { mode: 0o755 });
    },
    toolUses: () => [submit("AC1", ["tests/AC1-rewrite.test.sh"])],
    // The child changes its mind in the window between the step reading the
    // submitted bytes and it resetting the tree: it makes the file green. That
    // write must not reach the commit or the hash — the step proved, committed
    // and hashed the bytes it had already taken.
    afterCapture: (wt) => {
      writeFileSync(path.join(wt, "tests/AC1-rewrite.test.sh"), "#!/bin/sh\necho green\nexit 0\n", {
        mode: 0o755,
      });
    },
  });
  assert(r.threw === undefined, `(m) no throw: ${r.threw?.message ?? "clean"}`);
  assert(
    r.outcome?.kind === "ok",
    `(m) the CAPTURED bytes were proved red, got ${r.outcome?.kind}`,
  );
  const frozen = r.outcome?.frozen?.["tests/AC1-rewrite.test.sh"];
  assert(
    frozen === sha(submitted),
    `(m) frozen is the sha256 of the captured bytes (got ${frozen}, want ${sha(submitted)})`,
  );
  const committed = `${git(r.worktree, "show", "HEAD:tests/AC1-rewrite.test.sh")}\n`;
  assert(
    committed === submitted,
    `(m) the committed blob is the captured content, not the rewrite (got ${JSON.stringify(committed.slice(0, 40))})`,
  );
  assert(frozen === sha(committed), "(m) the hash equals the hash of `git show HEAD:<path>`");
  assert(
    git(r.worktree, "status", "--porcelain", "-uall") === "",
    "(m) and the worktree is clean, with only the captured test in it",
  );
  assert(
    git(r.worktree, "show", "--name-only", "--format=", "HEAD") === "tests/AC1-rewrite.test.sh",
    `(m) the commit contains exactly the captured test (got ${git(r.worktree, "show", "--name-only", "--format=", "HEAD")})`,
  );
}

// ------------------------ (n) a foreign directory at the lean path is not touched
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const wt = path.join(repoRoot, ".worktrees", "lean-14");
  mkdirSync(path.join(wt, "someone-elses-project"), { recursive: true });
  writeFileSync(path.join(wt, "someone-elses-project", "keep.ts"), "PRECIOUS\n");
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 14,
    config: configWith({ test: RUNNER }),
    writes: () => {},
    toolUses: [submit("AC1", ["tests/AC1-retry.test.sh"])],
  });
  assert(
    r.threw instanceof SpecifyInfraError,
    `(n) a foreign directory at the lean path THROWS — got ${
      r.threw === undefined ? `outcome ${r.outcome?.kind}` : r.threw.constructor.name
    }`,
  );
  assert(
    r.threw === undefined || /not a worktree|does not own/.test(r.threw.message),
    `(n) the throw says the tree is not this step's (got ${r.threw?.message})`,
  );
  assert(
    existsSync(path.join(wt, "someone-elses-project", "keep.ts")) &&
      existsSync(path.join(wt, "someone-elses-project", "keep.ts")),
    "(n) the foreign content is untouched",
  );
  assert(r.dispatched === 0, `(n) and no adversary was spent (got ${r.dispatched})`);
}

// ------------------------ (o) shell-shaped and placeholder-less templates refused
{
  const refused: Array<[string, string]> = [
    ['sh -c "x {file}"', "shell"],
    ["rm {file}; ls", "shell"],
    ["echo no placeholder here", "{file}"],
    ["bun run test-{file}.ts", "whole word"],
    ["bun run {file} {file}", "exactly once"],
    ["cat {file} | head", "shell"],
    ["echo $(whoami) {file}", "shell"],
    ["git log --format='%s' {file}", "shell"],
  ];
  for (const [template, expect] of refused) {
    const reason = validateTestRunner(template) ?? "";
    assert(
      reason.includes(expect),
      `(o) refused ${JSON.stringify(template)} — names "${expect}" (got "${reason}")`,
    );
  }
  for (const ok of [
    "bun run {file}",
    "sh {file}",
    "node --test {file}",
    "bun x vitest run {file}",
  ]) {
    assert(validateTestRunner(ok) === undefined, `(o) accepted ${JSON.stringify(ok)}`);
  }
  assert(
    TEST_RUNNER_PLACEHOLDER === "{file}",
    "(o) the one placeholder constant carries the string",
  );
}

// ------------------- (r) a parent link cannot carry a test's bytes outside
{
  const { repoRoot, baseSha } = makeRepo({ "src/a.ts": "1\n" });
  const outside = outsideDir();
  const elsewhere = path.join(outside, "tests-target");
  mkdirSync(elsewhere, { recursive: true });
  // The child submits a path whose PARENT is a link to a directory OUTSIDE the
  // worktree, with the file living behind it — the shape whose bytes would land
  // outside while `git status` stayed clean, because that file is not in this
  // worktree. It is refused twice over: `fileProblem` at validation (its
  // `realpath` leaves the tree) and `writeCaptured` at the rewrite. What
  // matters is the outcome — nothing of the step's reaches the outside
  // directory and no commit is made.
  const submitted = redScript();
  const r = await runSpecify({
    repoRoot,
    baseSha,
    issue: 17,
    config: configWith({ test: RUNNER }),
    writes: (wt) => {
      symlinkSync(elsewhere, path.join(wt, "linked"));
      // The fixture's own placement of the file the child "wrote": it lives
      // behind the link, which is the whole point of the case.
      writeFileSync(path.join(elsewhere, "AC1-escape.test.sh"), submitted, { mode: 0o755 });
    },
    toolUses: [submit("AC1", ["linked/AC1-escape.test.sh"])],
  });
  assert(
    (r.outcome?.reason ?? "").includes("resolves outside the worktree"),
    `(r) validation refused the row by name (got ${r.outcome?.reason})`,
  );
  assert(
    r.outcome?.frozen === undefined || Object.keys(r.outcome.frozen).length === 0,
    "(r) nothing from behind the link was frozen",
  );
  assert(
    readFileSync(path.join(elsewhere, "AC1-escape.test.sh"), "utf8") === submitted,
    "(r) the rewrite wrote nothing to the outside file — it still holds only what the fixture put there",
  );
  assert(
    r.outcome?.kind === "no-red-test" || r.threw !== undefined,
    `(r) the escape was refused — verdict or throw, never a commit (got ${
      r.threw === undefined ? `outcome ${r.outcome?.kind}` : "throw"
    })`,
  );
  assert(git(r.worktree, "rev-parse", "HEAD") === baseSha, "(r) nothing was committed");
}

for (const dir of ROOTS) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS reaps tmpdir */
  }
}

process.exit(exit);
