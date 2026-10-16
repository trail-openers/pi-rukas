/**
 * The `PI_ENSEMBLE_*` names the sandbox wrapper reads (#1369): every
 * `$PI_ENSEMBLE_X` / `${PI_ENSEMBLE_X…}` expansion on a non-comment line of
 * `bin/*` and the image entrypoint. A name the wrapper only sets
 * (`-e PI_ENSEMBLE_X=…`) or matches (`PI_ENSEMBLE_*)`) is not a read. Not a
 * test itself (no `test-` prefix, so the gate glob does not run it).
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/** The wrapper sources, relative to the repo root. */
export function wrapperSources(root: string = REPO_ROOT): string[] {
  const bin = readdirSync(path.join(root, "bin")).map((f) => path.join("bin", f));
  return [...bin, path.join(".devcontainer", "entrypoint.sh")];
}

const READ = /\$\{?(PI_ENSEMBLE_[A-Z0-9_]+)/g;

/** Names expanded in `text`, → `rel`, added to `out` (first file wins). */
export function scanShell(text: string, rel: string, out: Map<string, string>): void {
  for (const line of text.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(READ)) {
      const name = m[1] as string;
      if (!out.has(name)) out.set(name, rel);
    }
  }
}

/** Every `PI_ENSEMBLE_*` name the wrapper sources read, → one file reading it. */
export function wrapperEnvReads(root: string = REPO_ROOT): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of wrapperSources(root)) {
    scanShell(readFileSync(path.join(root, rel), "utf8"), rel, out);
  }
  return out;
}
