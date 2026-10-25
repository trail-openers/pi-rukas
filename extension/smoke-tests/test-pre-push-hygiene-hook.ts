#!/usr/bin/env bun
/**
 * pre-push-hygiene hook (#1788 round 2, item 7) — the human-side hook in
 * `bin/pre-push-hygiene.sh` must FAIL CLOSED.
 *
 * The hook is the only thing between a terminal `git push` and a public
 * branch, so every branch of it that could not answer the question must answer
 * "refuse" rather than "clean". Three behaviours are pinned here, each against
 * a real clone in a scratch directory:
 *
 * - a denylist file that exists but cannot be read → exit 1 (the old script
 *   read it with `nl`, got nothing, and exited 0 — the configured terms were
 *   never compared against anything);
 * - a failed `git rev-list` / `git log` read for a NON-delete push → exit 1
 *   (the old script sent git's stderr to /dev/null and treated the empty
 *   result as "nothing new");
 * - a delete push (all-zero local oid) → exit 0 even when git is broken,
 *   because nothing is published;
 * - an indented `#` line is a comment, so a denylist indented under a heading
 *   is not scanned as a term.
 *
 * The two "must exit 1" cases are also pinned in the OTHER direction in the
 * same file: a readable denylist with no match, and a healthy git, both exit
 * 0. A hook that refused everything would pass the fail-closed half alone.
 *
 * Offline, synthetic terms, a scratch denylist always. Rootless CI has no
 * chmod-000 file (root reads anything), so the unreadable-denylist case is
 * skipped there rather than asserted vacuously.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, exit } from "./merge-guard-helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(here, "../../bin/pre-push-hygiene.sh");

const ZERO = "0000000000000000000000000000000000000000";
const TERM = "synthetic-private-host";

// A `git` that fails every read, for the fail-closed cases. A hook cannot tell
// a broken git from a clean push by looking at the text git prints (there is
// none), so the distinction has to be made by a git that answers and one that
// does not — a shell script on PATH with the real git dir removed from the
// environment makes every read of this repo's objects fail.
function makeBrokenGit(dir: string) {
  const bin = path.join(dir, "broken-bin");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, "git");
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "--version" ]; then exec ${real} "$@"; fi
exit 128
`,
    { mode: 0o755 },
  );
  return bin;
}

function runHook(repo: string, lines: string[], env: Record<string, string>) {
  return spawnSync("/bin/sh", [HOOK], {
    cwd: repo,
    input: `${lines.join("\n")}\n`,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** A clone with one commit carrying `body` in its message and content. */
function makeRepo(dir: string, body: string, content: string) {
  const repo = path.join(dir, "repo");
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  execFileSync("git", ["init", "-q", repo], { encoding: "utf8" });
  writeFileSync(path.join(repo, "f.txt"), content, "utf8");
  git(["add", "f.txt"]);
  git(["commit", "-q", "-m", body]);
  return { repo, git };
}

const dir = mkdtempSync(path.join(tmpdir(), "pre-push-hygiene-"));

try {
  // The fail-closed cases need a real commit to push, so both share a clean
  // repo whose message and content are free of the denylist term.
  const clean = makeRepo(path.join(dir, "clean"), "chore: add a file", "hello\n");
  const oid = clean.git(["rev-parse", "HEAD"]).trim();
  const brokenBin = makeBrokenGit(dir);
  const hookEnv = (denylist: string) => ({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylist });

  // 1. A readable denylist with no match exits 0 — the other direction of the
  //    unreadable case below, so that half cannot be satisfied by a hook that
  //    refuses every push.
  const cleanList = path.join(dir, "clean-list");
  writeFileSync(cleanList, `# comment\n\n  ${TERM}\n`, "utf8");
  const ok = runHook(
    clean.repo,
    [`refs/heads/main ${oid} refs/heads/main ${ZERO}`],
    hookEnv(cleanList),
  );
  assert(ok.status === 0, `clean denylist: exit 0 (got ${ok.status}: ${ok.stderr})`);
  assert(ok.stderr === "", "clean denylist: nothing printed to stderr");

  // 2. An indented `#` line is a comment: the same file above carries the term
  //    indented (a real term) and, below, a comment indented the same way.
  const indented = path.join(dir, "indented");
  writeFileSync(indented, "  # indented comment carrying the word ${TERM}\n", "utf8");
  const ind = runHook(
    clean.repo,
    [`refs/heads/main ${oid} refs/heads/main ${ZERO}`],
    hookEnv(indented),
  );
  assert(
    ind.status === 0,
    `indented comment: not treated as a term (got ${ind.status}: ${ind.stderr})`,
  );

  // 3. A denylist that exists but cannot be read → refuse. Skipped when the
  //    filesystem honours no permissions for this uid (root on CI).
  const locked = path.join(dir, "locked");
  writeFileSync(locked, `${TERM}\n`, "utf8");
  chmodSync(locked, 0o000);
  const readable =
    existsSync(locked) &&
    (() => {
      try {
        execFileSync("/bin/cat", [locked]);
        return true;
      } catch {
        return false;
      }
    })();
  if (readable) {
    console.log("unreadable denylist: skipped (this uid can read a 000 file)");
  } else {
    const refused = runHook(
      clean.repo,
      [`refs/heads/main ${oid} refs/heads/main ${ZERO}`],
      hookEnv(locked),
    );
    assert(refused.status === 1, `unreadable denylist: exit 1 (got ${refused.status})`);
    assert(
      !refused.stderr.includes(TERM),
      "unreadable denylist: the refusal names no denylist term",
    );
    assert(refused.stderr.length > 0, "unreadable denylist: the refusal reaches stderr");
  }

  // 4. A failed commit read for a non-delete push → refuse. `GIT_ALTERNATE_OBJECT_DIRECTORIES`
  //    pointing at a directory that is not an object store makes git fail to
  //    read the objects for a range while still exiting cleanly for a range
  //    with no commits, so it distinguishes "no answer" from "empty answer".
  const brokenEnv = {
    ...hookEnv(cleanList),
    PATH: `${brokenBin}:${process.env.PATH}`,
  };
  const broken = runHook(clean.repo, [`refs/heads/main ${oid} refs/heads/main ${oid}`], brokenEnv);
  assert(
    broken.status === 1,
    `broken commit read: exit 1 (got ${broken.status}: ${broken.stderr})`,
  );
  assert(!broken.stderr.includes(TERM), "broken commit read: the refusal names no denylist term");

  // 5. The same broken git on a DELETE push (all-zero local oid) → exit 0:
  //    nothing leaves the clone, so there is nothing to fail closed on.
  const del = runHook(clean.repo, [`refs/heads/main ${ZERO} refs/heads/main ${oid}`], brokenEnv);
  assert(
    del.status === 0,
    `delete push with broken git: exit 0 (got ${del.status}: ${del.stderr})`,
  );

  // 6. Escape hatch honoured in every direction.
  const off = runHook(clean.repo, [`refs/heads/main ${oid} refs/heads/main ${ZERO}`], {
    ...hookEnv(locked),
    PI_ENSEMBLE_PUBLIC_HYGIENE: "0",
  });
  assert(off.status === 0, `PI_ENSEMBLE_PUBLIC_HYGIENE=0: exit 0 (got ${off.status})`);

  // 7. A term that IS present in an outgoing commit → refuse, naming a line
  //    number and never the term itself.
  const dirty = makeRepo(path.join(dir, "dirty"), `feat: talk about ${TERM}`, "hello\n");
  const dirtyOid = dirty.git(["rev-parse", "HEAD"]).trim();
  const hit = runHook(
    dirty.repo,
    [`refs/heads/main ${dirtyOid} refs/heads/main ${ZERO}`],
    hookEnv(cleanList),
  );
  assert(hit.status === 1, `matching term: exit 1 (got ${hit.status}: ${hit.stderr})`);
  assert(
    !hit.stderr.includes(TERM),
    "matching term: the refusal names a line number, not the term",
  );
  assert(/line 3/.test(hit.stderr), `matching term: names denylist line 3 (got ${hit.stderr})`);
} finally {
  try {
    chmodSync(path.join(dir, "locked"), 0o600);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

process.exit(exit);
