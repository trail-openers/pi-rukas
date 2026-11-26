/**
 * lib/verify-select-fixture-tree — the temporary tree the real-tree select suites plant.
 *
 * `test-verify-select-real-tree.ts` asserts the selector's answers on THIS repository;
 * `test-verify-select-real-tree-fixture.ts` asserts the same selector on a tree it builds
 * itself, because the shapes that gate owns — a module with no test, a nested template
 * that must lex, and a mutant that must be named — only exist where a fixture puts them.
 * Both halves plant that tree the same way, so the planting lives here once rather than
 * twice: a scratch root, one `put` that makes the parent directory and writes the file,
 * and the cleanup that removes the root whatever the assertions did.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureTree {
  /** The scratch root; the tree the selector is called with is `extension` below it. */
  root: string;
  /** The directory passed to `selectVerifyTests`, mirroring a real `extension/` checkout. */
  extensionDir: string;
  /** Write one file of the tree, creating its directory. */
  put: (rel: string, text: string) => void;
  /** Absolute path of one file of the tree, for a read the assertion makes directly. */
  file: (rel: string) => string;
  /** Remove one file of the tree, so the next selection sees the tree without it. */
  remove: (rel: string) => void;
  /** Drop the whole scratch root. */
  dispose: () => void;
}

/** Create one scratch tree. The caller owns `dispose`, normally in a `finally`. */
export function createFixtureTree(prefix = "pi-verify-select-tree-"): FixtureTree {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const extensionDir = path.join(root, "extension");
  return {
    root,
    extensionDir,
    put: (rel, text) => {
      const file = path.join(extensionDir, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, "utf8");
    },
    file: (rel) => path.join(extensionDir, rel),
    remove: (rel) => rmSync(path.join(extensionDir, rel), { force: true }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
