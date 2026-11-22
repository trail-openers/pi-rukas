#!/usr/bin/env bun
/**
 * The project roster with a runner that is not pytest.
 *
 *   (a) a derived roster for a non-pytest `verify.test` is refused at `ready`, naming
 *       `verify.roster` and `{report}`, instead of handing back at every verify after build;
 *       a pytest `verify.test`, an explicit `verify.roster` and the roster's off arm all start;
 *   (b) the base version of an edited test runs at the file's OWN path, so a runner that only
 *       runs a file where it lives (a cargo wrapper, pytest's conftest) gets no false red, and
 *       the head copy — bytes, mode and mtime — is back afterwards with the tree clean.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { readyOutcome } from "../src/lean/command.ts";
import { defaultConfig } from "../src/lean/config.ts";
import { rosterStartProblem } from "../src/lean/verify-roster-command.ts";
import { runEditedBaseVersions } from "../src/lean/verify-roster-edited.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { BODY } from "./lib/lean-seed-fixtures.ts";

const { assert, failures } = makeAssert();

function git(dir: string, ...args: string[]): string {
  const env = { ...gitTestEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t" };
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// ── (a) the rule, then the refusal through `ready`.
for (const test of [
  "pytest -q {file}",
  "python3 -m pytest {file}",
  "uv run pytest {file}",
  ".venv/bin/py.test {file}",
])
  assert(rosterStartProblem({ test }) === undefined, `(a) ${test} starts`);
for (const test of ["cargo test {file}", "sh runner.sh {file}", "scripts/pytest.sh {file}"]) {
  const said = rosterStartProblem({ test }) ?? "";
  assert(
    said.includes("set verify.roster to write one to {report}") &&
      said.includes("PI_ENSEMBLE_LEAN_PROJECT_ROSTER=0"),
    `(a) ${test} is refused naming verify.roster and {report} (${said})`,
  );
}
assert(
  rosterStartProblem({ test: "cargo test {file}", roster: "sh roster.sh {report}" }) === undefined,
  "(a) an explicit verify.roster starts whatever verify.test is",
);
await withEnv({ PI_ENSEMBLE_LEAN_PROJECT_ROSTER: "0" }, async () => {
  assert(
    rosterStartProblem({ test: "cargo test {file}" }) === undefined,
    "(a) the roster's off arm asks nothing",
  );
});

const repo = tempDir();
try {
  git(repo.dir, "init", "-q");
  writeFileSync(path.join(repo.dir, "README"), "x\n");
  git(repo.dir, "add", ".");
  git(repo.dir, "commit", "-qm", "base");
  const baseSha = git(repo.dir, "rev-parse", "HEAD");
  const ready = (test: string) =>
    readyOutcome(
      repo.dir,
      2495,
      { baseSha },
      {
        fetchBody: async () => BODY,
        issueTitle: async () => "t",
        loadConfig: async () => ({ ...defaultConfig(), verify: { test } }),
        dispatch: async () => {
          throw new Error("no child in this case");
        },
        mainlineWhy: async () => undefined,
        post: async () => {},
      },
    );
  const refused = await ready("cargo test {file}");
  const rule = refused.facts.failedRules.join(" ");
  assert(
    refused.kind === "fail" && rule.includes("set verify.roster to write one to {report}"),
    `(a) ready refuses the run at its start (${refused.kind}: ${rule})`,
  );
  const started = await ready("pytest -q {file}");
  assert(started.kind === "ok", `(a) ready starts a pytest run (${started.kind})`);

  // ── (b) the base bytes pass only where the file lives; the head bytes are the run's edit.
  const rel = "tests/t.sh";
  const abs = path.join(repo.dir, rel);
  mkdirSync(path.dirname(abs));
  writeFileSync(abs, 'case "$0" in tests/*) exit 0 ;; esac\necho "not ok - $0"\nexit 1\n');
  git(repo.dir, "add", ".");
  git(repo.dir, "commit", "-qm", "test at base");
  const testBase = git(repo.dir, "rev-parse", "HEAD");
  const head = "#!/bin/sh\n# the run's edit\nexit 0\n";
  writeFileSync(abs, head);
  chmodSync(abs, 0o755);
  git(repo.dir, "commit", "-qam", "edit");
  utimesSync(abs, new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  const run = () =>
    runEditedBaseVersions({
      exec: execp,
      repoRoot: repo.dir,
      wt: repo.dir,
      baseSha: testBase,
      template: "sh {file}",
      timeoutMs: 30_000,
      edited: [rel],
    });
  const edited = await run();
  assert(
    edited.ok && edited.redFiles.length === 0 && edited.editedFiles.includes(rel),
    `(b) the base version runs at its own path and passes (${JSON.stringify(edited)})`,
  );
  const st = statSync(abs);
  assert(readFileSync(abs, "utf8") === head, "(b) the head bytes are back");
  assert(
    (st.mode & 0o777) === 0o755,
    `(b) the head mode is back (${(st.mode & 0o777).toString(8)})`,
  );
  assert(st.mtimeMs === 1_600_000_000_000, `(b) the head mtime is back (${st.mtimeMs})`);
  assert(git(repo.dir, "status", "--porcelain") === "", "(b) the tree is clean afterwards");
  git(repo.dir, "rm", "-q", rel);
  git(repo.dir, "commit", "-qm", "delete");
  const deleted = await run();
  assert(
    deleted.ok && deleted.redFiles.length === 0 && !existsSync(abs),
    `(b) a file the run deleted is run at its path and removed again (${JSON.stringify(deleted)})`,
  );
  assert(git(repo.dir, "status", "--porcelain") === "", "(b) the tree is clean after a deletion");
} finally {
  repo.cleanup();
}

process.exit(failures());
