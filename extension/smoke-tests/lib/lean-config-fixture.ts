/**
 * lib/lean-config-fixture — the one-commit temp repo the `.pi/work.json` suites
 * share.
 *
 * Split out of `test-lean-config.ts` for the AGENTS.md §12 line gate, along the
 * seam that already existed there: the suite ASSERTS about a loaded config, this
 * builds the commit the loader reads it from. Every claim about `.pi/work.json`
 * is a git claim — "absent at that commit" and "present but modified in the
 * tree" are different facts a stub exec would answer from itself — so the repo
 * is real and the loader runs against `git show <baseSha>:.pi/work.json`.
 *
 * Nothing here asserts: a fixture that reported a verdict would be judging
 * someone else's config.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface ConfigRepo {
  repoRoot: string;
  /** The one commit's sha — the `baseSha` every config read is made against. */
  baseSha: string;
  cleanup: () => void;
}

/** A repo with one commit containing `.pi/` files, and the sha of that commit. */
export function makeRepo(files: Record<string, string>): ConfigRepo {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-config-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const g = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env }).trim();
  g("init", "-q", "-b", "main");
  mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(repoRoot, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const baseSha = g("rev-parse", "HEAD");
  return { repoRoot, baseSha, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) };
}

/** A `.pi/work.json` holding one `lean` block, as a project would commit it. */
export function leanWorkJson(lean: unknown): Record<string, string> {
  return { ".pi/work.json": JSON.stringify({ version: 1, lean }) };
}
