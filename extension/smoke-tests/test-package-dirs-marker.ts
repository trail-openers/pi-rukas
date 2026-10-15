/**
 * #1226 — `packageDirsAt` returns only the depth-1 directories
 * that carry a dependency manifest or lockfile. The marker check used
 * `.some(fileExists)`: `fileExists` returns a Promise, a Promise is always
 * truthy, and every top-level directory therefore counted as a package dir.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageDirsAt } from "../src/worktree-provision-hook.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "package-dirs-"));
try {
  mkdirSync(path.join(root, "app"));
  writeFileSync(path.join(root, "app", "package.json"), '{"name":"app"}\n');
  mkdirSync(path.join(root, "crate"));
  writeFileSync(path.join(root, "crate", "Cargo.toml"), "[package]\n");
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs", "index.md"), "# docs\n");
  mkdirSync(path.join(root, "scratch", "node_modules", "x"), { recursive: true });
  mkdirSync(path.join(root, ".hidden"));
  writeFileSync(path.join(root, ".hidden", "package.json"), "{}\n");

  const dirs = (await packageDirsAt(root)).sort();
  assert(dirs.includes("app"), "a directory with package.json is a package dir");
  assert(dirs.includes("crate"), "a directory with Cargo.toml is a package dir");
  assert(!dirs.includes("docs"), "a directory with no manifest is NOT a package dir");
  assert(
    !dirs.includes("scratch"),
    "a directory holding only a node_modules (no manifest) is NOT a package dir",
  );
  assert(!dirs.includes(".hidden"), "dot directories stay excluded");
  assert(dirs.length === 2, `exactly the two manifest-bearing directories (got: ${dirs.join(", ")})`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
