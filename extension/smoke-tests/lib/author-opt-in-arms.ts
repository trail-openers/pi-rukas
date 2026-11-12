#!/usr/bin/env bun
/**
 * #2181 A7 — the arms behind the opt-in half of the merge-author gate.
 *
 * The gate is **opt-in per repository**: a repository that has never committed the
 * gate file has never named anyone, and the author rule is simply not applied
 * there — lean and `/work` run in repositories other than this one (including
 * seeded trial repos), and an allowlist that opted out by default would refuse
 * every landing in them. A file that DOES exist is judged fail-closed: a tree, a
 * symlink, an unreadable blob, or a file that names nobody all refuse, as does an
 * author the forge never reported.
 *
 * The arms are here rather than in the test so both decision suites — the shared
 * gate and lean's `land` step — drive ONE table and cannot drift on what each arm
 * is supposed to answer. The gate file's path is assembled from parts so importing
 * this module never puts the gate file's name in a file-size or text scan as one
 * token (the same discipline the fixtures already keep).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAuthorTreeLine } from "../../src/merge-author-allowlist.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** The gate file's path, assembled. */
export const GATE_FILE = [".pi", "merge-authors"].join("/");

/** The allowlist body an arm answers with when it does not name one. */
export const ARMS_ALLOWED = "alice\nBob\n";

/**
 * One arm of the opt-in table. Exactly one of the shapes is set; the rest answer
 * the happy path, so an arm says only what it changes.
 */
export type OptInArm = {
  /** `cat-file -t` answers this instead of `blob` (a directory, a symlink). */
  type?: string;
  /**
   * The tree entry's MODE, which is what `git ls-tree` reports and what actually
   * distinguishes a committed symlink (`120000`) from a regular file (`100644`). The
   * default `"100644"` is the regular file every happy-path arm wants. `type` is the
   * OLD knob and no longer decides a symlink on its own — a committed link is a `blob`
   * to `cat-file -t`, so an arm that means a link names `mode: "120000"`.
   */
  mode?: string;
  /** The path is not in the commit at all — git's own failure for that shape. */
  absent?: boolean;
  /** The blob exists but the bytes cannot be read. */
  showThrows?: boolean;
  /** The bytes the blob answers with (default: the two logins above). */
  body?: string;
};

/**
 * The rejection a failing git child leaves behind, in the shape the classifiers read.
 *
 * `gitCatFileSaysAbsent` needs git's `stderr` and a real exit code, and a shim that
 * "fails the way git fails" by throwing a bare `Error` with the words in `message`
 * leaves it without either — so the arm that means an ABSENT path would read as a
 * wedge, and a repository that never opted in would be refused rather than opted
 * out. Both executors this gate runs under, `execp`'s argv form and lean's, are
 * `execFile`-backed and attach exactly these two fields, so a fixture that omits
 * them is testing a shape no production caller produces.
 */
export function gitFailure(message: string, code: number, stderr?: string): Error {
  const words = stderr ?? (message.endsWith("\n") ? message : `${message}\n`);
  return Object.assign(new Error(message), { code, stderr: words });
}

/** A git executor answering like git, from an {@link OptInArm} table. */
export function optInExec(arm: OptInArm, calls: string[] = []) {
  const exec = async (_cmd: string, opts?: { argv?: string[] }): Promise<{ stdout: string }> => {
    const argv = opts?.argv ?? [];
    calls.push(argv.join(" "));
    // The tree read first: it carries the path as its own argv entry (git's argv
    // contract for `ls-tree <rev> -- <path>`), so it is recognised by its verb and not
    // by a spec this call does not contain. It answers a MODE line, never a type or the
    // bytes — and for an absent path it answers them EMPTY, which is git's honest "no
    // such entry" rather than a failure.
    if (argv.includes("ls-tree")) {
      if (arm.absent === true) return { stdout: "" };
      return { stdout: mergeAuthorTreeLine(arm.mode ?? "100644", GATE_FILE) };
    }
    if (argv.includes("cat-file")) {
      if (arm.absent === true)
        throw gitFailure("fatal: path does not exist in '<base>:<gate file>'", 128);
      return { stdout: `${arm.type ?? "blob"}\n` };
    }
    if (arm.showThrows === true) throw gitFailure("fatal: bad object", 128);
    return { stdout: arm.body ?? ARMS_ALLOWED };
  };
  return { exec, calls };
}

/** A real throwaway clone, with or without the gate file at its base commit. */
export function repoWithOptionalGateFile(opts: {
  /** `undefined` — the repository never opted in; a string is the file's bytes. */
  allowlist?: string;
  /** Write the file as a symlink instead of a blob (the A7 symlink arm). */
  symlinkTo?: string;
}): { repoRoot: string; dispose: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), "author-optin-"));
  const git = (...args: string[]) => {
    const child = spawnSync("git", args, { cwd: repoRoot, env: gitTestEnv() });
    if (child.status !== 0) {
      const words = child.stderr?.toString() ?? "";
      // Same shape as `gitFailure`: git's verdict on `stderr` with its exit code.
      throw Object.assign(new Error(`git ${args.join(" ")}: ${words.slice(0, 200)}`), {
        code: child.status,
        stderr: words,
      });
    }
    return child.stdout.toString().trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "opt-in@test.invalid");
  git("config", "user.name", "Author opt-in test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(join(repoRoot, "README.md"), "# opt-in fixture repo\n");
  if (opts.symlinkTo !== undefined) {
    symlinkSync(opts.symlinkTo, join(repoRoot, GATE_FILE));
  } else if (opts.allowlist !== undefined) {
    writeFileSync(join(repoRoot, GATE_FILE), opts.allowlist);
  }
  git("add", "-A");
  git("commit", "-m", "chore: base");
  return {
    repoRoot,
    /** The commit the file is (or is not) in — what a cycle records as its base. */
    baseSha: git("rev-parse", "HEAD"),
    dispose: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}
