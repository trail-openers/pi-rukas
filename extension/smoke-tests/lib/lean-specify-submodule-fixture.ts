/**
 * lib/lean-specify-submodule-fixture — the submodule repos `specify`'s submodule
 * cases are driven over, and the test file the child writes inside one.
 *
 * Carved out of `test-lean-specify-submodule.ts` so the file holding the cases
 * stays under the size cap and this one holds the git recipes: what it takes to
 * put a real gitlink in a base commit, and what it takes to point that gitlink at
 * a source that will not clone. Both are the same concern — building the base the
 * reset under test has to recover — and none of it is a claim about the step.
 *
 * These build repos with the `specify` fixture's own `makeRepo`/`git`, so they sit
 * beside that fixture rather than in `lean-submodule-off-fixture.ts`, whose
 * builders serve the step fixtures (`buildFixture`, `challengeFixture`, the review
 * harness) and use their own git wrappers.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git, makeRepo } from "./lean-specify-fixture.ts";

/** The submodule's mount point, and the file committed inside it. */
export const SUB = "vendor/lib";
export const INSIDE = `${SUB}/lib`;

/**
 * Mount `url` as a submodule at `at`, from a LOCAL path.
 *
 * `protocol.file.allow` is `user` by default since the CVE that made git refuse
 * it, so a plain `submodule add <path>` fails with `transport 'file' not
 * allowed` — and the refusal is git's policy on a machine's configuration, not a
 * fact about the repository under test. The allowlist is passed per call, which
 * is what a human doing this locally does too; nothing about the step's own
 * behaviour depends on it, because the step never adds a submodule: it only
 * populates one the base already carries.
 */
export function addSubmodule(dir: string, url: string, at: string): void {
  git(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "--force", url, at);
}

/** A standalone repo to mount as a submodule, with one committed file. */
export function submoduleRemote(): { repoRoot: string; head: string } {
  const { repoRoot, baseSha } = makeRepo({ lib: "the submodule's content\n" });
  return { repoRoot, head: baseSha };
}

/**
 * A repo whose base commit carries a real submodule at `vendor/lib`.
 *
 * Built the way a human would: add the submodule from a local path, then commit
 * what git staged. `git submodule add` writes `.gitmodules` AND the gitlink, and
 * `git add` of the directory is what makes the gitlink part of the base tree —
 * without that commit the worktree would hold an untracked directory, which is a
 * different problem than the one being pinned here.
 *
 * `url` points the recorded source somewhere that is not there and un-populates
 * what `submodule add` checked out, so the base describes a submodule obtainable
 * only by a clone that will fail.
 */
export function repoWithSubmodule(
  url?: string,
  from?: string,
): { repoRoot: string; baseSha: string } {
  const remote = from ?? makeRepo({ lib: "the submodule's own content\n" }).repoRoot;
  const { repoRoot } = makeRepo({ "src/retry.ts": "export const retry = () => {};\n" });
  addSubmodule(repoRoot, remote, SUB);
  if (url !== undefined) {
    const gitmodules = path.join(repoRoot, ".gitmodules");
    writeFileSync(gitmodules, readFileSync(gitmodules, "utf8").replace(/url = .*/, `url = ${url}`));
    rmSync(path.join(repoRoot, SUB), { recursive: true, force: true });
  }
  git(repoRoot, "add", "-A");
  git(
    repoRoot,
    "commit",
    "-q",
    "-m",
    url === undefined
      ? "add the vendored submodule"
      : "point the submodule at a source that is not there",
  );
  return { repoRoot, baseSha: git(repoRoot, "rev-parse", "HEAD") };
}

/** The child writes a test that reads the submodule's file, and declares it. */
export function writeSubmoduleTest(wt: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  // The read is the point: an empty submodule directory makes this file fail
  // before it asserts anything, which is the collection error the preflight
  // turns into infrastructure.
  const body = [
    "#!/bin/sh",
    `if [ ! -f ${INSIDE} ]; then`,
    `  echo "cannot import ${SUB}: the submodule is empty" 1>&2`,
    "  exit 4",
    "fi",
    // The proof's own rule: a non-zero exit counts only when the output named
    // the file, so the script reports its own path — and not the submodule's
    // name, which would let the red be credited for the wrong reason.
    'echo "not ok - $0" 1>&2',
    'echo "assertion failed: retry gave up on the first transient failure" 1>&2',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(path.join(wt, "tests/AC1-submodule.test.sh"), body, { mode: 0o755 });
}
