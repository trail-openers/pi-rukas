/**
 * Shared harness for the #1381 citation-unit smoke tests, which are split
 * across two files to stay under the repo's file-size cap. Both run the same
 * assertions against the same real `AGENTS.md`, and both report through this.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface Runner {
  assert(cond: boolean, msg: string): void;
  /** Non-zero if any assertion failed; the caller exits with it. */
  readonly exit: number;
}

export function createRunner(): Runner {
  let failed = 0;
  return {
    assert(cond: boolean, msg: string): void {
      if (cond) console.log(`✓ ${msg}`);
      else {
        console.error(`✗ ${msg}`);
        failed = 1;
      }
    },
    get exit() {
      return failed;
    },
  };
}

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
export const AGENTS = readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

/**
 * Read from disk, not duplicated: a fixture copied from the file can drift.
 * `undefined` here would silently turn every §9 assertion into a pass over
 * nothing, so the caller locates it with an assert of its own before use.
 */
export function grantLineFrom(agents: string): string | undefined {
  return agents.split("\n").find((l) => l.startsWith("If all project quality gates have been met"));
}
