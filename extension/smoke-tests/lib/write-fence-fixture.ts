/**
 * Shared on-disk layout for the write-fence smoke tests (#1655).
 *
 *   repo/                       the main checkout (the repo root)
 *     bin/keep                  a file the fence must never let a child write
 *     node_modules/pkg/         a root dependency tree
 *     extension/node_modules/   a depth-1 dependency tree
 *     .worktrees/wt/            the fenced worktree, provisioned like worktree-provision.ts
 *       node_modules -> repo/node_modules       (a provisioned link)
 *       extension/node_modules -> repo/extension/node_modules
 *       out -> repo/bin                          (a symlink escape)
 *     .worktrees/wt2/           a worktree whose node_modules points at a tree NOT named node_modules
 *       lookalike/node_modules -> other/node_modules   (named like a dependency tree, but a sibling's)
 *     .worktrees/other/         a sibling worktree
 *       node_modules/pkg/        the sibling's dependency tree
 *   scratch/                    the cycle scratch dir
 *
 * The layout lives under the repo root's gitignored tmp/, NOT os.tmpdir(): the OS
 * temp dirs are always writable under the rule, so a fixture there would test
 * nothing about the fence.
 */

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Block for `ms` milliseconds. The path rule treats a dependency link older than
 * the fence's load time as provisioned, so a test that makes a link the child
 * "created" must let the clock move past the load first.
 */
export function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface FenceFixture {
  base: string;
  repo: string;
  wt: string;
  wt2: string;
  other: string;
  scratch: string;
}

export function buildFenceFixture(tag: string): FenceFixture {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const base = path.join(here, "..", "..", "..", "tmp", "issue-1655", `${tag}-${process.pid}`);
  rmSync(base, { recursive: true, force: true });
  // Removed on exit, pass or fail, so a run never leaves a tree behind. Named by pid, so runs cannot collide.
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  const wt = path.join(repo, ".worktrees", "wt");
  const wt2 = path.join(repo, ".worktrees", "wt2");
  const other = path.join(repo, ".worktrees", "other");
  const scratch = path.join(base, "scratch");
  for (const dir of [
    path.join(repo, "bin"),
    path.join(repo, "node_modules", "pkg"),
    path.join(repo, "extension", "node_modules", "pkg"),
    path.join(wt, "src"),
    path.join(wt, "extension"),
    path.join(wt2, "src"),
    other,
    scratch,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(repo, "bin", "keep"), "keep\n");
  writeFileSync(path.join(repo, "node_modules", "pkg", "x.js"), "x\n");
  symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"), "dir");
  symlinkSync(
    path.join(repo, "extension", "node_modules"),
    path.join(wt, "extension", "node_modules"),
    "dir",
  );
  symlinkSync(path.join(repo, "bin"), path.join(wt, "out"), "dir");
  symlinkSync(path.join(repo, "bin"), path.join(wt2, "node_modules"), "dir");
  // A look-alike: named `node_modules` and provisioned-looking, but it points at a SIBLING's tree, not the main checkout's.
  mkdirSync(path.join(wt, "lookalike"), { recursive: true });
  mkdirSync(path.join(other, "node_modules", "pkg"), { recursive: true });
  symlinkSync(path.join(other, "node_modules"), path.join(wt, "lookalike", "node_modules"), "dir");
  // The provisioned links are older than any fence loaded over this fixture.
  pause(20);
  return { base, repo, wt, wt2, other, scratch };
}
